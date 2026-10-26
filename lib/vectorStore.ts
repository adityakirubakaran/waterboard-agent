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

/**
 * Tidy a pasted setting: trims spaces and quotes, drops a pasted "NAME=" prefix, and for the URL adds
 * https:// when it is missing (a bare "xyz-vector.upstash.io" is a common copy-paste).
 */
export function cleanSetting(raw: string | undefined, name: string): string {
  let v = (raw ?? "").trim();
  if (v.startsWith(`${name}=`)) v = v.slice(name.length + 1).trim();
  v = v.replace(/^["']|["']$/g, "").trim();
  if (name.endsWith("_URL") && v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
  return v.replace(/\/+$/, "");
}

export function vectorSettings(): { url: string; token: string } {
  return {
    url: cleanSetting(process.env.UPSTASH_VECTOR_REST_URL, "UPSTASH_VECTOR_REST_URL"),
    token: cleanSetting(process.env.UPSTASH_VECTOR_REST_TOKEN, "UPSTASH_VECTOR_REST_TOKEN"),
  };
}

export function vectorConfigured(): boolean {
  const { url, token } = vectorSettings();
  return Boolean(url && token);
}

let client: Index<VectorMeta> | null = null;
export function vectorIndex(): Index<VectorMeta> {
  client ??= new Index<VectorMeta>(vectorSettings());
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
/**
 * Files filed under this year or last (".../2026/...", "...-2026.pdf"). The index holds decades of agendas and
 * notices that repeat the same wording, so without this the current agenda or schedule can lose to a 2014 copy.
 */
export function recentFilter(now = new Date()): string {
  const y = now.getFullYear();
  return `url GLOB '*${y}*' OR url GLOB '*${y - 1}*'`;
}

export const upstashSearch: VectorSearch = async (queries, topK) => {
  const index = vectorIndex();
  const ask = (q: string, filter?: string) =>
    index.query({ data: q.slice(0, 2000), topK: filter ? 10 : topK, includeMetadata: true, includeData: true, filter });
  const lists = await Promise.all([
    ...queries.map((q) => ask(q)),
    // one more search limited to recent files; if the filter is refused, search without it rather than fail
    ask(queries[1] ?? queries[0], recentFilter()).catch(() => []),
  ]);
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
