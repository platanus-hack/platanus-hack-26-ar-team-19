import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { log } from "@repo/logger";
import { readFileSync } from "fs";
import path from "path";

const openAiApiKey = process.env.OPENAI_API_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;
const openAiVisionModel = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";
const uploadsRoot = process.cwd().endsWith(`${path.sep}apps${path.sep}api`)
  ? path.resolve(process.cwd(), "../public/uploads")
  : path.resolve(process.cwd(), "apps/public/uploads");

const openAiClient = new OpenAI({ apiKey: openAiApiKey ?? "missing" });
const geminiClient = new GoogleGenerativeAI(geminiApiKey ?? "missing");

const ANALYSIS_PROMPT = `Analyze this product image for a marketplace listing. Describe:
1. What the product is (type, brand if visible, model)
2. Physical appearance (color, size, shape, material)
3. Condition (new, used, any visible wear)
4. Notable features or accessories visible
5. Suggested category (electronics, vehicles, furniture, clothing, sporting-goods, musical-instruments, toys-games, home-goods)

Be concise but thorough. This description will be used for semantic search matching.
Respond in Spanish if the image has Spanish text, otherwise English.`;

const SEARCH_PROMPT = `Describe this image as if you were searching for this product on a marketplace.
Include: what it is, type/brand/model if identifiable, color, size, condition, category.
Be concise. This will be used to find similar products.`;

const MARKETPLACE_IMAGE_PROMPT = `Create a concise marketplace product image description for semantic search.
Mention the visible product type, brand/model if readable, color, condition, accessories, and category.
Do not invent details that are not visible. Keep it under 70 words.`;

const VERIFY_PROMPT = `You are verifying if a product image matches what a buyer is looking for.

Buyer wants: "{query}"
Product listing title: "{title}"

Look at the image and determine:
1. Does this image show a product that matches what the buyer is searching for?
2. Is it the same type/category of product?
3. How confident are you (0.0 to 1.0)?

Respond ONLY with JSON: {"matches": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}`;

// --- Private helpers ---

function resolveImagePath(imageUrl: string): string {
  if (imageUrl.startsWith("/uploads/")) {
    const filename = imageUrl.slice("/uploads/".length);
    const resolved = path.resolve(uploadsRoot, filename);
    if (path.basename(filename) !== filename || !resolved.startsWith(`${uploadsRoot}${path.sep}`)) {
      throw new Error("invalid_image_url");
    }
    return resolved;
  }
  if (imageUrl.startsWith("data:image/")) return imageUrl;
  throw new Error("invalid_image_url");
}

function isResolvedUploadPath(imageUrl: string): boolean {
  return imageUrl.startsWith(`${uploadsRoot}${path.sep}`);
}

async function buildOpenAiImageContent(imageUrl: string): Promise<OpenAI.ChatCompletionContentPartImage> {
  if (imageUrl.startsWith("data:")) {
    return { type: "image_url", image_url: { url: imageUrl, detail: "low" } };
  }
  if (isResolvedUploadPath(imageUrl)) {
    const buffer = readFileSync(imageUrl);
    const base64 = buffer.toString("base64");
    const mime = imageUrl.endsWith(".png") ? "image/png" : "image/jpeg";
    return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}`, detail: "low" } };
  }
  throw new Error("invalid_image_url");
}

async function analyzeWithOpenAi(imageUrl: string, prompt: string, maxTokens = 500): Promise<string> {
  const imageContent = await buildOpenAiImageContent(imageUrl);
  const response = await openAiClient.chat.completions.create({
    model: openAiVisionModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          imageContent,
        ],
      },
    ],
    max_tokens: maxTokens,
  });
  return response.choices[0]?.message?.content ?? "";
}

async function analyzeWithGemini(imageUrl: string, prompt: string): Promise<string> {
  const model = geminiClient.getGenerativeModel({ model: "gemini-2.0-flash" });

  let imagePart: { inlineData: { data: string; mimeType: string } };

  if (imageUrl.startsWith("data:")) {
    const [header, data] = imageUrl.split(",");
    const mimeType = header?.match(/data:(.*);/)?.[1] ?? "image/jpeg";
    imagePart = { inlineData: { data: data!, mimeType } };
  } else if (isResolvedUploadPath(imageUrl)) {
    const buffer = readFileSync(imageUrl);
    const mime = imageUrl.endsWith(".png") ? "image/png" : "image/jpeg";
    imagePart = { inlineData: { data: buffer.toString("base64"), mimeType: mime } };
  } else {
    throw new Error("invalid_image_url");
  }

  const result = await model.generateContent([prompt, imagePart]);
  return result.response.text();
}

async function analyzeImage(imageUrl: string, prompt: string, maxTokens = 500): Promise<string> {
  const resolved = resolveImagePath(imageUrl);
  if (openAiApiKey) {
    return analyzeWithOpenAi(resolved, prompt, maxTokens);
  }
  if (geminiApiKey) {
    return analyzeWithGemini(resolved, prompt);
  }
  log("WARN: no vision API key available");
  return "";
}

// --- Public exports ---

export async function analyzeProductImage(imageUrl: string): Promise<string> {
  return analyzeImage(imageUrl, ANALYSIS_PROMPT);
}

export async function describeMarketplaceProductImage(imageUrl: string): Promise<string> {
  return analyzeImage(imageUrl, MARKETPLACE_IMAGE_PROMPT, 160);
}

export async function analyzeSearchImage(imageUrl: string): Promise<string> {
  return analyzeImage(imageUrl, SEARCH_PROMPT);
}

export interface VisionVerifyResult {
  matches: boolean;
  confidence: number;
  reason: string;
}

export async function verifyProductMatch(
  imageUrl: string,
  buyerQuery: string,
  productTitle: string,
): Promise<VisionVerifyResult> {
  const prompt = VERIFY_PROMPT
    .replace("{query}", buyerQuery)
    .replace("{title}", productTitle);

  const raw = await analyzeImage(imageUrl, prompt);
  try {
    const parsed = JSON.parse(raw);
    return {
      matches: !!parsed.matches,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reason: parsed.reason ?? "",
    };
  } catch {
    return { matches: true, confidence: 0.5, reason: "Could not parse vision response" };
  }
}
