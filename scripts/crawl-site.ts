/**
 * Full-site crawl of waterboards.ca.gov into the Upstash Vector index the chat searches.
 *
 * Breadth first: the inventory pages, the home page and the sitemap first, then everything they link to
 * on www.waterboards.ca.gov, and so on. Pages and PDFs only; no searches (URLs with ?), no other websites.
 * Requests are spaced out and back off when the site refuses (403/429).
 *
 * Progress is saved in data/crawl/ so the next run continues where this one stopped. The GitHub action
 * "Crawl full site" runs it in ~5 hour chunks and restarts itself until the frontier is empty.
 *
 *   npm run crawl                         continue (or start) the crawl
 *   npm run crawl -- --max-minutes 30     stop after 30 minutes
 *   npm run crawl -- --reset              start over (the index is overwritten page by page)
 *   npm run crawl -- --dry-run            don't write to Upstash (counts only)
 *   (testing) --start-url URL --sources file.csv --state-dir dir --gap-ms 50
 *
 * Needs UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN for a hybrid index created with the
 * OpenAI text-embedding-3-small dense model and the BM25 sparse model.
 */
import "../lib/env";
import { readCrawlState, summarize, writeCrawlState, type CrawlDoc, type CrawlState } from "../lib/crawlState";
import { readDataStoreConfig } from "../lib/dataStoreConfig";
import {
  boilerplateSet,
  chunkBlocks,
  chunkPdfPages,
  extractLinks,
  findPdfDate,
  htmlToBlocks,
  isReadableLink,
  urlKey,
  type Block,
  type Passage,
} from "../lib/extract";
import { Fetcher } from "../lib/fetchDoc";
import { readSources } from "../lib/sources";
import { docId, toVectorData, vectorConfigured, vectorIndex, type VectorMeta } from "../lib/vectorStore";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const baseCfg = readDataStoreConfig().fullSite;
// (testing) --start-url and --sources point the crawl at another site; --state-dir keeps progress elsewhere
const cfg = { ...baseCfg, startUrls: opt("--start-url") ? [opt("--start-url")!] : baseCfg.startUrls };
const STATE_DIR = opt("--state-dir");
const MAX_MINUTES = Number(opt("--max-minutes") ?? 320);
const DRY = flag("--dry-run");
const SAVE_EVERY = 100;
const UPSERT_BATCH = 32;
/** Upstash indexes new passages in the background; past this many waiting, we pause and let it catch up. */
const MAX_PENDING = 20_000;
/** How long to keep waiting out "backend unavailable" before ending the run (the next run resumes). */
const MAX_BUSY_MS = 20 * 60_000;
const BOILERPLATE_SAMPLE = 150;
const DELETE_BATCH = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const skip = cfg.skipUrlPatterns.map((p) => new RegExp(p, "i"));

class IndexWriteError extends Error {}

interface Pending {
  id: string;
  data: string;
  metadata: VectorMeta;
}

interface ParsedHtml {
  url: string;
  key: string;
  title?: string;
  date?: string;
  blocks: Block[];
}

async function sitemapUrls(fetcher: Fetcher, origin: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [`${origin}/sitemap.xml`];
  const seen = new Set<string>();
  while (queue.length && seen.size < 60) {
    const u = queue.shift()!;
    if (seen.has(u)) continue;
    seen.add(u);
    try {
      const { buf } = await fetcher.download(u);
      const xml = buf.toString("utf8");
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
      if (/<sitemapindex/i.test(xml)) queue.push(...locs);
      else out.push(...locs);
    } catch {
      // no sitemap; the crawl still works from links
    }
  }
  return out;
}

const KEY_FILE = /fee|form|faq|guid|instruction|application|brochure|fact.?sheet|schedule|checklist|how.?to/i;

