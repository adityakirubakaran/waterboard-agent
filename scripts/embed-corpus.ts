/**
 * Optional: adds one vector per passage (Gemini embeddings) so search also matches by meaning, not
 * only by shared words. The app works without this step (keyword search only).
 *
 *   GEMINI_API_KEY=... npm run embed
 *
 * Vectors are cached in .cache/ by passage text, so re-running after a corpus rebuild only embeds
 * passages that changed. Writes data/corpus/embeddings.bin and embeddings.json.
 */
import "../lib/env";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EMBED_DIM, EMBED_MODEL, embedTexts, hasGeminiKey } from "../lib/gemini";
import { normalize } from "../lib/retrieval";
import type { Chunk } from "../lib/types";

const DIR = path.join(process.cwd(), "data", "corpus");
const CACHE = path.join(process.cwd(), ".cache", `embeddings-${EMBED_MODEL}-${EMBED_DIM}.json`);
const BATCH = Number(process.env.EMBED_BATCH ?? 50);
const PAUSE_MS = Number(process.env.EMBED_PAUSE_MS ?? 1500);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

export function embedText(c: Chunk): string {
  return `${c.title}${c.heading ? `\n${c.heading}` : ""}\n${c.text}`.slice(0, 6000);
}

async function main() {
  if (!hasGeminiKey()) {
    console.log("[embed] GEMINI_API_KEY not set; skipping (the app will use keyword search only).");
    return;
  }
  const chunks: Chunk[] = JSON.parse(fs.readFileSync(path.join(DIR, "chunks.json"), "utf8"));
  const cache: Record<string, string> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const keys = chunks.map((c) => hash(embedText(c)));
  const todo = chunks.map((c, i) => ({ c, key: keys[i] })).filter((t) => !cache[t.key]);
  console.log(`[embed] ${chunks.length} passages, ${chunks.length - todo.length} cached, ${todo.length} to embed with ${EMBED_MODEL}`);

  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const vecs = await embedTexts(batch.map((t) => embedText(t.c)), "RETRIEVAL_DOCUMENT");
    if (vecs.length !== batch.length) throw new Error(`expected ${batch.length} vectors, got ${vecs.length}`);
    batch.forEach((t, j) => {
      const v = normalize(vecs[j]);
      cache[t.key] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
    });
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    if (i + BATCH < todo.length) await sleep(PAUSE_MS);
  }

  const out = new Float32Array(chunks.length * EMBED_DIM);
  keys.forEach((k, i) => {
    const b = Buffer.from(cache[k], "base64");
    const v = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    if (v.length !== EMBED_DIM) throw new Error(`cached vector has ${v.length} dims, expected ${EMBED_DIM}`);
    out.set(v, i * EMBED_DIM);
  });
  fs.writeFileSync(path.join(DIR, "embeddings.bin"), Buffer.from(out.buffer));
  fs.writeFileSync(
    path.join(DIR, "embeddings.json"),
    JSON.stringify({ model: EMBED_MODEL, dim: EMBED_DIM, chunkIds: chunks.map((c) => c.id), builtAt: new Date().toISOString() }),
  );
  console.log(`[embed] wrote ${chunks.length} vectors to data/corpus/embeddings.bin`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
