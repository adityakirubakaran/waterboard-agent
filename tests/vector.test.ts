import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion, mergeHits, type ModelCall } from "../lib/agent";
import type { Hit } from "../lib/retrieval";
import { docId, fromVectorData, toVectorData, type VectorSearch } from "../lib/vectorStore";
import { tinyCorpus } from "./helpers";

const corpus = tinyCorpus();
const hit = (id: string, url: string, text: string, extra: Partial<Hit["chunk"]> = {}): Hit => ({
  chunk: { id, sourceId: id.split("-")[0], url, title: `Title ${id}`, section: "", format: "html", text, ...extra },
  score: 0,
});

test("vector data keeps the passage text intact", () => {
  const data = toVectorData({ title: "Fee list", heading: "Exam fees", text: "Grade 2: $81\nGrade 3: $125" });
  assert.equal(data.split("\n")[0], "Fee list > Exam fees");
  assert.equal(fromVectorData(data), "Grade 2: $81\nGrade 3: $125");
  assert.equal(docId("www.waterboards.ca.gov/a"), docId("www.waterboards.ca.gov/a"));
  assert.equal(docId("x").length, 16);
});

test("results from the snapshot and the full-site index are merged without duplicates", () => {
  const a = [hit("A-1", "https://x/a", "alpha"), hit("B-1", "https://x/b", "beta")];
  const b = [hit("zz-1", "https://x/b", "beta"), hit("C-1", "https://x/c", "gamma")];
  const merged = mergeHits([a, b], 10);
  assert.deepEqual(merged.map((h) => h.chunk.url), ["https://x/b", "https://x/a", "https://x/c"]);
});

test("at most three passages per page after merging", () => {
  const many = Array.from({ length: 6 }, (_, i) => hit(`P-${i}`, "https://x/p", `text ${i}`));
  assert.equal(mergeHits([many], 10).length, 3);
});

test("the agent cites a passage that came from the full-site index, with its date", async () => {
  const fromIndex = hit("abc-1", "https://www.waterboards.ca.gov/public_notices/petitions/water_quality/wqpetition_instr.html", "The petition must be received within 30 days of the regional board's action.", { date: "06/01/2015" });
  const search: VectorSearch = async () => [fromIndex];
  let excerpts = "";
  const model: ModelCall = async (_s, contents) => {
    excerpts = contents[contents.length - 1].text;
    const n = excerpts.split("[E").findIndex((p) => p.includes("30 days"));
    return { text: JSON.stringify({ status: "answered", answer: "30 days from the regional board's action.", citations: [`E${n}`] }) };
  };
  const r = await answerQuestion([{ role: "user", content: "How long do I have to appeal a regional board decision?" }], {
    corpus,
    model,
    rewrite: false,
    vectorSearch: search,
  });
  assert.equal(r.status, "answered");
  assert.equal(r.sources[0].url, fromIndex.chunk.url);
  assert.match(excerpts, /date printed on it: 06\/01\/2015/);
});

test("a failing full-site index falls back to the snapshot", async () => {
  const r = await answerQuestion([{ role: "user", content: "Can I pay by credit card?" }], {
    corpus,
    rewrite: false,
    vectorSearch: async () => {
      throw new Error("network down");
    },
    model: async () => ({ text: JSON.stringify({ status: "answered", answer: "No.", citations: ["E1"] }) }),
  });
  assert.equal(r.status, "answered");
});

test("pasted Upstash settings are cleaned up", async () => {
  const { cleanSetting } = await import("../lib/vectorStore");
  assert.equal(cleanSetting(" my-index-vector.upstash.io ", "UPSTASH_VECTOR_REST_URL"), "https://my-index-vector.upstash.io");
  assert.equal(cleanSetting('UPSTASH_VECTOR_REST_URL="https://x-vector.upstash.io/"', "UPSTASH_VECTOR_REST_URL"), "https://x-vector.upstash.io");
  assert.equal(cleanSetting("'abc123='\n", "UPSTASH_VECTOR_REST_TOKEN"), "abc123=");
  assert.equal(cleanSetting(undefined, "UPSTASH_VECTOR_REST_URL"), "");
});

test("a page only the full-site index has outranks snapshot-only pages", () => {
  const faq = hit("F-1", "https://x/faq.pdf", "faq text");
  const snapshot = [faq, hit("D-1", "https://x/drinking-water-fees.pdf", "drinking water fees"), hit("O-1", "https://x/other", "other")];
  const fullSite = [hit("f1-1", "https://x/faq.pdf", "faq text"), hit("w1-1", "https://x/ww-fee-schedule.pdf", "wastewater fees")];
  const merged = mergeHits([fullSite, snapshot], 10, 3, [1, 0.5]).map((h) => h.chunk.url);
  assert.deepEqual(merged.slice(0, 2), ["https://x/faq.pdf", "https://x/ww-fee-schedule.pdf"]);
});

test("the site's own words are added to the search", async () => {
  const { officialTermsQuery } = await import("../lib/queryTerms");
  const q = officialTermsQuery("How much does it cost to take the test for a grade 2 wastewater operator license?") ?? "";
  for (const w of ["examination", "certificate", "fee schedule", "Grade II"]) assert.ok(q.includes(w), w);
  assert.match(officialTermsQuery("How much is the grade 3 drinking water exam?") ?? "", /T3 D3/);
  assert.equal(officialTermsQuery("When is my annual water use report due?"), undefined);
});

test("visitor words for payments, stock ponds, comments and own records get the site's terms", async () => {
  const { officialTermsQuery } = await import("../lib/queryTerms");
  assert.match(officialTermsQuery("How much does it cost to register a small stock pond for my cattle?") ?? "", /Livestock Stockpond/);
  assert.match(officialTermsQuery("Can I pay my drinking water operator renewal fee with a credit card?") ?? "", /ACH/);
  assert.match(officialTermsQuery("How do I send the State Water Board a written comment about something on its meeting agenda?") ?? "", /commentletters/);
  assert.match(officialTermsQuery("Our city has a Clean Water SRF loan. How much do we still owe on it?") ?? "", /contact phone email/);
});

test("the recent-files search covers this year and last", async () => {
  const { recentFilter } = await import("../lib/vectorStore");
  assert.equal(recentFilter(new Date("2026-10-26T12:00:00Z")), "url GLOB '*2026*' OR url GLOB '*2025*'");
});

test("a grade that does not exist asks the search for the program contact", async () => {
  const { officialTermsQuery } = await import("../lib/queryTerms");
  assert.match(officialTermsQuery("How much does it cost to take the test for a grade 6 wastewater operator license?") ?? "", /program contact/);
});