async function withRetries<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 6) throw new Error(`${what} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      const wait = Math.min(60_000, 3_000 * 2 ** attempt);
      console.warn(`[crawl] ${what} failed (${String(e).slice(0, 120)}); retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

/**
 * Apply today's limits to what earlier runs stored: pages that are now on the skip list leave the index, and
 * long pages keep only their first maxPassagesPerDoc passages. This frees room under maxPassages for the rest
 * of the site. Deleting is safe to repeat, so a run that stops halfway just redoes it next time.
 */
async function applyLimits(st: CrawlState, index: ReturnType<typeof vectorIndex> | null) {
  const before = st.frontier.length;
  st.frontier = st.frontier.filter((u) => !skip.some((r) => r.test(u)));
  if (st.frontier.length < before) console.log(`[crawl] dropped ${before - st.frontier.length} queued URLs on the skip list`);

  const work: { key: string; keep: number; ids: string[] }[] = [];
  for (const [key, d] of Object.entries(st.docs)) {
    const keep = skip.some((r) => r.test(d.url)) ? 0 : Math.min(d.chunks, cfg.maxPassagesPerDoc);
    if (d.chunks <= keep) continue;
    const sid = docId(key);
    work.push({ key, keep, ids: Array.from({ length: d.chunks - keep }, (_, i) => `${sid}-${keep + i + 1}`) });
  }
  if (!work.length) return;
  const total = work.reduce((n, w) => n + w.ids.length, 0);
  console.log(`[crawl] removing ${total.toLocaleString()} stored passages from ${work.length.toLocaleString()} pages (skip list and per-page cap)`);
  let done = 0;
  let group: typeof work = [];
  let ids: string[] = [];
  const commit = async () => {
    for (let i = 0; index && i < ids.length; i += DELETE_BATCH) {
      const part = ids.slice(i, i + DELETE_BATCH);
      await withRetries("deleting passages", () => index.delete(part));
    }
    for (const w of group) {
      const d = st.docs[w.key];
      st.passages -= d.chunks - w.keep;
      d.chunks = w.keep;
      if (w.keep === 0) {
        d.status = "skipped";
        d.error = "on the skip list";
      }
    }
    done += ids.length;
    group = [];
    ids = [];
  };
  for (const w of work) {
    group.push(w);
    ids.push(...w.ids);
    if (ids.length >= 5_000) {
      await commit();
      if (done % 50_000 < 5_000) console.log(`[crawl] removed ${done.toLocaleString()} of ${total.toLocaleString()}`);
    }
  }
  await commit();
  console.log(`[crawl] removed ${done.toLocaleString()} passages; ${st.passages.toLocaleString()} remain`);
}

async function main() {
  if (!DRY && !vectorConfigured()) {
    console.error("Set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN (or use --dry-run).");
    process.exit(1);
  }
  const index = DRY ? null : vectorIndex();
  if (index) {
    // check the keys and the index before spending hours downloading
    try {
      const info = await index.info();
      console.log(
        `[crawl] Upstash index OK: ${info.vectorCount} passages stored (${info.pendingVectorCount} still being indexed), dimension ${info.dimension}${info.denseIndex?.embeddingModel ? `, model ${info.denseIndex.embeddingModel}` : ""}${info.sparseIndex ? ", hybrid" : ""}`,
      );
      await index.upsert([{ id: "__crawl_check__", data: "write check", metadata: { url: "", title: "", format: "html", sourceId: "check" } }]);
      await index.delete(["__crawl_check__"]);
      console.log("[crawl] Upstash write check OK");
      if (!info.sparseIndex || !info.denseIndex?.embeddingModel) {
        console.warn(
          "[crawl] warning: the index should be Hybrid with Upstash's embedding models (OpenAI text-embedding-3-small + BM25); text upserts may be refused otherwise.",
        );
      }
    } catch (e) {
      console.error(`[crawl] cannot use the Upstash index: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      console.error(
        "[crawl] check the GitHub secrets: UPSTASH_VECTOR_REST_URL should look like https://<name>-vector.upstash.io and UPSTASH_VECTOR_REST_TOKEN should be the regular (not read-only) token, with nothing else around them.",
      );
      process.exit(1);
    }
  }
  const fetcher = new Fetcher({
    gapMs: Number(opt("--gap-ms") ?? cfg.gapMs),
    maxPdfBytes: cfg.maxPdfMegabytes * 1024 * 1024,
    maxPdfPages: cfg.maxPdfPages,
    maxRefusalsInARow: 30,
    onBlocked: "pause",
    pauseMs: 10 * 60_000,
    maxPauses: 3,
    log: console.log,
  });

  const hosts = new Set<string>();
  for (const u of cfg.startUrls) {
    const h = new URL(u).hostname.toLowerCase();
    hosts.add(h);
    hosts.add(h.replace(/^www\./, ""));
    hosts.add(h.startsWith("www.") ? h : `www.${h}`);
  }

  let state: CrawlState | null = flag("--reset") ? null : readCrawlState(STATE_DIR);
  if (!state) {
    const now = new Date().toISOString();
    state = { version: 1, startedAt: now, updatedAt: now, runs: 0, frontier: [], docs: {}, passages: 0 };
    const seeds = [...readSources(opt("--sources")).map((s) => s.url), ...cfg.startUrls];
    if (cfg.useSitemap) {
      const origin = new URL(cfg.startUrls[0]).origin;
      const fromMap = await sitemapUrls(fetcher, origin);
      console.log(`[crawl] sitemap: ${fromMap.length} URLs`);
      seeds.push(...fromMap.filter((u) => isReadableLink(u, hosts)));
    }
    const seen = new Set<string>();
    for (const u of seeds) {
      const k = urlKey(u);
      if (seen.has(k)) continue;
      seen.add(k);
      state.frontier.push(u);
    }
    console.log(`[crawl] new crawl with ${state.frontier.length} starting URLs`);
  }
  state.runs++;
  const st = state;
  await applyLimits(st, index);
  // pages before PDFs, and forms, fee schedules, FAQs and guides before other PDFs, so each run reaches the
  // files visitors ask about first; links found during the run are still visited in the order found
  st.frontier = st.frontier
    .map((u, i) => ({ u, i, p: !/\.pdf([?#]|$)/i.test(u) ? 0 : KEY_FILE.test(u) ? 1 : 2 }))
    .sort((a, b) => a.p - b.p || a.i - b.i)
    .map((x) => x.u);
  const known = new Set<string>([...Object.keys(st.docs), ...st.frontier.map(urlKey)]);
  const boiler = new Set(st.boilerplate ?? []);
  let boilerReady = Boolean(st.boilerplate);
  const sample: ParsedHtml[] = [];

  const deadline = Date.now() + MAX_MINUTES * 60_000;
  let cursor = 0;
  let inFlight = 0;
  let processed = 0;
  let stopReason: string | undefined;
  const inFlightUrls = new Set<string>();
  let docCount = Object.keys(st.docs).length;
  let pending: Pending[] = [];
  let pendingKeys = new Set<string>();

  const enqueue = (raw: string) => {
    if (!isReadableLink(raw, hosts)) return;
    if (skip.some((r) => r.test(raw))) return;
    const k = urlKey(raw);
    if (known.has(k)) return;
    known.add(k);
    st.frontier.push(raw.replace("://waterboards.ca.gov", "://www.waterboards.ca.gov"));
  };

  let lastIndexCheck = 0;
  /** Backpressure: when Upstash has a large indexing backlog, wait for it to drain before sending more. */
  const waitForIndex = async () => {
    if (!index || Date.now() - lastIndexCheck < 15_000) return;
    lastIndexCheck = Date.now();
    for (let waited = 0; waited < MAX_BUSY_MS; waited += 20_000) {
      try {
        const info = await index.info();
        if (info.pendingVectorCount < MAX_PENDING) return;
        console.log(`[crawl] Upstash is still indexing ${info.pendingVectorCount.toLocaleString()} passages; pausing 20 s`);
      } catch {
        console.log("[crawl] Upstash did not answer; pausing 20 s");
      }
      await sleep(20_000);
    }
  };

  const requeue = (keys: Set<string>) => {
    for (const k of keys) {
      const d = st.docs[k];
      if (d) {
        st.passages -= d.chunks;
        delete st.docs[k];
        docCount--;
        st.frontier.push(d.url);
      }
    }
  };

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    const keys = pendingKeys;
    pending = [];
    pendingKeys = new Set();
    if (!index) return;
    for (let i = 0; i < batch.length; i += UPSERT_BATCH) {
      const part = batch.slice(i, i + UPSERT_BATCH);
      await waitForIndex();
      let busyMs = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          await index.upsert(part);
          break;
        } catch (e) {
          const msg = String(e).slice(0, 160);
          const auth = /unauthori[sz]ed|forbidden|invalid auth|read.?only|permission/i.test(msg);
          if (auth || busyMs >= MAX_BUSY_MS) {
            requeue(keys);
            stopReason = auth
              ? `Upstash refused the token (${msg}); check UPSTASH_VECTOR_REST_TOKEN`
              : `Upstash was unavailable for ${Math.round(busyMs / 60_000)} minutes; the next run will continue`;
            throw new IndexWriteError(stopReason);
          }
          // usually Upstash catching up on indexing: back off, up to 2 minutes at a time
          const wait = Math.min(120_000, 5_000 * 2 ** attempt);
          console.warn(`[crawl] Upstash busy (${msg}); waiting ${Math.round(wait / 1000)} s`);
          await sleep(wait);
          busyMs += wait;
          lastIndexCheck = 0;
          await waitForIndex();
        }
      }
    }
  };

  const store = async (url: string, key: string, title: string, format: "html" | "pdf", date: string | undefined, passages: Passage[]) => {
    passages = passages.filter((p) => p.text.replace(/\W/g, "").length > 20).slice(0, cfg.maxPassagesPerDoc);
    const sid = docId(key);
    const prev = st.docs[key]?.chunks ?? 0;
    passages.forEach((p, i) => {
      pending.push({
        id: `${sid}-${i + 1}`,
        data: toVectorData({ title, heading: p.heading, text: p.text }),
        metadata: { url, title, heading: p.heading, page: p.page, format, date, sourceId: sid },
      });
    });
    pendingKeys.add(key);
    if (index && prev > passages.length) {
      const stale = Array.from({ length: prev - passages.length }, (_, i) => `${sid}-${passages.length + i + 1}`);
      await index.delete(stale).catch(() => undefined);
    }
    st.passages += passages.length - prev;
    const doc: CrawlDoc = { url, status: passages.length ? "ok" : "error", chunks: passages.length, title, date, format, at: new Date().toISOString() };
    if (!passages.length) doc.error = format === "pdf" ? "no text layer" : "no text extracted";
    if (!st.docs[key]) docCount++;
    st.docs[key] = doc;
    if (pending.length >= UPSERT_BATCH) await flush();
  };

  const storeHtml = async (p: ParsedHtml) => {
    const passages = chunkBlocks(p.blocks.filter((b) => b.level || !boiler.has(b.text)));
    await store(p.url, p.key, p.title ?? p.url, "html", p.date, passages);
  };

  const finishSample = async () => {
    if (boilerReady) return;
    for (const t of boilerplateSet(sample.map((s) => s.blocks), 10, 0.25)) boiler.add(t);
    st.boilerplate = [...boiler];
    boilerReady = true;
    console.log(`[crawl] ${boiler.size} repeated site-wide text blocks will be dropped as boilerplate`);
    for (const s of sample.splice(0)) await storeHtml(s);
  };

  const save = async (finished: boolean) => {
    try {
      await flush();
    } catch (e) {
      if (!(e instanceof IndexWriteError)) throw e;
    }
    st.frontier = st.frontier.slice(cursor);
    cursor = 0;
    st.updatedAt = new Date().toISOString();
    // pages still being downloaded go back at the front of the saved queue, so a killed run loses nothing
    const snapshot: CrawlState = { ...st, frontier: [...inFlightUrls, ...st.frontier] };
    writeCrawlState(snapshot, summarize(snapshot, finished, stopReason), STATE_DIR);
  };

  const shouldStop = () => {
    if (stopReason) return true;
    if (Date.now() > deadline) stopReason = `time limit (${MAX_MINUTES} min) for this run`;
    else if (docCount >= cfg.maxDocs) stopReason = `reached maxDocs (${cfg.maxDocs})`;
    else if (st.passages >= cfg.maxPassages) stopReason = `reached maxPassages (${cfg.maxPassages})`;
    else if (fetcher.blocked) stopReason = "waterboards.ca.gov kept refusing requests; the next run will retry";
    return Boolean(stopReason);
  };

  let saving: Promise<void> = Promise.resolve();
  const worker = async () => {
    while (!shouldStop()) {
      if (cursor >= st.frontier.length) {
        if (inFlight === 0) return;
        await sleep(500);
        continue;
      }
      const url = st.frontier[cursor++];
      const key = urlKey(url);
      if (st.docs[key]) continue;
      inFlight++;
      inFlightUrls.add(url);
      try {
        const doc = await fetcher.fetchDocument(url);
        known.add(urlKey(doc.finalUrl));
        if (doc.kind === "pdf") {
          const pages = doc.pdfPages ?? [];
          const title = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? url).replace(/\.pdf$/i, "").replace(/[-_]+/g, " ");
          const firstLine = (pages[0] ?? "")
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 8 && l.length < 140 && !/^(page \d|rev\.?|revised|\d)/i.test(l));
          await store(url, key, firstLine ?? title, "pdf", findPdfDate(pages), chunkPdfPages(pages));
        } else {
          const html = doc.html ?? "";
          const parsed = htmlToBlocks(html);
          for (const l of extractLinks(html, doc.finalUrl)) enqueue(l.url);
          const p: ParsedHtml = { url, key, title: parsed.title, date: parsed.pageLastUpdated, blocks: parsed.blocks };
          if (boilerReady) await storeHtml(p);
          else {
            sample.push(p);
            if (!st.docs[key]) docCount++;
            st.docs[key] = { url, status: "ok", chunks: 0, at: new Date().toISOString(), format: "html" }; // placeholder until stored
            if (sample.length >= BOILERPLATE_SAMPLE) await finishSample();
          }
        }
      } catch (e) {
        if (e instanceof IndexWriteError) break; // those pages went back in the queue
        if (!st.docs[key]) docCount++;
        st.docs[key] = { url, status: "error", chunks: 0, error: String((e as Error)?.message ?? e).slice(0, 160), at: new Date().toISOString() };
      } finally {
        inFlight--;
        inFlightUrls.delete(url);
      }
      processed++;
      if (processed % SAVE_EVERY === 0) {
        const s = summarize(st, false);
        console.log(
          `[crawl] ${processed} this run | ${s.docsOk} pages and files OK, ${s.docsFailed} failed | ${st.passages.toLocaleString()} passages | ${st.frontier.length - cursor} to go`,
        );
        if (boilerReady) saving = saving.then(() => save(false));
        await saving;
      }
    }
  };

  const onSignal = () => {
    stopReason = "stopped by signal";
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log(`[crawl] run ${st.runs}: ${st.frontier.length} URLs queued, ${Object.keys(st.docs).length} already done, up to ${MAX_MINUTES} min${DRY ? " (dry run)" : ""}`);
  await Promise.all(Array.from({ length: cfg.concurrency }, worker));
  await finishSample();
  await saving;
  const finished = !stopReason && cursor >= st.frontier.length;
  await save(finished);
  const s = summarize(st, finished, stopReason);
  console.log(
    `[crawl] ${finished ? "finished" : `paused: ${stopReason}`} | ${s.docsOk} pages and files OK, ${s.docsFailed} failed | ${st.passages.toLocaleString()} passages | ${s.frontier} still queued`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
