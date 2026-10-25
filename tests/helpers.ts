import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCorpus } from "../lib/retrieval";
import type { Chunk, CorpusMeta, Source } from "../lib/types";

const src = (id: string, url: string, title: string, format: "html" | "pdf", extra: Partial<Source> = {}): Source => ({
  id, url, title, format, section: "Test", menuPath: "Test", inventoryTab: "test", inventoryLastUpdated: "", status: "ok", ...extra,
});

/** A three-source corpus written to a temp folder. */
export function tinyCorpus() {
  const sources = [
    src("S001", "https://www.waterboards.ca.gov/drinking_water/certlic/occupations/documents/opcert/feeslist.pdf", "Drinking Water Operator Certification fee list", "pdf", { pageLastUpdated: "July 2026" }),
    src("S002", "https://www.waterboards.ca.gov/drinking_water/certlic/occupations/DWopcert.html", "Drinking Water Operator Certification", "html", { pageLastUpdated: "10/07/2026" }),
    src("S003", "https://www.waterboards.ca.gov/water_issues/programs/stormwater/construction.html", "Construction Stormwater General Permit", "html"),
  ];
  const chunks: Chunk[] = [
    { id: "S001-0001", sourceId: "S001", url: sources[0].url, title: sources[0].title, section: "Drinking Water", format: "pdf", page: 1, text: "Fee list Rev. 7/2026. Grade 2 examination application fee T2 and D2: $81. Re-examination: $56." },
    { id: "S001-0002", sourceId: "S001", url: sources[0].url, title: sources[0].title, section: "Drinking Water", format: "pdf", page: 2, text: "Certificate fees: Grade 2 certificate $100. Dual certified $75." },
    { id: "S002-0001", sourceId: "S002", url: sources[1].url, title: sources[1].title, section: "Drinking Water", format: "html", heading: "Payments", text: "The program does not accept credit or debit cards. You can pay online from a checking or savings account. Contact dwopcertprogram@waterboards.ca.gov or (916) 449-5611." },
    { id: "S003-0001", sourceId: "S003", url: sources[2].url, title: sources[2].title, section: "Water Quality", format: "html", text: "Construction projects that disturb one or more acres of soil must obtain coverage under the Construction Stormwater General Permit through SMARTS." },
  ];
  const meta: CorpusMeta = { builtAt: "2026-10-20T00:00:00Z", sourceCount: 3, okCount: 3, chunkCount: chunks.length, sources };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-corpus-"));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, "chunks.json"), JSON.stringify(chunks));
  return loadCorpus(dir);
}
