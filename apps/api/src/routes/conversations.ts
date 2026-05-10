import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import prisma from "@repo/db";
import { log } from "@repo/logger";
import {
  runBuyerOnboardingTurn,
  streamBuyerOnboardingTurn,
  type BuyerSearchDraft,
} from "../agents/buyer-onboarding";
import {
  runSellerOnboardingTurn,
  streamSellerOnboardingTurn,
  type SellerProductDraft,
} from "../agents/seller-onboarding";
import { enqueueRunSearch } from "../jobs/runner";
import type { ChatTurn } from "../llm/gemini";
import { embedText, toVectorLiteral, upsertProductEmbedding } from "../services/embeddings";
import { analyzeProductImage, analyzeSearchImage } from "../services/vision";
import { getPriceReference, type MLPriceRef } from "../services/mercadolibre";
import { requireAuth, type AuthUser } from "../auth";
import { asyncHandler, sseHeaders, sseSend } from "./_sse";

export const conversationsRouter: RouterType = Router();

const ConversationMode = z.enum(["buying", "posting_product"]);
const StartConversation = z.object({ mode: ConversationMode });
const PostMessage = z.object({
  content: z.string().min(1),
  imageUrl: z.string().min(1).optional(),
});

type ConversationMode = z.infer<typeof ConversationMode>;
type ConversationMessageRow = { role: string; content: string };
type DraftState = BuyerSearchDraft | SellerProductDraft;

const STATE_PREFIX = "__state__:";
const ML_PREFIX = "__ml__:";
const UNCAPPED_BUYER_MAX_PRICE = 1_000_000_000;

function currentUser(res: { locals: { user?: AuthUser } }): AuthUser {
  const user = res.locals.user;
  if (!user) throw new Error("Missing authenticated user");
  return user;
}

function visibleMessages(messages: ConversationMessageRow[]): ConversationMessageRow[] {
  return messages.filter((m) =>
    m.role !== "system" || (!m.content.startsWith(STATE_PREFIX) && !m.content.startsWith(ML_PREFIX)),
  );
}

function buildHistory(messages: ConversationMessageRow[], content: string): ChatTurn[] {
  return [
    ...visibleMessages(messages).map((m) => ({ role: m.role as ChatTurn["role"], content: m.content })),
    { role: "user", content },
  ];
}

