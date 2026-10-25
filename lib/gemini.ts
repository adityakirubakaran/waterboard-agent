import { GoogleGenAI } from "@google/genai";

/**
 * Gemini access. The model is called with no tools at all (no Google Search grounding, no URL context,
 * no code execution), so the only material it can draw on is the text we put in the prompt.
 */

export const CHAT_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
/** Small, fast model used only to turn the visitor's question into a search query. */
export const REWRITE_MODEL = process.env.GEMINI_REWRITE_MODEL ?? "gemini-flash-lite-latest";
export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001";
export const EMBED_DIM = Number(process.env.GEMINI_EMBED_DIM ?? 768);

let client: GoogleGenAI | null = null;
export function gemini(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  // GEMINI_BASE_URL is only for tests (a local fake server); leave it unset in real use.
  const baseUrl = process.env.GEMINI_BASE_URL;
  client ??= new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  return client;
}

export function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry on rate limits and transient server errors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      const retryable = /429|RESOURCE_EXHAUSTED|500|502|503|504|UNAVAILABLE|INTERNAL|fetch failed|ECONNRESET|timed out/i.test(msg);
      if (!retryable || i === tries - 1) break;
      const wait = Math.min(30000, 1500 * 2 ** i) + Math.random() * 500;
      console.warn(`[gemini] ${label} failed (${msg.slice(0, 120)}); retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

/** Embed up to 100 texts in one call (callers batch). Document texts should start with their page title. */
export async function embedTexts(
  texts: string[],
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
): Promise<number[][]> {
  const ai = gemini();
  const r = await withRetry(
    () => ai.models.embedContent({ model: EMBED_MODEL, contents: texts, config: { taskType, outputDimensionality: EMBED_DIM } }),
    "embed",
  );
  return (r.embeddings ?? []).map((e) => e.values ?? []);
}
