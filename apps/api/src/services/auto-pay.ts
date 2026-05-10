import prisma from "@repo/db";
import { log } from "@repo/logger";
import { randomBytes } from "crypto";

const mpAccessToken = process.env.MP_DEV === "true"
  ? (process.env.MP_ACCESS_TOKEN_TEST ?? "")
  : (process.env.MP_ACCESS_TOKEN_PROD ?? "");

export async function tryAutoPay(
  negotiationId: string,
  buyerId: string,
  amount: number,
  category: string | null,
): Promise<boolean> {
  const buyer = await prisma.user.findUnique({ where: { id: buyerId } });
  if (!buyer) return false;

  if (!buyer.autoPayEnabled) return false;
  if (!buyer.mpCustomerId || !buyer.mpCardId) {
    log("[auto-pay] Buyer has no saved card");
    return false;
  }

  if (buyer.autoPayMaxAmount && amount > buyer.autoPayMaxAmount) {
    log(`[auto-pay] Amount ${amount} exceeds max ${buyer.autoPayMaxAmount}`);
    return false;
  }

  if (buyer.autoPayCategories.length > 0) {
    if (!category || !buyer.autoPayCategories.includes(category)) {
      log(`[auto-pay] Category "${category ?? "uncategorized"}" not in allowed: ${buyer.autoPayCategories.join(", ")}`);
      return false;
    }
  }

  const neg = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
    include: { search: { select: { id: true } } },
  });
  if (!neg) return false;

  const autoPaidCount = await prisma.negotiation.count({
    where: { searchId: neg.searchId, autoPaid: true },
  });
  if (autoPaidCount >= buyer.autoPayMaxPerSearch) {
    log(`[auto-pay] Already ${autoPaidCount} auto-paid for search, max is ${buyer.autoPayMaxPerSearch}`);
    return false;
  }

  try {
    const paymentRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mpAccessToken}`,
        "X-Idempotency-Key": `autopay-${negotiationId}`,
      },
      body: JSON.stringify({
        transaction_amount: amount,
        token: buyer.mpCardId,
        description: `Auto-pay negociación ${negotiationId}`,
        installments: 1,
        payer: { id: buyer.mpCustomerId },
        external_reference: negotiationId,
      }),
    });

    if (!paymentRes.ok) {
      const errText = await paymentRes.text();
      log(`[auto-pay] MP payment failed: ${errText}`);
      return false;
    }

    const paymentData = (await paymentRes.json()) as { id: number; status: string };

    if (paymentData.status === "approved") {
      const verificationCode = randomBytes(3).toString("hex").toUpperCase();
      await prisma.$transaction(async (tx) => {
        await tx.negotiation.update({
          where: { id: negotiationId },
          data: {
            status: "accepted",
            successful: true,
            completedAt: new Date(),
            mpPaymentId: String(paymentData.id),
            paymentStatus: "approved",
            autoPaid: true,
            verificationCode,
          },
        });
        await tx.product.update({
          where: { id: neg.productId },
          data: { status: "sold" },
        });
      });
      log(`[auto-pay] Payment approved for ${negotiationId}, code: ${verificationCode}`);
      return true;
    }

    log(`[auto-pay] Payment status: ${paymentData.status}`);
    await prisma.negotiation.update({
      where: { id: negotiationId },
      data: { paymentStatus: paymentData.status, autoPaid: true },
    });
    return false;
  } catch (err) {
    log(`[auto-pay] Error: ${(err as Error).message}`);
    return false;
  }
}
