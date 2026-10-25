/**
 * Builds the data store snapshot in data/corpus/.
 *
 * What goes in is set by data/data-store.json:
 *   - "tiers": which inventory tiers from data/sources.csv to download (the guidesheet setting is ["1"])
 *   - "followLinks": also download Water Board pages and PDFs linked from those pages (one click away,
 *     same website only), up to "maxLinkedDocs"
 * Nothing else is fetched: no search engines and no other websites.
 *
 *   npm run corpus                 fetch everything and rebuild
 *   npm run corpus -- --if-missing skip if a snapshot already exists (used by the Vercel build)
 *   npm run corpus -- --soft       do not fail when nothing can be downloaded
 *   npm run corpus -- --cache      reuse files already downloaded to .cache/raw (faster rebuilds)
 *   npm run corpus -- --only S004,S172 --no-links
 *   (testing) --sources other.csv --out some/dir
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getDocumentProxy } from "unpdf";
import { describeConfig, readDataStoreConfig } from "../lib/dataStoreConfig";
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
import { readSources } from "../lib/sources";
import type { Chunk, CorpusMeta, Source } from "../lib/types";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const OUT = opt("--out") ?? path.join(process.cwd(), "data", "corpus");
const RAW = path.join(process.cwd(), ".cache", "raw");
const CONCURRENCY = Number(opt("--concurrency") ?? 8);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 (Water Boards assistant prototype, UC Berkeley student project)";
const config = readDataStoreConfig();
const MAX_PDF_BYTES = config.maxPdfMegabytes * 1024 * 1024;

interface Parsed {
  source: Source;
  kind?: "html" | "pdf";
  blocks?: Block[];
  pdfPages?: string[];
  links?: { url: string; text: string }[];
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fatal = (msg: string) => Object.assign(new Error(msg), { fatal: true });

async function download(url: string): Promise<{ buf: Buffer; type: string; finalUrl: string }> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 90_000);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: ctl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/pdf,application/xhtml+xml,*/*;q=0.8" },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw fatal(`HTTP ${res.status}`);
      const size = Number(res.headers.get("content-length") ?? 0);
      if (size > MAX_PDF_BYTES) {
        ctl.abort();
        throw fatal(`too large (${Math.round(size / 1e6)} MB)`);
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

/** Text of each PDF page, up to maxPdfPages. */
async function pdfToPages(buf: Buffer): Promise<{ pages: string[]; total: number }> {
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const total = doc.numPages;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(total, config.maxPdfPages); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof item.str !== "string") continue;
      text += item.str + (item.hasEOL ? "\n" : "");
    }
    pages.push(text);
  }
  await doc.cleanup().catch(() => undefined);
  return { pages, total };
}

async function fetchAndParse(s: Source, withLinks: boolean): Promise<Parsed> {
  const key = crypto.createHash("sha1").update(s.url).digest("hex").slice(0, 16);
  const cacheFile = path.join(RAW, `${key}.bin`);
  const cacheMeta = path.join(RAW, `${key}.json`);
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
      if (buf.length > MAX_PDF_BYTES) throw fatal(`too large (${Math.round(buf.length / 1e6)} MB)`);
      const { pages, total } = await pdfToPages(buf);
      s.format = "pdf";
      s.pages = total;
      s.pageLastUpdated = findPdfDate(pages);
      return { source: s, kind: "pdf", pdfPages: pages };
    }
    if (!/html|text\/plain|xml/i.test(type) && type) throw fatal(`not a page or PDF (${type.split(";")[0]})`);
    const html = buf.toString("utf8");
    const parsed = htmlToBlocks(html);
    s.format = "html";
    s.pageLastUpdated = parsed.pageLastUpdated;
    if (parsed.title && parsed.title.length < 160) s.title = parsed.title;
    return {
      source: s,
      kind: "html",
      blocks: parsed.blocks,
      links: withLinks ? extractLinks(html, finalUrl || s.url) : undefined,
    };
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

async function fetchAll(list: Source[], label: string, withLinks: boolean): Promise<Parsed[]> {
  let done = 0;
  return pool(list, CONCURRENCY, async (s) => {
    const r = await fetchAndParse(s, withLinks);
    done++;
    if (done % 25 === 0 || done === list.length || r.error) {
      const what = r.error ? `ERROR ${r.error}` : r.kind;
      console.log(`  [${label} ${String(done).padStart(4)}/${list.length}] ${s.id} ${what}  ${s.url}`);
    }
    return r;
  });
}

function fileTitle(url: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? url);
  return last.replace(/\.(pdf|s?html?)$/i, "").replace(/[-_]+/g, " ").trim() || url;
}

