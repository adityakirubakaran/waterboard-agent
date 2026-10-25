import fs from "node:fs";
import path from "node:path";

export interface DataStoreConfig {
  /** Inventory tiers to include ("1", "2", "3"). The guidesheet's setting is ["1"]. */
  tiers: string[];
  /** Also download waterboards.ca.gov pages and PDFs linked from the inventory pages (one click away). */
  followLinks: boolean;
  maxLinkedDocs: number;
  maxPdfPages: number;
  maxPdfMegabytes: number;
}

const DEFAULTS: DataStoreConfig = { tiers: ["1"], followLinks: false, maxLinkedDocs: 2500, maxPdfPages: 80, maxPdfMegabytes: 25 };

export function readDataStoreConfig(file = path.join(process.cwd(), "data", "data-store.json")): DataStoreConfig {
  if (!fs.existsSync(file)) return DEFAULTS;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return { ...DEFAULTS, ...raw, tiers: (raw.tiers ?? DEFAULTS.tiers).map(String) };
}

export function describeConfig(c: DataStoreConfig): string {
  const tiers = c.tiers.length === 1 ? `Tier ${c.tiers[0]}` : `Tiers ${c.tiers.join(", ")}`;
  return `${tiers} of the content inventory${c.followLinks ? ", plus Water Board pages and files they link to" : ""}`;
}
