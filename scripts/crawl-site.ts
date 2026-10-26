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
const UPSERT_BATCH = 96;
const BOILERPLATE_SAMPLE = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const skip = cfg.skipUrlPatterns.map((p) => new RegExp(p, "i"));

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
        `[crawl] Upstash index OK: ${info.vectorCount} passages stored, dimension ${info.dimension}${info.denseIndex?.embeddingModel ? `, model ${info.denseIndex.embeddingModel}` : ""}${info.sparseIndex ? ", hybrid" : ""}`,
      );
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

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    const keys = pendingKeys;
    pending = [];
    pendingKeys = new Set();
    if (!index) return;
    for (let i = 0; i < batch.length; i += UPSERT_BATCH) {
      const part = batch.slice(i, i + UPSERT_BATCH);
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        try {
          await index.upsert(part);
          ok = true;
        } catch (e) {
          console.warn(`[crawl] upsert failed (${String(e).slice(0, 160)}); retrying`);
          await sleep(3000 * 2 ** attempt);
        }
      }
      if (!ok) {
        // put those pages back so the next run redoes them, then stop
        for (const k of keys) {
          const d = st.docs[k];
          if (d) {
            st.passages -= d.chunks;
            delete st.docs[k];
            docCount--;
            st.frontier.push(d.url);
          }
        }
        throw new Error("could not write to the Upstash index");
      }
    }
  };

  const store = async (url: string, key: string, title: string, format: "html" | "pdf", date: string | undefined, passages: Passage[]) => {
    passages = passages.filter((p) => p.text.replace(/\W/g, "").length > 20);
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
    await flush();
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
