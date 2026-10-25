/**
 * Builds the data store snapshot in data/corpus/ from data/sources.csv (the Tier 1 rows).
 *
 * It downloads exactly the URLs in sources.csv. It does not follow links, crawl, or search, so a page
 * that is not a Tier 1 row can never end up in the data store.
 *
 *   npm run corpus                 fetch everything and rebuild
 *   npm run corpus -- --if-missing skip if a snapshot already exists (used by the Vercel build)
 *   npm run corpus -- --soft       do not fail when nothing can be downloaded
 *   npm run corpus -- --cache      reuse files already downloaded to .cache/raw (faster rebuilds)
 *   npm run corpus -- --only S004,S172
 *   (testing) --sources other.csv --out some/dir
 */
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { readSources } from "../lib/sources";
import { boilerplateSet, chunkBlocks, chunkPdfPages, findFirstDate, htmlToBlocks, type Block, type Passage } from "../lib/extract";
import type { Chunk, CorpusMeta, Source } from "../lib/types";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = opt("--out") ?? path.join(process.cwd(), "data", "corpus");
const RAW = path.join(process.cwd(), ".cache", "raw");
const CONCURRENCY = Number(opt("--concurrency") ?? 6);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 (Water Boards assistant prototype, UC Berkeley student project)";

