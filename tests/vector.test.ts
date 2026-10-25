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
