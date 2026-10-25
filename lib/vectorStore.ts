/**
 * The full-site search index: an Upstash Vector *hybrid* index (dense text-embedding-3-small + BM25),
 * filled by scripts/crawl-site.ts. Upstash embeds the text itself, so both upserts and queries send
 * plain text. The app uses it when UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN are set.
 */
import crypto from "node:crypto";
import { Index } from "@upstash/vector";
import type { Hit } from "./retrieval";
import type { Chunk } from "./types";

export interface VectorMeta {
  [key: string]: unknown;
  url: string;
  title: string;
  heading?: string;
  page?: number;
  format: "html" | "pdf";
  date?: string;
  sourceId: string;
}

export function vectorConfigured(): boolean {
  return Boolean(process.env.UPSTASH_VECTOR_REST_URL && process.env.UPSTASH_VECTOR_REST_TOKEN);
}

let client: Index<VectorMeta> | null = null;
export function vectorIndex(): Index<VectorMeta> {
  client ??= new Index<VectorMeta>({
    url: process.env.UPSTASH_VECTOR_REST_URL,
    token: process.env.UPSTASH_VECTOR_REST_TOKEN,
  });
  return client;
}

/** Stable id for a page: 16 hex characters of a hash of its URL key. */
export function docId(urlKey: string): string {
  return crypto.createHash("sha1").update(urlKey).digest("hex").slice(0, 16);
}

/** The text that gets embedded and stored: a first line naming the page and section, then the passage. */
export function toVectorData(c: { title: string; heading?: string; text: string }): string {
  const head = `${c.title}${c.heading ? ` > ${c.heading}` : ""}`.replace(/\s+/g, " ").slice(0, 300);
  return `${head}\n${c.text}`;
}

export function fromVectorData(data: string): string {
  const i = data.indexOf("\n");
  return i >= 0 ? data.slice(i + 1) : data;
}

export type VectorSearch = (queries: string[], topK: number) => Promise<Hit[]>;

/** Query the index once per search query and merge the result lists by rank (reciprocal rank fusion). */
export const upstashSearch: VectorSearch = async (queries, topK) => {
  const index = vectorIndex();
  const lists = await Promise.all(
    queries.map((q) => index.query({ data: q.slice(0, 2000), topK, includeMetadata: true, includeData: true })),
  );
  const fused = new Map<string, Hit>();
  for (const list of lists) {
    list.forEach((r, rank) => {
      const m = r.metadata;
      if (!m || !r.data) return;
      const id = String(r.id);
      const prev = fused.get(id);
      if (prev) {
        prev.score += 1 / (60 + rank + 1);
        return;
      }
      const chunk: Chunk = {
        id,
        sourceId: m.sourceId,
        url: m.url,
        title: m.title,
        section: "",
        format: m.format,
        page: m.page,
        heading: m.heading,
        text: fromVectorData(r.data),
        date: m.date,
      };
      fused.set(id, { chunk, score: 1 / (60 + rank + 1) });
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
};
