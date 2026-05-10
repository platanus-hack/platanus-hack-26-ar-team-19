import { Router, type Router as RouterType } from "express";
import prisma from "@repo/db";
import { log } from "@repo/logger";
import { requireAuth, type AuthUser } from "../auth";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const paymentsRouter: RouterType = Router();

const mpDev = process.env.MP_DEV === "true";
const mpAccessToken = mpDev
  ? (process.env.MP_ACCESS_TOKEN_TEST ?? "")
  : (process.env.MP_ACCESS_TOKEN_PROD ?? "");
const mpAppId = process.env.MP_APP_ID ?? "";
const mpClientSecret = process.env.MP_CLIENT_SECRET ?? "";
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const apiPublicUrl = process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const MP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function getMpClient() {
  return new MercadoPagoConfig({ accessToken: mpAccessToken });
}

function generateVerificationCode(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function stateSecret(): string {
  return process.env.MP_OAUTH_STATE_SECRET || mpClientSecret || mpAccessToken;
}

function signState(payload: string): string {
  return createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

function createMpOAuthState(userId: string): string {
  const payload = Buffer.from(JSON.stringify({
    userId,
    ts: Date.now(),
    nonce: randomBytes(16).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${signState(payload)}`;
}

function verifyMpOAuthState(state: string): string | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !stateSecret()) return null;

  const expected = signState(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: unknown;
      ts?: unknown;
    };
    if (typeof parsed.userId !== "string" || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts > MP_OAUTH_STATE_TTL_MS) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

// --- Checkout Pro preference (manual payment fallback) ---

export async function createPaymentPreference(negotiationId: string) {
  if (!mpAccessToken) throw new Error("MP_ACCESS_TOKEN not configured");

  const neg = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
    include: { product: { select: { id: true, title: true, imageUrl: true } } },
  });
  if (!neg || neg.finalPrice == null) throw new Error("Invalid negotiation");

  const client = getMpClient();
  const preference = new Preference(client);
  const verificationCode = generateVerificationCode();

  const result = await preference.create({
    body: {
      items: [
        {
          id: neg.product.id,
          title: neg.product.title.slice(0, 256),
          quantity: 1,
          unit_price: neg.finalPrice,
          currency_id: "ARS",
          ...(neg.product.imageUrl ? { picture_url: neg.product.imageUrl } : {}),
        },
      ],
      external_reference: neg.id,
      back_urls: {
        success: `${webOrigin}/payment/success`,
        failure: `${webOrigin}/payment/failure`,
        pending: `${webOrigin}/payment/pending`,
      },
      auto_return: "approved",
      notification_url: `${apiPublicUrl}/payments/webhook`,
      binary_mode: true,
    },
  });

  const payUrl = mpDev ? result.sandbox_init_point : result.init_point;

  await prisma.negotiation.update({
    where: { id: negotiationId },
    data: { mpPreferenceId: result.id, paymentStatus: "pending", verificationCode },
  });

  return { preferenceId: result.id, payUrl, verificationCode };
}

// POST /payments/create-preference — buyer requests payment link
paymentsRouter.post("/create-preference", requireAuth, async (req, res) => {
  const user = res.locals.user as AuthUser;
  const { negotiationId } = req.body;
  if (!negotiationId) return res.status(400).json({ error: "negotiationId is required" });

  const neg = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
    include: { search: { select: { buyerId: true } } },
  });
  if (!neg) return res.status(404).json({ error: "negotiation_not_found" });
  if (neg.search.buyerId !== user.id) return res.status(403).json({ error: "not_the_buyer" });
  if (neg.status !== "awaiting_buyer") return res.status(409).json({ error: "not_awaiting_buyer" });

  try {
    const result = await createPaymentPreference(negotiationId);
    return res.json(result);
  } catch (err) {
    log("Create payment preference error:", (err as Error).message);
    return res.status(500).json({ error: "payment_unavailable" });
  }
});

// POST /payments/webhook — MercadoPago IPN
paymentsRouter.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const { type, data } = req.body ?? {};
  if (type !== "payment" || !data?.id) return;

  try {
    const client = getMpClient();
    const paymentApi = new Payment(client);
    const paymentData = await paymentApi.get({ id: data.id });
    if (!paymentData.external_reference) return;

    const negotiationId = paymentData.external_reference;

    if (paymentData.status === "approved") {
      const verificationCode = randomBytes(3).toString("hex").toUpperCase();
      await prisma.$transaction(async (tx) => {
        const neg = await tx.negotiation.findUnique({ where: { id: negotiationId } });
        if (!neg || (neg.status !== "awaiting_buyer" && neg.status !== "paying")) return;

        await tx.product.update({ where: { id: neg.productId }, data: { status: "sold" } });
        await tx.negotiation.update({
          where: { id: negotiationId },
          data: {
            status: "accepted",
            successful: true,
            completedAt: new Date(),
            mpPaymentId: String(data.id),
            paymentStatus: "approved",
            verificationCode,
          },
        });
      });
    } else if (paymentData.status === "rejected") {
      await prisma.negotiation.update({
        where: { id: negotiationId },
        data: { paymentStatus: "rejected" },
      });
    }
  } catch (err) {
    log("Webhook processing error:", (err as Error).message);
  }
});

// GET /payments/status/:negotiationId
paymentsRouter.get("/status/:negotiationId", requireAuth, async (req, res) => {
  const user = res.locals.user as AuthUser;
  const neg = await prisma.negotiation.findUnique({
    where: { id: req.params.negotiationId },
    include: { search: { select: { buyerId: true } } },
  });
  if (!neg) return res.status(404).json({ error: "not_found" });
  if (neg.search.buyerId !== user.id && neg.sellerId !== user.id) {
    return res.status(403).json({ error: "forbidden" });
  }
  return res.json({
    status: neg.status,
    successful: neg.successful,
    paymentStatus: neg.paymentStatus,
    verificationCode: neg.search.buyerId === user.id ? neg.verificationCode : null,
  });
});

// POST /payments/verify-code — seller verifies delivery
paymentsRouter.post("/verify-code", requireAuth, async (req, res) => {
  const user = res.locals.user as AuthUser;
  const { negotiationId, code } = req.body;
  const neg = await prisma.negotiation.findUnique({ where: { id: negotiationId } });
  if (!neg) return res.status(404).json({ error: "not_found" });
  if (neg.sellerId !== user.id) return res.status(403).json({ error: "not_the_seller" });
  if (!neg.successful) return res.status(409).json({ error: "not_completed" });

  if (neg.verificationCode !== code?.toUpperCase()) {
    return res.status(400).json({ error: "invalid_code" });
  }

  await prisma.negotiation.update({
    where: { id: negotiationId },
    data: { codeVerifiedAt: new Date() },
  });
  return res.json({ verified: true });
});

// POST /payments/auto-pay-settings
paymentsRouter.post("/auto-pay-settings", requireAuth, async (req, res) => {
  const user = res.locals.user as AuthUser;
  const { enabled, maxAmount, categories, maxPerSearch } = req.body;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      autoPayEnabled: enabled ?? false,
      autoPayMaxAmount: maxAmount ?? null,
      autoPayCategories: categories ?? [],
      autoPayMaxPerSearch: Math.min(Math.max(maxPerSearch ?? 1, 1), 5),
    },
  });
  return res.json({ ok: true });
});

// GET /payments/auto-pay-settings
paymentsRouter.get("/auto-pay-settings", requireAuth, async (req, res) => {
  const user = res.locals.user as AuthUser;
  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      autoPayEnabled: true,
      autoPayMaxAmount: true,
      autoPayCategories: true,
      autoPayMaxPerSearch: true,
      mpConnected: true,
    },
  });
  return res.json(u);
});

// --- MercadoPago OAuth ---

// GET /payments/mp/connect — returns MP authorization URL
paymentsRouter.get("/mp/connect", requireAuth, async (_req, res) => {
  const user = res.locals.user as AuthUser;
  if (!mpAppId) return res.status(500).json({ error: "MP_APP_ID not configured" });
  if (!stateSecret()) return res.status(500).json({ error: "MP OAuth state secret not configured" });

  const redirectUri = `${apiPublicUrl}/payments/mp/callback`;
  const state = createMpOAuthState(user.id);
  const authUrl =
    `https://auth.mercadopago.com.pe/authorization` +
    `?client_id=${mpAppId}` +
    `&response_type=code` +
    `&platform_id=mp` +
    `&state=${encodeURIComponent(state)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return res.json({ url: authUrl });
});

// GET /payments/mp/callback — MP redirects here after OAuth
paymentsRouter.get("/mp/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) return res.redirect(`${webOrigin}/onboarding?mp=error`);

  const userId = verifyMpOAuthState(state);
  if (!userId) return res.redirect(`${webOrigin}/onboarding?mp=error`);

  try {
    const tokenRes = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: mpAppId,
        client_secret: mpClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${apiPublicUrl}/payments/mp/callback`,
      }),
    });

    if (!tokenRes.ok) {
      log("MP OAuth token exchange failed");
      return res.redirect(`${webOrigin}/onboarding?mp=error`);
    }

    const data = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      public_key: string;
      user_id: number;
    };

    await prisma.user.update({
      where: { id: userId },
      data: {
        mpAccessToken: data.access_token,
        mpRefreshToken: data.refresh_token,
        mpPublicKey: data.public_key,
        mpUserId: String(data.user_id),
        mpConnected: true,
      },
    });

    return res.redirect(`${webOrigin}/onboarding?mp=ok`);
  } catch (err) {
    log("MP OAuth error:", (err as Error).message);
    return res.redirect(`${webOrigin}/onboarding?mp=error`);
  }
});

