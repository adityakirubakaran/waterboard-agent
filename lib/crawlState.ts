/** Progress of the full-site crawl, saved in the repo so each GitHub Actions run picks up where the last stopped. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export interface CrawlDoc {
  url: string;
  /** "skipped": stored once, then removed from the index because it is now on the skip list. */
  status: "ok" | "error" | "skipped";
  chunks: number;
  title?: string;
  date?: string;
  format?: "html" | "pdf";
  error?: string;
  at: string;
}

export interface CrawlState {
  version: 1;
  startedAt: string;
  updatedAt: string;
  runs: number;
  /** URLs still to visit, in order (breadth first: inventory pages, then what they link to, and so on). */
  frontier: string[];
  /** Visited pages and files, keyed by urlKey(). */
  docs: Record<string, CrawlDoc>;
  /** Text blocks repeated across many pages (menus, footers), dropped from every page. */
  boilerplate?: string[];
  passages: number;
}

export interface CrawlSummary {
  startedAt: string;
  updatedAt: string;
  runs: number;
  docsOk: number;
  docsFailed: number;
  passages: number;
  frontier: number;
  finished: boolean;
  stoppedBecause?: string;
}

export const CRAWL_DIR = path.join(process.cwd(), "data", "crawl");
const STATE = (dir: string) => path.join(dir, "state.json.gz");
const SUMMARY = (dir: string) => path.join(dir, "summary.json");

export function readCrawlState(dir: string = CRAWL_DIR): CrawlState | null {
  const f = STATE(dir);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
}

export function writeCrawlState(state: CrawlState, summary: CrawlSummary, dir: string = CRAWL_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = STATE(dir) + ".tmp";
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(state), { level: 9 }));
  fs.renameSync(tmp, STATE(dir));
  fs.writeFileSync(SUMMARY(dir), JSON.stringify(summary, null, 2) + "\n");
}

export function readCrawlSummary(dir = CRAWL_DIR): CrawlSummary | null {
  try {
    return JSON.parse(fs.readFileSync(SUMMARY(dir), "utf8"));
  } catch {
    return null;
  }
}

export function summarize(state: CrawlState, finished: boolean, stoppedBecause?: string): CrawlSummary {
  const docs = Object.values(state.docs);
  return {
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    runs: state.runs,
    docsOk: docs.filter((d) => d.status === "ok").length,
    docsFailed: docs.filter((d) => d.status === "error").length,
    passages: state.passages,
    frontier: state.frontier.length,
    finished,
    stoppedBecause,
  };
}
