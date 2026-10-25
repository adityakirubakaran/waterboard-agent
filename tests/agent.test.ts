import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion, retrievalQuery, stripUnknownUrls, type ModelCall } from "../lib/agent";
import { CONTACT_PAGE, systemInstruction } from "../lib/prompt";
import { retrieve } from "../lib/retrieval";
import { tinyCorpus } from "./helpers";

const corpus = tinyCorpus();
const reply = (obj: unknown): ModelCall => async () => ({ text: JSON.stringify(obj), model: "mock" });
const opts = (model: ModelCall) => ({ corpus, model, rewrite: false as const, today: "Sunday, October 25, 2026" });

test("rewritten queries are searched alongside the visitor's words", async () => {
  const r = await answerQuestion([{ role: "user", content: "pay renewal" }], {
    ...opts(reply({ status: "answered", answer: "No, cards are not accepted.", citations: ["E1"] })),
    rewrite: async () => ["drinking water operator certification payment credit debit card checking account"],
  });
  assert.equal(r.debug?.retrieved[0].sourceId, "S002");
  assert.match(r.debug?.searchQuery ?? "", /credit debit card/);
});

test("keyword search finds the fee passage for visitor wording", () => {
  const hits = retrieve(corpus, "how much is the test for a grade 2 drinking water operator license");
  assert.ok(hits.slice(0, 2).some((h) => h.chunk.id === "S001-0001"));
});

test("several queries are fused", () => {
  const hits = retrieve(corpus, ["can I pay by card", "construction one acre storm water"], { k: 4 });
  const ids = hits.map((h) => h.chunk.sourceId);
  assert.ok(ids.includes("S002") && ids.includes("S003"));
});

test("at most `perSource` passages come from one file", () => {
  const hits = retrieve(corpus, "grade 2 fee certificate examination", { perSource: 1 });
  assert.equal(hits.filter((h) => h.chunk.sourceId === "S001").length, 1);
});

test("a cited answer links the source, with the PDF page", async () => {
  let seen = "";
  const model: ModelCall = async (system, contents) => {
    seen = contents[contents.length - 1].text;
    assert.ok(system.includes("Answer ONLY from those excerpts"));
    return { text: JSON.stringify({ status: "answered", answer: "The Grade 2 certificate is $100.", citations: ["E1"] }) };
  };
  const r = await answerQuestion([{ role: "user", content: "How much is the grade 2 drinking water certificate?" }], opts(model));
  assert.equal(r.status, "answered");
  assert.ok(seen.includes("[E1]") && seen.includes("Link: https://www.waterboards.ca.gov"));
  const firstUrl = r.sources[0].url;
  assert.ok(firstUrl.startsWith(corpus.chunks[0].url));
  if (r.debug!.retrieved[0].chunkId === "S001-0002") assert.ok(firstUrl.endsWith("#page=2"));
});

test("an 'answered' reply with no valid citation is replaced by a hand-off", async () => {
  const r = await answerQuestion(
    [{ role: "user", content: "How much is the grade 6 exam?" }],
    opts(reply({ status: "answered", answer: "It is $999.", citations: ["E42"] })),
  );
  assert.equal(r.status, "not_found");
  assert.ok(!r.answer.includes("$999"));
  assert.equal(r.debug?.guardrail, "answered-without-citation");
  assert.ok(r.sources.some((s) => s.url === CONTACT_PAGE));
});

test("web addresses that are not in the data store are removed", async () => {
  const r = await answerQuestion(
    [{ role: "user", content: "Can I pay by credit card?" }],
    opts(reply({ status: "answered", answer: "No. Pay from a checking account (see https://evil.example.com/pay).", citations: ["E1"] })),
  );
  assert.ok(!r.answer.includes("evil.example.com"));
  assert.match(r.debug?.guardrail ?? "", /removed-urls/);
  const { text } = stripUnknownUrls(`See ${CONTACT_PAGE} for staff.`, new Set([CONTACT_PAGE]));
  assert.ok(text.includes(CONTACT_PAGE));
});

test("clarifying questions and out-of-scope replies pass through", async () => {
  const c = await answerQuestion(
    [{ role: "user", content: "Do I need a storm water permit for my business?" }],
    opts(reply({ status: "clarify", answer: "What does your business do?", citations: [] })),
  );
  assert.equal(c.status, "clarify");
  assert.equal(c.answer, "What does your business do?");
  const o = await answerQuestion(
    [{ role: "user", content: "Can I break my lease over a leaking tank?" }],
    opts(reply({ status: "out_of_scope", answer: "I can't give legal advice. A tenant lawyer can help.", citations: [] })),
  );
  assert.equal(o.status, "out_of_scope");
  assert.ok(o.sources.length > 0, "out-of-scope replies still point somewhere");
});

test("malformed model output becomes a hand-off, never a crash", async () => {
  const r = await answerQuestion([{ role: "user", content: "hello" }], opts(async () => ({ text: "not json" })));
  assert.equal(r.status, "not_found");
});

test("short follow-ups are searched together with the previous question", () => {
  const q = retrievalQuery([
    { role: "user", content: "I'm grading a 3-acre site in Sacramento. Do I need storm water coverage?" },
    { role: "assistant", content: "Yes..." },
    { role: "user", content: "What if the site were at Lake Tahoe instead?" },
  ]);
  assert.ok(q.includes("3-acre") && q.includes("Lake Tahoe"));
});

test("the system prompt carries today's date and the scope rules", () => {
  const s = systemInstruction("Sunday, October 25, 2026");
  assert.ok(s.includes("Sunday, October 25, 2026"));
  for (const phrase of ["not_found", "clarify", "out_of_scope", "legal advice", "Plain language"]) assert.ok(s.includes(phrase), phrase);
});