async function main() {
  if (flag("--if-missing") && fs.existsSync(path.join(OUT, "meta.json"))) {
    console.log("[corpus] snapshot already exists in data/corpus, skipping (run `npm run corpus` to rebuild)");
    return;
  }
  let seeds = readSources(opt("--sources")).filter((s) => config.tiers.includes(s.tier ?? "1") || Boolean(opt("--sources")));
  const only = opt("--only")?.split(",");
  if (only) seeds = seeds.filter((s) => only.includes(s.id));
  const followLinks = config.followLinks && !flag("--no-links") && !only;

  // Fail fast when the site cannot be reached at all (no network, blocked host).
  if (!flag("--cache")) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      await fetch(seeds[0].url, { method: "GET", signal: ctl.signal, headers: { "user-agent": UA } });
      clearTimeout(timer);
    } catch (e) {
      console.error(`[corpus] cannot reach ${new URL(seeds[0].url).host}: ${String((e as Error)?.message ?? e)}`);
      console.error("[corpus] build the data store on a machine with internet access (npm run corpus), or use the GitHub Action.");
      process.exit(flag("--soft") ? 0 : 1);
    }
  }

  console.log(`[corpus] data store: ${describeConfig(config)}`);
  console.log(`[corpus] step 1: ${seeds.length} inventory pages and files`);
  const parsed = await fetchAll(seeds, "inventory", followLinks);

  if (followLinks) {
    const hosts = new Set<string>();
    for (const s of seeds) {
      const h = new URL(s.url).hostname.toLowerCase();
      hosts.add(h);
      if (h === "www.waterboards.ca.gov") hosts.add("waterboards.ca.gov");
    }
    const seen = new Set<string>();
    for (const s of seeds) {
      seen.add(urlKey(s.url));
      if (s.finalUrl) seen.add(urlKey(s.finalUrl));
    }
    const linked: Source[] = [];
    for (const p of parsed) {
      for (const l of p.links ?? []) {
        if (linked.length >= config.maxLinkedDocs) break;
        if (!isReadableLink(l.url, hosts)) continue;
        const k = urlKey(l.url);
        if (seen.has(k)) continue;
        seen.add(k);
        const url = l.url.replace("://waterboards.ca.gov", "://www.waterboards.ca.gov");
        const anchor = l.text && l.text.length >= 4 && l.text.length <= 120 && !/^(click here|here|link|pdf|download|more)$/i.test(l.text) ? l.text : "";
        linked.push({
          id: `L${String(linked.length + 1).padStart(4, "0")}`,
          url,
          title: anchor || fileTitle(url),
          format: /\.pdf$/i.test(new URL(url).pathname) ? "pdf" : "html",
          section: p.source.section,
          menuPath: "",
          inventoryTab: "",
          inventoryLastUpdated: "",
          tier: "linked",
          discoveredFrom: p.source.id,
        });
      }
    }
    console.log(`[corpus] step 2: ${linked.length} more Water Board pages and files linked from those pages`);
    parsed.push(...(await fetchAll(linked, "linked", false)));
  }

  // Text repeated across many pages (menus, footers) is dropped.
  const boiler = boilerplateSet(parsed.filter((p) => p.kind === "html").map((p) => p.blocks ?? []));
  console.log(`[corpus] ${boiler.size} repeated site-wide text blocks dropped as boilerplate`);

  const chunks: Chunk[] = [];
  const textDir = path.join(OUT, "text");
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(textDir, { recursive: true });

  for (const p of parsed) {
    const s = p.source;
    if (p.error || !p.kind) {
      s.status = "error";
      s.error = p.error ?? "unknown";
      continue;
    }
    let passages: Passage[] =
      p.kind === "html" ? chunkBlocks((p.blocks ?? []).filter((b) => b.level || !boiler.has(b.text))) : chunkPdfPages(p.pdfPages ?? []);
    passages = passages.filter((x) => x.text.replace(/\W/g, "").length > 20);
    s.status = passages.length ? "ok" : "error";
    if (!passages.length) s.error = p.kind === "pdf" ? "no text layer (scanned PDF?)" : "no text extracted";
    s.chars = passages.reduce((n, x) => n + x.text.length, 0);
    s.chunks = passages.length;
    passages.forEach((x, i) => {
      chunks.push({
        id: `${s.id}-${String(i + 1).padStart(4, "0")}`,
        sourceId: s.id,
        url: s.url,
        title: s.title,
        section: s.section,
        format: s.format,
        page: x.page,
        heading: x.heading,
        text: x.text,
      });
    });
    const dump = passages.map((x) => `${x.page ? `[page ${x.page}] ` : ""}${x.heading ? `## ${x.heading}\n` : ""}${x.text}`).join("\n\n");
    fs.writeFileSync(path.join(textDir, `${s.id}.txt`), `${s.title}\n${s.url}\nDate printed: ${s.pageLastUpdated ?? "none found"}\n\n${dump}\n`);
  }

  const sources = parsed.map((p) => p.source);
  const ok = sources.filter((s) => s.status === "ok");
  const meta: CorpusMeta = {
    builtAt: new Date().toISOString(),
    sourceCount: sources.length,
    okCount: ok.length,
    chunkCount: chunks.length,
    description: describeConfig({ ...config, followLinks }),
    sources,
  };
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(OUT, "chunks.json.gz"), zlib.gzipSync(JSON.stringify(chunks), { level: 9 }));

  const failed = sources.filter((s) => s.status !== "ok");
  const byTier = (t: string) => ok.filter((s) => (s.tier ?? "1") === t).length;
  console.log(
    `[corpus] ${ok.length}/${sources.length} sources OK (Tier 1: ${byTier("1")}, Tier 2: ${byTier("2")}, Tier 3: ${byTier("3")}, linked: ${byTier("linked")}), ${chunks.length} passages`,
  );
  if (failed.length) {
    console.log(`[corpus] could not use ${failed.length}:`);
    for (const s of failed.slice(0, 60)) console.log(`  ${s.id} ${s.error}  ${s.url}`);
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
