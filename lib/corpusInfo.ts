import fs from "node:fs";
import path from "node:path";
import { readCrawlSummary } from "./crawlState";
import { corpusDir } from "./retrieval";
import { vectorConfigured } from "./vectorStore";

/** Small summary of the data store for the page footer: the full-site index when it is in use, else the snapshot. */
export function corpusInfo(): { builtAt?: string; sources: number; ok: number; passages: number; description?: string } | null {
  const crawl = vectorConfigured() ? readCrawlSummary() : null;
  if (crawl && crawl.docsOk > 0) {
    return {
      builtAt: crawl.updatedAt,
      sources: crawl.docsOk + crawl.docsFailed,
      ok: crawl.docsOk,
      passages: crawl.passages,
      description: crawl.finished ? "a crawl of the whole waterboards.ca.gov site" : "a crawl of waterboards.ca.gov that is still in progress",
    };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(corpusDir(), "meta.json"), "utf8"));
    return {
      builtAt: meta.builtAt,
      sources: meta.sourceCount,
      ok: meta.okCount,
      passages: meta.chunkCount,
      description: meta.description ? String(meta.description).replace(/^T/, "t") : undefined,
    };
  } catch {
    return null;
  }
}
