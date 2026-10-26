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
  fullSite: FullSiteConfig;
}

export interface FullSiteConfig {
  startUrls: string[];
  useSitemap: boolean;
  maxDocs: number;
  /** Upstash pay-as-you-go allows 2B vectors x dimensions; at 1,536 dimensions that is about 1.3M passages. */
  maxPassages: number;
  /** Long pages (big data tables, huge reports) keep only their first this-many passages. */
  maxPassagesPerDoc: number;
  maxPdfPages: number;
  maxPdfMegabytes: number;
  concurrency: number;
  gapMs: number;
  /** Regular expressions; matching URLs are not crawled, and pages already stored that match leave the index. */
  skipUrlPatterns: string[];
}

const FULL_SITE_DEFAULTS: FullSiteConfig = {
  startUrls: ["https://www.waterboards.ca.gov/"],
  useSitemap: true,
  maxDocs: 60000,
  maxPassages: 1250000,
  maxPassagesPerDoc: 150,
  maxPdfPages: 40,
  maxPdfMegabytes: 25,
  concurrency: 4,
  gapMs: 400,
  skipUrlPatterns: [],
};

const DEFAULTS: DataStoreConfig = {
  tiers: ["1"],
  followLinks: false,
  maxLinkedDocs: 2500,
  maxPdfPages: 80,
  maxPdfMegabytes: 25,
  fullSite: FULL_SITE_DEFAULTS,
};

export function readDataStoreConfig(file = path.join(process.cwd(), "data", "data-store.json")): DataStoreConfig {
  if (!fs.existsSync(file)) return DEFAULTS;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    ...DEFAULTS,
    ...raw,
    tiers: (raw.tiers ?? DEFAULTS.tiers).map(String),
    fullSite: { ...FULL_SITE_DEFAULTS, ...(raw.fullSite ?? {}) },
  };
}

export function describeConfig(c: DataStoreConfig): string {
  const tiers = c.tiers.length === 1 ? `Tier ${c.tiers[0]}` : `Tiers ${c.tiers.join(", ")}`;
  return `${tiers} of the content inventory${c.followLinks ? ", plus Water Board pages and files they link to" : ""}`;
}