function latestState<T extends DraftState>(messages: ConversationMessageRow[]): T {
  const raw = [...messages].reverse().find((m) => (
    m.role === "system" && m.content.startsWith(STATE_PREFIX)
  ))?.content.slice(STATE_PREFIX.length);

  if (!raw) return {} as T;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function latestMLData(messages: ConversationMessageRow[]): MLPriceRef | null {
  const raw = [...messages].reverse().find((m) => (
    m.role === "system" && m.content.startsWith(ML_PREFIX)
  ))?.content.slice(ML_PREFIX.length);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function stateMessage(state: DraftState) {
  return { role: "system", content: `${STATE_PREFIX}${JSON.stringify(state)}` };
}

function mlMessage(data: MLPriceRef) {
  return { role: "system", content: `${ML_PREFIX}${JSON.stringify(data)}` };
}

function normalizeBuyerMaxPrice(maxPrice: number | undefined): number {
  if (typeof maxPrice === "number" && Number.isFinite(maxPrice) && maxPrice > 0) {
    return maxPrice;
  }
  return UNCAPPED_BUYER_MAX_PRICE;
}

function buildMLContext(ml: MLPriceRef): string {
  const topProducts = ml.products.slice(0, 3).map((p) =>
    `  - "${p.title}" → $${p.price.toLocaleString("es-AR")} (${p.condition})`,
  ).join("\n");
  return `\nMarket price reference from MercadoLibre (${ml.count} results):\n` +
    `  Min: $${ml.min.toLocaleString("es-AR")} | Max: $${ml.max.toLocaleString("es-AR")} | Promedio: $${ml.avg.toLocaleString("es-AR")} | Mediana: $${ml.median.toLocaleString("es-AR")}\n` +
    `  Top listings:\n${topProducts}\n` +
    `Use this data to suggest a competitive price to the seller. Mention it naturally.`;
}

async function runTurnWithContext(
  mode: ConversationMode,
  history: ChatTurn[],
  state: DraftState,
  mlData: MLPriceRef | null,
  onChunk?: (text: string) => void,
) {
  if (mode === "buying") {
    const inv = await getInventorySummary().catch(() => undefined);
    if (onChunk) {
      return streamBuyerOnboardingTurn(history, state as BuyerSearchDraft, onChunk, inv);
    }
    return runBuyerOnboardingTurn(history, state as BuyerSearchDraft, inv);
  }

  const mlContext = mlData ? buildMLContext(mlData) : undefined;

  if (onChunk) {
    return streamSellerOnboardingTurn(history, state as SellerProductDraft, onChunk, mlContext);
  }
  return runSellerOnboardingTurn(history, state as SellerProductDraft, mlContext);
}

async function completeConversation(
  conversationId: string,
  userId: string,
  mode: ConversationMode,
  done: boolean,
  state: DraftState,
): Promise<{ productId?: string; searchId?: string; jobId?: string }> {
  if (!done) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: "in_progress" },
    });
    return {};
  }

  if (mode === "posting_product") {
    const productState = state as SellerProductDraft;
    if (
      !productState.title ||
      !productState.description ||
      !productState.askPrice ||
      !productState.negotiationStrategy
    ) {
      return {};
    }

    const product = await prisma.product.create({
      data: {
        userId,
        conversationId,
        title: productState.title,
        description: productState.description,
        category: productState.category ?? null,
        condition: productState.condition ?? null,
        askPrice: productState.askPrice,
        negotiationStrategy: productState.negotiationStrategy,
        imageUrl: productState.imageUrl,
      },
    });

    let visionAnalysis: string | null = null;
    if (product.imageUrl) {
      visionAnalysis = await analyzeProductImage(product.imageUrl).catch((err) => {
        log("Product vision analysis failed:", (err as Error).message);
        return null;
      });
    }

    await upsertProductEmbedding(product.id, { ...product, visionAnalysis }).catch((err) => {
      log("Product embedding failed:", (err as Error).message);
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: "completed" },
    });
    return { productId: product.id };
  }

  const searchState = state as BuyerSearchDraft;
  if (!searchState.query || !searchState.negotiationStrategy) {
    return {};
  }
  const maxPrice = normalizeBuyerMaxPrice(searchState.maxPrice);

  const search = await prisma.buyerSearch.create({
    data: {
      buyerId: userId,
      conversationId,
      query: searchState.query,
      requirements: searchState.requirements ?? null,
      category: searchState.category ?? null,
      maxPrice,
      negotiationStrategy: searchState.negotiationStrategy,
      timeBudgetSeconds: searchState.timeBudgetSeconds ?? 120,
      imageUrl: searchState.imageUrl ?? null,
      imageDescription: searchState.imageDescription ?? null,
      status: "ready",
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "completed" },
  });

  const jobId = await enqueueRunSearch({ searchId: search.id });
  return { searchId: search.id, jobId };
}

let inventoryCache: string | null = null;
let inventoryCacheTs = 0;
const INVENTORY_CACHE_TTL = 30_000;

async function getInventorySummary(): Promise<string> {
  if (inventoryCache && Date.now() - inventoryCacheTs < INVENTORY_CACHE_TTL) return inventoryCache;

  const rows = await prisma.$queryRaw<{ category: string; cnt: bigint; minPrice: number; maxPrice: number; avgPrice: number }[]>`
    SELECT "category", COUNT(*) as cnt,
           MIN("askPrice") as "minPrice", MAX("askPrice") as "maxPrice", ROUND(AVG("askPrice")) as "avgPrice"
    FROM "Product"
    WHERE "status" = 'active' AND "category" IS NOT NULL
    GROUP BY "category"
    ORDER BY cnt DESC
  `;

  if (rows.length === 0) {
    inventoryCache = "INVENTARIO: El marketplace está vacío por ahora.";
    inventoryCacheTs = Date.now();
    return inventoryCache;
  }

  const lines = rows.map((r) =>
    `  - ${r.category}: ${Number(r.cnt)} productos ($${Number(r.minPrice).toLocaleString("es-AR")} – $${Number(r.maxPrice).toLocaleString("es-AR")}, promedio $${Number(r.avgPrice).toLocaleString("es-AR")})`,
  );
  const total = rows.reduce((s, r) => s + Number(r.cnt), 0);
  inventoryCache = `INVENTARIO ACTUAL DEL MARKETPLACE (${total} productos activos):\n${lines.join("\n")}`;
  inventoryCacheTs = Date.now();
  return inventoryCache;
}