// POST /payments/mp/disconnect — disconnect MP account
paymentsRouter.post("/mp/disconnect", requireAuth, async (_req, res) => {
  const user = res.locals.user as AuthUser;
  await prisma.user.update({
    where: { id: user.id },
    data: {
      mpAccessToken: null,
      mpRefreshToken: null,
      mpPublicKey: null,
      mpUserId: null,
      mpConnected: false,
      mpCustomerId: null,
      mpCardId: null,
      mpCardLastFour: null,
    },
  });
  return res.json({ ok: true });
});

// --- Card tokenization & saving ---

// POST /payments/mp/save-card — save tokenized card to MP customer
paymentsRouter.post("/mp/save-card", requireAuth, async (req, res) => {
  const user = res.locals.user as AuthUser;
  const { cardToken } = req.body as { cardToken: string };
  if (!cardToken) return res.status(400).json({ error: "cardToken is required" });

  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!dbUser) return res.status(404).json({ error: "user_not_found" });

  try {
    let customerId = dbUser.mpCustomerId;

    if (!customerId) {
      const custRes = await fetch("https://api.mercadopago.com/v1/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mpAccessToken}` },
        body: JSON.stringify({ email: dbUser.email }),
      });

      if (!custRes.ok) {
        const searchRes = await fetch(
          `https://api.mercadopago.com/v1/customers/search?email=${encodeURIComponent(dbUser.email)}`,
          { headers: { Authorization: `Bearer ${mpAccessToken}` } },
        );
        const searchData = (await searchRes.json()) as { results: { id: string }[] };
        if (searchData.results?.[0]) {
          customerId = searchData.results[0].id;
        } else {
          return res.status(500).json({ error: "Failed to create MP customer" });
        }
      } else {
        const custData = (await custRes.json()) as { id: string };
        customerId = custData.id;
      }
    }

    const cardRes = await fetch(`https://api.mercadopago.com/v1/customers/${customerId}/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mpAccessToken}` },
      body: JSON.stringify({ token: cardToken }),
    });

    if (!cardRes.ok) {
      log("Failed to save MP card");
      return res.status(500).json({ error: "failed_to_save_card" });
    }

    const cardData = (await cardRes.json()) as { id: string; last_four_digits: string };

    await prisma.user.update({
      where: { id: user.id },
      data: { mpCustomerId: customerId, mpCardId: cardData.id, mpCardLastFour: cardData.last_four_digits },
    });

    return res.json({ ok: true, lastFour: cardData.last_four_digits });
  } catch (err) {
    log("Save card error:", (err as Error).message);
    return res.status(500).json({ error: "failed_to_save_card" });
  }
});
