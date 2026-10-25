import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { parseCsv, toCsv } from "../lib/csv";
import { atoms, atomsFound, combine, AA_CRITERIA, readSuite, splitTurns } from "../lib/evalkit";
import { scrub } from "../lib/questionLog";
import { readSources } from "../lib/sources";
import { normalizeUrl } from "../scripts/make-sources";

test("csv round trip with quotes, commas and newlines", () => {
  const rows = [{ a: 'say "hi", ok', b: "line1\nline2" }];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("question log removes emails, phone numbers and names", () => {
  const s = scrub("My name is Jane Doe, email jane.doe@gmail.com, call 916-555-1234. How do I renew?");
  assert.ok(!s.includes("Jane") && !s.includes("gmail") && !s.includes("555-1234"));
  assert.ok(s.includes("How do I renew?"));
});

test("data store manifest = only Tier 1 inventory rows", () => {
  const inv = parseCsv(fs.readFileSync("data/inventory/content_inventory_combined.csv", "utf8").replace(/^﻿/, ""));
  const tier1 = new Set(inv.filter((r) => r["Suggested tier"].trim() === "1").map((r) => normalizeUrl(r["URL"] ?? "")).filter(Boolean));
  const other = new Set(inv.filter((r) => r["Suggested tier"].trim() !== "1").map((r) => normalizeUrl(r["URL"] ?? "")).filter(Boolean));
  const sources = readSources();
  assert.ok(sources.length >= tier1.size);
  const filled = "https://www.waterboards.ca.gov/waterrights/water_issues/programs/diversion_use/water_measurement.html";
  for (const s of sources) assert.ok(tier1.has(s.url) || s.url === filled, `${s.id} ${s.url} is not a Tier 1 row`);
  // known outdated files that must stay out
  for (const bad of [
    "https://www.waterboards.ca.gov/water_issues/programs/operator_certification/docs/new_fee_for_operators.pdf",
    "https://www.waterboards.ca.gov/waterrights/water_issues/programs/registrations/docs/fees.pdf",
  ]) assert.ok(!sources.some((s) => s.url === bad), `${bad} must not be in the data store`);
  assert.ok(other.size > 0);
});

test("conversation suite cells split into turns and a conditional reply", () => {
  const a = splitTurns('Do I need a storm water permit for my business?\nVisitor\'s reply if asked: "We run a small factory that makes metal parts."');
  assert.deepEqual(a.turns, ["Do I need a storm water permit for my business?"]);
  assert.equal(a.replyIfAsked, "We run a small factory that makes metal parts.");
  const b = splitTurns("Q1: What is direct potable reuse?\nQ2: Is it allowed in California yet?");
  assert.deepEqual(b.turns, ["What is direct potable reuse?", "Is it allowed in California yet?"]);
});

test("both suites load with every test", () => {
  assert.equal(readSuite("eval/suites/answer_accuracy.csv", "answer_accuracy").length, 30);
  const conv = readSuite("eval/suites/conversation.csv", "conversation");
  assert.equal(conv.length, 30);
  assert.ok(conv.find((t) => t.id === "CQ9")!.turns.length === 2);
});

test("fact atoms and matching", () => {
  assert.deepEqual(atoms("$382; call (916) 341-5819 or wwopcertprogram@waterboards.ca.gov").sort(), ["$382", "9163415819", "wwopcertprogram@waterboards.ca.gov"].sort());
  assert.deepEqual(atomsFound(["$30 million", "9163415819"], "up to $30 million; phone 916-341-5819"), ["$30 million", "9163415819"]);
  assert.deepEqual(atomsFound(["$5000"], "a fee of $5,000"), ["$5000"]);
});

test("rubric combine rule", () => {
  assert.equal(combine({ C1: "Pass", C2: "Pass", C3: "Pass", C4: "Pass", C5: "N/A", C6: "Pass" }, AA_CRITERIA).overall, "Pass");
  assert.equal(combine({ C1: "Pass", C2: "Partial", C3: "Pass" }, AA_CRITERIA).overall, "Fail");
  assert.equal(combine({ C1: "Pass", C2: "Pass", C3: "Pass", C4: "Partial" }, AA_CRITERIA).overall, "Partial");
  assert.equal(combine({ C1: "Pass", C2: "Pass", C3: "Pass", C4: "Fail" }, AA_CRITERIA).overall, "Fail");
  assert.equal(combine({ C1: "Pass", C6: "Fail" }, AA_CRITERIA).overall, "Partial");
  assert.deepEqual(combine({ C1: "Fail" }, AA_CRITERIA).critical, ["C1 Correct (Fail)"]);
});
