/**
 * Builds data/sources.csv (the data store manifest) from the team's content inventory.
 * Keeps ONLY rows whose "Suggested tier" is 1. Tier 2 and 3 rows, including outdated files the team
 * flagged, never enter the data store.
 *
 *   npm run sources            (reads data/inventory/content_inventory_combined.csv)
 *   npm run sources -- path/to/other_export.csv
 */
import fs from "node:fs";
import path from "node:path";
import { parseCsv, toCsv } from "../lib/csv";

const input = process.argv[2] ?? path.join("data", "inventory", "content_inventory_combined.csv");
const output = path.join("data", "sources.csv");

/** Tier 1 rows whose URL cell is blank in the export, with the page the row describes. */
const URL_FIXES: Record<string, string> = {
  "Regulation for Measuring and Reporting the Diversion of Water (Water Measurement)":
    "https://www.waterboards.ca.gov/waterrights/water_issues/programs/diversion_use/water_measurement.html",
};

export function normalizeUrl(raw: string): string {
  const u = raw.trim();
  if (!u) return "";
  const parsed = new URL(u.startsWith("http") ? u : `https://${u}`);
  parsed.protocol = "https:";
  if (parsed.hostname === "waterboards.ca.gov") parsed.hostname = "www.waterboards.ca.gov";
  parsed.hash = "";
  return parsed.toString();
}

function main() {
  const text = fs.readFileSync(input, "utf8").replace(/^﻿/, "");
  const rows = parseCsv(text);
  const tier1 = rows.filter((r) => (r["Suggested tier"] ?? "").trim() === "1");
  const byUrl = new Map<string, { title: string; format: string; menu: string; consultant: string; updated: string; n: number }>();
  const problems: string[] = [];
  for (const r of tier1) {
    const name = (r["Name"] ?? "").trim();
    let url = normalizeUrl(r["URL"] ?? "");
    if (!url && URL_FIXES[name]) {
      url = normalizeUrl(URL_FIXES[name]);
      problems.push(`blank URL filled in for "${name}" -> ${url}`);
    }
    if (!url) {
      problems.push(`SKIPPED (no URL): "${name}"`);
      continue;
    }
    const isPdf = /\.pdf$/i.test(new URL(url).pathname) || /pdf/i.test(r["Format"] ?? "");
    const prev = byUrl.get(url);
    if (prev) {
      prev.n++;
      continue;
    }
    byUrl.set(url, {
      title: name || url,
      format: isPdf ? "pdf" : "html",
      menu: (r["Menu path"] ?? "").trim(),
      consultant: (r["Consultant"] ?? "").trim(),
      updated: (r["Last updated"] ?? "").trim(),
      n: 1,
    });
  }
  const out = [...byUrl].map(([url, v], i) => ({
    id: `S${String(i + 1).padStart(3, "0")}`,
    url,
    title: v.title,
    format: v.format,
    section: v.menu.split(">")[0].trim(),
    menu_path: v.menu,
    inventory_tab: v.consultant,
    inventory_last_updated: v.updated,
    inventory_rows: v.n,
  }));
  fs.writeFileSync(output, toCsv(out, ["id", "url", "title", "format", "section", "menu_path", "inventory_tab", "inventory_last_updated", "inventory_rows"]));
  console.log(`${rows.length} inventory rows, ${tier1.length} Tier 1 rows -> ${out.length} unique pages and files in ${output}`);
  console.log(`  ${out.filter((o) => o.format === "pdf").length} PDFs, ${out.filter((o) => o.format === "html").length} web pages`);
  for (const p of problems) console.log("  note:", p);
}

if (process.argv[1] && /make-sources/.test(process.argv[1])) main();
