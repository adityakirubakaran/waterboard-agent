import fs from "node:fs";
import path from "node:path";
import { corpusDir } from "./retrieval";

/** Small summary of the data store snapshot for the page footer. */
export function corpusInfo(): { builtAt?: string; sources: number; ok: number; passages: number; description?: string } | null {
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