interface Fetched {
  source: Source;
  kind?: "html" | "pdf";
  html?: string;
  pdfPages?: string[];
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function download(url: string): Promise<{ buf: Buffer; type: string; finalUrl: string }> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60_000);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: ctl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/pdf,application/xhtml+xml,*/*;q=0.8" },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        (e as Error & { fatal?: boolean }).fatal = true;
        throw e;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, type: res.headers.get("content-type") ?? "", finalUrl: res.url };
    } catch (e) {
      last = e;
      if ((e as { fatal?: boolean }).fatal) break;
      await sleep(1500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

async function pdfToPages(buf: Buffer): Promise<string[]> {
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(doc, { mergePages: false });
  return Array.isArray(text) ? text : [String(text)];
}

async function fetchOne(s: Source): Promise<Fetched> {
  const cacheFile = path.join(RAW, `${s.id}.bin`);
  const cacheMeta = path.join(RAW, `${s.id}.json`);
  try {
    let buf: Buffer;
    let type: string;
    let finalUrl: string;
    if (flag("--cache") && fs.existsSync(cacheFile) && fs.existsSync(cacheMeta)) {
      buf = fs.readFileSync(cacheFile);
      ({ type, finalUrl } = JSON.parse(fs.readFileSync(cacheMeta, "utf8")));
    } else {
      ({ buf, type, finalUrl } = await download(s.url));
      fs.mkdirSync(RAW, { recursive: true });
      fs.writeFileSync(cacheFile, buf);
      fs.writeFileSync(cacheMeta, JSON.stringify({ type, finalUrl, url: s.url }));
    }
    s.fetchedAt = new Date().toISOString();
    if (finalUrl && finalUrl.replace(/\/$/, "") !== s.url.replace(/\/$/, "")) s.finalUrl = finalUrl;
    const isPdf = /pdf/i.test(type) || buf.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf) {
      const pages = await pdfToPages(buf);
      return { source: s, kind: "pdf", pdfPages: pages };
    }
    return { source: s, kind: "html", html: buf.toString("utf8") };
  } catch (e) {
    return { source: s, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function main() {
  if (flag("--if-missing") && fs.existsSync(path.join(OUT, "meta.json"))) {
    console.log("[corpus] snapshot already exists in data/corpus, skipping (run `npm run corpus` to rebuild)");
    return;
  }
  let sources = readSources(opt("--sources"));
  const only = opt("--only")?.split(",");
  if (only) sources = sources.filter((s) => only.includes(s.id));
  // Fail fast when the site cannot be reached at all (no network, blocked host), instead of retrying 184 times.
  if (!flag("--cache")) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      await fetch(sources[0].url, { method: "GET", signal: ctl.signal, headers: { "user-agent": UA } });
      clearTimeout(timer);
    } catch (e) {
      console.error(`[corpus] cannot reach ${new URL(sources[0].url).host}: ${String((e as Error)?.message ?? e)}`);
      console.error("[corpus] build the data store on a machine with internet access (npm run corpus), or use the GitHub Action.");
      process.exit(flag("--soft") ? 0 : 1);
    }
  }
  console.log(`[corpus] fetching ${sources.length} Tier 1 pages and files (no link following)…`);

  let done = 0;
  const fetched = await pool(sources, CONCURRENCY, async (s) => {
    const r = await fetchOne(s);
    done++;
    const what = r.error ? `ERROR ${r.error}` : r.kind === "pdf" ? `pdf, ${r.pdfPages?.length} pages` : "html";
    console.log(`  [${String(done).padStart(3)}/${sources.length}] ${s.id} ${what}  ${s.url}`);
    return r;
  });

  // Extract HTML pages first so text repeated across many pages (menus, footers) can be dropped.
  const htmlParsed = new Map<string, ReturnType<typeof htmlToBlocks>>();
  for (const f of fetched) if (f.kind === "html" && f.html) htmlParsed.set(f.source.id, htmlToBlocks(f.html));
  const boiler = boilerplateSet([...htmlParsed.values()].map((p) => p.blocks));
  console.log(`[corpus] ${boiler.size} repeated site-wide text blocks dropped as boilerplate`);

  const chunks: Chunk[] = [];
  const textDir = path.join(OUT, "text");
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(textDir, { recursive: true });

  for (const f of fetched) {
    const s = f.source;
    if (f.error || !f.kind) {
      s.status = "error";
      s.error = f.error ?? "unknown";
      continue;
    }
    let passages: Passage[] = [];
    if (f.kind === "html") {
      const parsed = htmlParsed.get(s.id)!;
      const blocks: Block[] = parsed.blocks.filter((b) => b.level || !boiler.has(b.text));
      passages = chunkBlocks(blocks);
      s.pageLastUpdated = parsed.pageLastUpdated;
      if (parsed.title && parsed.title.length < 160) s.title = parsed.title;
      s.format = "html";
    } else {
      passages = chunkPdfPages(f.pdfPages ?? []);
      s.pages = f.pdfPages?.length;
      s.pageLastUpdated = findFirstDate(f.pdfPages?.[0] ?? "");
      s.format = "pdf";
    }
    passages = passages.filter((p) => p.text.replace(/\W/g, "").length > 20);
    s.status = passages.length ? "ok" : "error";
    if (!passages.length) s.error = f.kind === "pdf" ? "no text layer (scanned PDF?)" : "no text extracted";
    s.chars = passages.reduce((n, p) => n + p.text.length, 0);
    s.chunks = passages.length;
    passages.forEach((p, i) => {
      chunks.push({
        id: `${s.id}-${String(i + 1).padStart(4, "0")}`,
        sourceId: s.id,
        url: s.url,
        title: s.title,
        section: s.section,
        format: s.format,
        page: p.page,
        heading: p.heading,
        text: p.text,
      });
    });
    const dump = passages
      .map((p) => `${p.page ? `[page ${p.page}] ` : ""}${p.heading ? `## ${p.heading}\n` : ""}${p.text}`)
      .join("\n\n");
    fs.writeFileSync(path.join(textDir, `${s.id}.txt`), `${s.title}\n${s.url}\nDate printed: ${s.pageLastUpdated ?? "none found"}\n\n${dump}\n`);
  }

  const ok = sources.filter((s) => s.status === "ok");
  const meta: CorpusMeta = {
    builtAt: new Date().toISOString(),
    sourceCount: sources.length,
    okCount: ok.length,
    chunkCount: chunks.length,
    sources,
  };
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(OUT, "chunks.json"), JSON.stringify(chunks));

  const failed = sources.filter((s) => s.status !== "ok");
  console.log(`[corpus] ${ok.length}/${sources.length} sources OK, ${chunks.length} passages written to data/corpus/`);
  if (failed.length) {
    console.log("[corpus] could not use:");
    for (const s of failed) console.log(`  ${s.id} ${s.error}  ${s.url}`);
  }
  if (!ok.length) {
    console.error("[corpus] nothing could be downloaded. Is waterboards.ca.gov reachable from this machine?");
    fs.rmSync(path.join(OUT, "meta.json"), { force: true });
    // --soft (used by `npm run build`): let the site deploy anyway; the chat box will say it is not ready.
    process.exit(flag("--soft") ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(flag("--soft") ? 0 : 1);
});
