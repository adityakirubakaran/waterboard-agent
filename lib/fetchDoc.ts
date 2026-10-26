/**
 * Polite downloading of Water Board pages and PDFs, shared by the snapshot builder and the full-site
 * crawler. Requests are spaced out, and when the site starts answering 403/429 (its bot protection),
 * everyone backs off. Used only by scripts, never by the running app.
 */
import { getDocumentProxy } from "unpdf";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 (Water Boards assistant prototype, UC Berkeley student project)";

export interface FetcherOptions {
  /** Minimum gap between request starts, in ms. */
  gapMs: number;
  maxPdfBytes: number;
  maxPdfPages: number;
  /** After this many 403/429 answers in a row: "stop" fails every later request; "pause" waits pauseMs, up to maxPauses times. */
  maxRefusalsInARow: number;
  onBlocked: "stop" | "pause";
  pauseMs?: number;
  maxPauses?: number;
  log?: (msg: string) => void;
}

export interface FetchedDoc {
  kind: "html" | "pdf";
  finalUrl: string;
  html?: string;
  pdfPages?: string[];
  pdfTotalPages?: number;
}

/** Longest we spend reading one PDF's text. */
const PDF_READ_MS = 60_000;

export class FatalFetchError extends Error {
  fatal = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Fetcher {
  private nextSlot = 0;
  private coolUntil = 0;
  private refusalsInARow = 0;
  private pauses = 0;
  /** True once the site has refused us for good in this run. */
  blocked = false;

  constructor(private o: FetcherOptions) {}

  private async throttle(): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.nextSlot, this.coolUntil);
    this.nextSlot = start + this.o.gapMs;
    if (start > now) await sleep(start - now);
  }

  private refused(attempt: number): void {
    this.refusalsInARow++;
    this.coolUntil = Math.max(this.coolUntil, Date.now() + 20_000 * (attempt + 1));
    if (this.refusalsInARow < this.o.maxRefusalsInARow) return;
    if (this.o.onBlocked === "pause" && this.pauses < (this.o.maxPauses ?? 3)) {
      this.pauses++;
      this.refusalsInARow = 0;
      this.coolUntil = Date.now() + (this.o.pauseMs ?? 10 * 60_000);
      this.o.log?.(`[fetch] the site keeps refusing requests; pausing ${Math.round((this.o.pauseMs ?? 600_000) / 60_000)} min (pause ${this.pauses})`);
    } else {
      this.blocked = true;
    }
  }

  async download(url: string): Promise<{ buf: Buffer; type: string; finalUrl: string }> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.blocked) throw new FatalFetchError("skipped: the site kept refusing requests");
      await this.throttle();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 90_000);
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: ctl.signal,
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/pdf,application/xhtml+xml,*/*;q=0.8" },
        });
        if (res.status === 403 || res.status === 429) {
          this.refused(attempt);
          throw new Error(`HTTP ${res.status}`);
        }
        this.refusalsInARow = 0;
        this.pauses = 0;
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new FatalFetchError(`HTTP ${res.status}`);
        const size = Number(res.headers.get("content-length") ?? 0);
        if (size > this.o.maxPdfBytes) {
          ctl.abort();
          throw new FatalFetchError(`too large (${Math.round(size / 1e6)} MB)`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, type: res.headers.get("content-type") ?? "", finalUrl: res.url || url };
      } catch (e) {
        last = e;
        if ((e as { fatal?: boolean }).fatal) break;
        if (!/HTTP (403|429)/.test(String((e as Error)?.message))) await sleep(1500 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }

  /**
   * Text of each PDF page, up to maxPdfPages. A damaged page is left blank instead of failing the file, and a
   * file that takes over a minute to read is given up on, so one bad PDF can't stall or crash a crawl.
   */
  async pdfToPages(buf: Buffer): Promise<{ pages: string[]; total: number }> {
    const doc = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 }); // errors only, no font warnings
    const read = async () => {
      const total = doc.numPages;
      const pages: string[] = [];
      for (let i = 1; i <= Math.min(total, this.o.maxPdfPages); i++) {
        try {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          let text = "";
          for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
            if (typeof item.str !== "string") continue;
            text += item.str + (item.hasEOL ? "\n" : "");
          }
          pages.push(text);
        } catch {
          pages.push("");
        }
      }
      return { pages, total };
    };
    let timer: NodeJS.Timeout | undefined;
    const tooSlow = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FatalFetchError("PDF took too long to read")), PDF_READ_MS);
    });
    try {
      return await Promise.race([read(), tooSlow]);
    } finally {
      clearTimeout(timer);
      await doc.cleanup().catch(() => undefined);
    }
  }

  /** Turn downloaded bytes into a page or PDF text. Throws for other file types. */
  async parse(buf: Buffer, type: string, finalUrl: string): Promise<FetchedDoc> {
    const isPdf = /pdf/i.test(type) || buf.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf) {
      if (buf.length > this.o.maxPdfBytes) throw new FatalFetchError(`too large (${Math.round(buf.length / 1e6)} MB)`);
      const { pages, total } = await this.pdfToPages(buf);
      return { kind: "pdf", finalUrl, pdfPages: pages, pdfTotalPages: total };
    }
    if (type && !/html|text\/plain|xml/i.test(type)) throw new FatalFetchError(`not a page or PDF (${type.split(";")[0]})`);
    return { kind: "html", finalUrl, html: buf.toString("utf8") };
  }

  async fetchDocument(url: string): Promise<FetchedDoc> {
    const { buf, type, finalUrl } = await this.download(url);
    return this.parse(buf, type, finalUrl);
  }
}

/** Run fn over items with n workers. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
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
