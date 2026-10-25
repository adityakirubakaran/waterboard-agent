import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./csv";
import type { Source } from "./types";

/** The data store manifest: one row per inventory page or file chosen in data/data-store.json. */
export function readSources(file = path.join(process.cwd(), "data", "sources.csv")): Source[] {
  return parseCsv(fs.readFileSync(file, "utf8")).map((r) => ({
    id: r.id,
    url: r.url,
    title: r.title,
    format: r.format === "pdf" ? "pdf" : "html",
    section: r.section,
    menuPath: r.menu_path,
    inventoryTab: r.inventory_tab,
    inventoryLastUpdated: r.inventory_last_updated,
    tier: r.tier || "1",
  }));
}