const LOCAL_THRESHOLD = 10;

async function countLocalMatches(query: string): Promise<number> {
  try {
    const { values } = await embedText(query);
    const vector = toVectorLiteral(values);
    const result = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count
      FROM "Product" p
      INNER JOIN "ProductEmbedding" pe ON pe."productId" = p."id"
      WHERE p."status" = 'active'
        AND (pe."embedding" <=> ${vector}::vector) <= 0.7
    `;
    return Number(result[0]?.count ?? 0);
  } catch (err) {
    log("Local match count failed:", (err as Error).message);
    return 999;
  }
}

async function fetchMLIfNeeded(
  mode: ConversationMode,
  state: DraftState,
  existingML: MLPriceRef | null,
): Promise<MLPriceRef | null> {
  if (mode !== "posting_product") return null;
  if (existingML) return existingML;

  const sellerState = state as SellerProductDraft;
  const query = sellerState.title;
  if (!query) return null;

  const localCount = await countLocalMatches(query);
  if (localCount >= LOCAL_THRESHOLD) {
    log(`Found ${localCount} local matches for "${query}", skipping MercadoLibre`);
    return null;
  }

  log(`Only ${localCount} local matches for "${query}", fetching MercadoLibre prices`);
  try {
    return await getPriceReference(query);
  } catch (err) {
    log("MercadoLibre lookup failed:", (err as Error).message);
    return null;
  }
}

conversationsRouter.use(requireAuth);

conversationsRouter.post("/", asyncHandler(async (req, res) => {
  const parsed = StartConversation.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = currentUser(res);
  const turn = await runTurnWithContext(parsed.data.mode, [], {}, null);

  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      mode: parsed.data.mode,
      messages: {
        create: [
          { role: "assistant", content: turn.reply },
          stateMessage(turn.state),
        ],
      },
    },
    include: { messages: true },
  });

  return res.status(201).json({
    id: conversation.id,
    mode: conversation.mode,
    status: conversation.status,
    state: turn.state,
    done: turn.done,
    suggestions: turn.suggestions ?? [],
    messages: visibleMessages(conversation.messages),
  });
}));

conversationsRouter.get("/", asyncHandler(async (req, res) => {
  const user = currentUser(res);
  const mode = ConversationMode.safeParse(req.query.mode).success
    ? (req.query.mode as ConversationMode)
    : undefined;

  const conversations = await prisma.conversation.findMany({
    where: { userId: user.id, ...(mode ? { mode } : {}) },
    orderBy: { createdAt: "desc" },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      product: { select: { id: true } },
      search: { select: { id: true } },
    },
  });

  return res.json(conversations.map((conversation) => {
    const preview = visibleMessages(conversation.messages)[0]?.content ?? "";
    return {
      id: conversation.id,
      mode: conversation.mode,
      status: conversation.status,
      productId: conversation.product?.id ?? null,
      searchId: conversation.search?.id ?? null,
      createdAt: conversation.createdAt,
      preview,
    };
  }));
}));

conversationsRouter.post("/:id/messages", asyncHandler(async (req, res) => {
  const parsed = PostMessage.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = currentUser(res);
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) return res.status(404).json({ error: "conversation not found" });
  if (conversation.userId !== user.id) return res.status(403).json({ error: "not_the_owner" });
  if (conversation.status === "completed") {
    return res.status(409).json({ error: "conversation already completed" });
  }

  await prisma.conversationMessage.create({
    data: { conversationId: conversation.id, role: "user", content: parsed.data.content },
  });

  const state = latestState(conversation.messages);

  if (parsed.data.imageUrl) {
    if (conversation.mode === "buying") {
      const buyerState = state as BuyerSearchDraft;
      buyerState.imageUrl = parsed.data.imageUrl;
      try {
        buyerState.imageDescription = await analyzeSearchImage(parsed.data.imageUrl);
      } catch (err) {
        log("Image analysis failed:", (err as Error).message);
      }
    } else {
      (state as SellerProductDraft).imageUrl = parsed.data.imageUrl;
    }
  }

  const existingML = latestMLData(conversation.messages);
  const mlData = await fetchMLIfNeeded(conversation.mode as ConversationMode, state, existingML);

  const turn = await runTurnWithContext(
    conversation.mode as ConversationMode,
    buildHistory(conversation.messages, parsed.data.content),
    state,
    mlData,
  );
  const merged = {
    ...state,
    ...turn.state,
    ...(conversation.mode === "posting_product" && parsed.data.imageUrl ? { imageUrl: parsed.data.imageUrl } : {}),
  };

  await prisma.conversationMessage.createMany({
    data: [
      { conversationId: conversation.id, role: "assistant", content: turn.reply },
      { conversationId: conversation.id, ...stateMessage(merged) },
    ],
  });

  const completion = await completeConversation(
    conversation.id,
    user.id,
    conversation.mode as ConversationMode,
    turn.done,
    merged,
  );

  return res.json({
    reply: turn.reply,
    state: merged,
    done: turn.done,
    suggestions: turn.suggestions ?? [],
    ...completion,
  });
}));

conversationsRouter.post("/:id/messages/stream", asyncHandler(async (req, res) => {
  const parsed = PostMessage.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = currentUser(res);
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) return res.status(404).json({ error: "conversation not found" });
  if (conversation.userId !== user.id) return res.status(403).json({ error: "not_the_owner" });
  if (conversation.status === "completed") {
    return res.status(409).json({ error: "conversation already completed" });
  }

  sseHeaders(res);

  try {
    await prisma.conversationMessage.create({
      data: { conversationId: conversation.id, role: "user", content: parsed.data.content },
    });

    const state = latestState(conversation.messages);

    if (parsed.data.imageUrl) {
      if (conversation.mode === "buying") {
        const buyerState = state as BuyerSearchDraft;
        buyerState.imageUrl = parsed.data.imageUrl;
        try {
          buyerState.imageDescription = await analyzeSearchImage(parsed.data.imageUrl);
        } catch (err) {
          log("Image analysis failed:", (err as Error).message);
        }
      } else {
        (state as SellerProductDraft).imageUrl = parsed.data.imageUrl;
      }
    }

    const existingML = latestMLData(conversation.messages);
    const mlData = await fetchMLIfNeeded(conversation.mode as ConversationMode, state, existingML);

    const turn = await runTurnWithContext(
      conversation.mode as ConversationMode,
      buildHistory(conversation.messages, parsed.data.content),
      state,
      mlData,
      (chunk) => sseSend(res, { chunk }),
    );
    const merged = {
      ...state,
      ...turn.state,
      ...(conversation.mode === "posting_product" && parsed.data.imageUrl ? { imageUrl: parsed.data.imageUrl } : {}),
    };

    await prisma.conversationMessage.createMany({
      data: [
        { conversationId: conversation.id, role: "assistant", content: turn.reply },
        { conversationId: conversation.id, ...stateMessage(merged) },
      ],
    });

    const completion = await completeConversation(
      conversation.id,
      user.id,
      conversation.mode as ConversationMode,
      turn.done,
      merged,
    );

    sseSend(res, {
      done: true,
      state: merged,
      suggestions: turn.suggestions ?? [],
      ...completion,
    });
  } catch (err) {
    log("Streaming conversation failed:", (err as Error).message);
    sseSend(res, { error: "internal_error" });
  }
  res.end();
}));

conversationsRouter.get("/:id", asyncHandler(async (req, res) => {
  const user = currentUser(res);
  const conversation = await prisma.conversation.findUnique({
    where: { id: req.params.id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      product: true,
      search: true,
    },
  });
  if (!conversation) return res.status(404).json({ error: "conversation not found" });
  if (conversation.userId !== user.id) return res.status(403).json({ error: "not_the_owner" });

  return res.json({
    ...conversation,
    state: latestState(conversation.messages),
    messages: visibleMessages(conversation.messages),
  });
}));
