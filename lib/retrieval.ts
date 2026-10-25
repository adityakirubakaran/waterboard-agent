import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Chunk, CorpusMeta, Source } from "./types";
import { tokenize, tokenizeQuery } from "./text";

/**
 * The data store: the chunks of the Tier 1 pages and files, a BM25 keyword index over them,
 * and (when the corpus was embedded) one vector per chunk. Nothing outside these files is searchable.
 */
export interface Corpus {
  meta: CorpusMeta;
  chunks: Chunk[];
  sourcesById: Map<string, Source>;
  bm25: Bm25;
  vectors?: { dim: number; model: string; data: Float32Array };
}

export interface Hit {
  chunk: Chunk;
  score: number;
  bm25Rank?: number;
  denseRank?: number;
}

/** BM25 over an inverted index (term -> documents), so it stays small and fast on large snapshots. */
class Bm25 {
  private postings = new Map<string, { docs: number[]; tfs: number[] }>();
  private lens: Uint32Array;
  private avg = 0;
  private n: number;
  constructor(texts: string[], private k1 = 1.2, private b = 0.75) {
    this.n = texts.length;
    this.lens = new Uint32Array(texts.length);
    let total = 0;
    texts.forEach((t, i) => {
      const toks = tokenize(t);
      const tf = new Map<string, number>();
      for (const w of toks) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const [w, f] of tf) {
        let p = this.postings.get(w);
        if (!p) this.postings.set(w, (p = { docs: [], tfs: [] }));
        p.docs.push(i);
        p.tfs.push(f);
      }
      this.lens[i] = toks.length;
      total += toks.length;
    });
    this.avg = total / Math.max(1, texts.length);
  }
  search(queryTokens: string[], limit: number): { index: number; score: number }[] {
    const scores = new Float64Array(this.n);
    const touched: number[] = [];
    for (const w of new Set(queryTokens)) {
      const p = this.postings.get(w);
      if (!p) continue;
      const df = p.docs.length;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (let j = 0; j < p.docs.length; j++) {
        const d = p.docs[j];
        const f = p.tfs[j];
        if (scores[d] === 0) touched.push(d);
        scores[d] += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.lens[d]) / this.avg));
      }
    }
    return touched
      .map((index) => ({ index, score: scores[index] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

let cached: Corpus | null = null;

export function corpusDir(): string {
  return process.env.CORPUS_DIR ?? path.join(process.cwd(), "data", "corpus");
}

export function corpusAvailable(dir = corpusDir()): boolean {
  return fs.existsSync(path.join(dir, "meta.json")) && (fs.existsSync(path.join(dir, "chunks.json.gz")) || fs.existsSync(path.join(dir, "chunks.json")));
}

/** Passages of the snapshot (stored gzipped as chunks.json.gz; plain chunks.json also works). */
export function readChunks(dir = corpusDir()): Chunk[] {
  const gz = path.join(dir, "chunks.json.gz");
  if (fs.existsSync(gz)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString("utf8"));
  return JSON.parse(fs.readFileSync(path.join(dir, "chunks.json"), "utf8"));
}

export function loadCorpus(dir = corpusDir()): Corpus {
  if (cached && dir === corpusDir()) return cached;
  const meta: CorpusMeta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const chunks: Chunk[] = readChunks(dir);
  const sourcesById = new Map(meta.sources.map((s) => [s.id, s]));
  const bm25 = new Bm25(chunks.map((c) => `${c.title}\n${c.heading ?? ""}\n${c.text}`));
  let vectors: Corpus["vectors"];
  const vecMetaPath = path.join(dir, "embeddings.json");
  const vecPath = path.join(dir, "embeddings.bin");
  if (fs.existsSync(vecMetaPath) && fs.existsSync(vecPath)) {
    const vm = JSON.parse(fs.readFileSync(vecMetaPath, "utf8")) as { dim: number; model: string; chunkIds: string[] };
    const buf = fs.readFileSync(vecPath);
    const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const sameOrder = vm.chunkIds.length === chunks.length && vm.chunkIds.every((id, i) => id === chunks[i].id);
    if (sameOrder && data.length === vm.dim * chunks.length) vectors = { dim: vm.dim, model: vm.model, data };
  }
  const corpus: Corpus = { meta, chunks, sourcesById, bm25, vectors };
  if (dir === corpusDir()) cached = corpus;
  return corpus;
}

function dense(corpus: Corpus, q: Float32Array, limit: number): { index: number; score: number }[] {
  const v = corpus.vectors!;
  const out: { index: number; score: number }[] = [];
  for (let i = 0; i < corpus.chunks.length; i++) {
    let s = 0;
    const off = i * v.dim;
    for (let d = 0; d < v.dim; d++) s += v.data[off + d] * q[d];
    out.push({ index: i, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export interface RetrieveOptions {
  k?: number; // passages handed to the model
  perSource?: number; // max passages from one page or file
  queryVector?: Float32Array; // query embedding, if the corpus has vectors
}

/**
 * Hybrid search: BM25 for each query (the visitor's words plus rewritten queries) and, optionally,
 * vector search, merged with reciprocal rank fusion.
 */
export function retrieve(corpus: Corpus, query: string | string[], opts: RetrieveOptions = {}): Hit[] {
  const queries = (Array.isArray(query) ? query : [query]).map((q) => q.trim()).filter(Boolean);
  const k = opts.k ?? 8;
  const perSource = opts.perSource ?? 3;
  const pool = 60;
  const fused = new Map<number, Hit>();
  const add = (index: number, rank: number, kind: "bm25" | "dense") => {
    const h = fused.get(index) ?? { chunk: corpus.chunks[index], score: 0 };
    h.score += 1 / (60 + rank);
    if (kind === "bm25") h.bm25Rank = rank;
    else h.denseRank = rank;
    fused.set(index, h);
  };
  for (const q of queries) corpus.bm25.search(tokenizeQuery(q), pool).forEach((r, i) => add(r.index, i + 1, "bm25"));
  if (opts.queryVector && corpus.vectors && opts.queryVector.length === corpus.vectors.dim) {
    dense(corpus, opts.queryVector, pool).forEach((r, i) => add(r.index, i + 1, "dense"));
  }
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);
  const perSourceCount = new Map<string, number>();
  const picked: Hit[] = [];
  for (const h of ranked) {
    const c = perSourceCount.get(h.chunk.sourceId) ?? 0;
    if (c >= perSource) continue;
    perSourceCount.set(h.chunk.sourceId, c + 1);
    picked.push(h);
    if (picked.length >= k) break;
  }
  return picked;
}

export function normalize(v: number[] | Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
