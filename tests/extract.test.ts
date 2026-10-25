import assert from "node:assert/strict";
import { test } from "node:test";
import { boilerplateSet, chunkBlocks, chunkPdfPages, findFirstDate, findPageLastUpdated, htmlToBlocks } from "../lib/extract";

const HTML = `<html><head><title>Fees | Water Boards</title></head><body>
<header class="global-header"><nav><a>Home</a></nav></header>
<main><h1>Operator Fees</h1><p>Intro text about the fees.</p>
<h2>Exam fees</h2>
<table><tr><th>Grade</th><th>Fee</th></tr>${Array.from({ length: 40 }, (_, i) => `<tr><td>Grade ${i}</td><td>$${100 + i} for the examination application in this grade</td></tr>`).join("")}</table>
<h2>Contact</h2><ul><li>Email: a@waterboards.ca.gov</li><li>Phone<ul><li>(916) 555-1212</li></ul></li></ul>
<script>var x = "should not appear";</script></main>
<footer>Page last updated: 07/31/2026</footer></body></html>`;

test("html extraction keeps headings, list items and table rows, drops scripts and menus", () => {
  const { title, blocks, pageLastUpdated } = htmlToBlocks(HTML);
  assert.equal(title, "Operator Fees");
  assert.equal(pageLastUpdated, "07/31/2026");
  const text = blocks.map((b) => b.text).join("\n");
  assert.ok(!text.includes("should not appear"));
  assert.ok(!text.includes("Home"));
  assert.ok(text.includes("Grade | Fee"));
  assert.ok(text.includes("- Email: a@waterboards.ca.gov"));
  assert.ok(text.includes("(916) 555-1212"));
  assert.ok(blocks.some((b) => b.level === 2 && b.text === "Exam fees"));
});

test("passages stay under the size limit, keep their heading and repeat the table header", () => {
  const passages = chunkBlocks(htmlToBlocks(HTML).blocks, 1200);
  assert.ok(passages.length >= 3);
  for (const p of passages) assert.ok(p.text.length <= 1400, `passage too long: ${p.text.length}`);
  const tableParts = passages.filter((p) => p.text.includes("examination application"));
  assert.ok(tableParts.length >= 2);
  for (const p of tableParts) {
    assert.match(`${p.heading}\n${p.text}`, /Exam fees/);
    assert.ok(p.text.includes("Grade | Fee"), "each table passage starts with the header row");
  }
  assert.ok(passages.some((p) => /Contact/.test(p.heading ?? "") && p.text.includes("a@waterboards.ca.gov")));
});

test("pdf passages never cross pages", () => {
  const out = chunkPdfPages(["Fee schedule\nGrade II exam: $284.", "", "Certificate fee: $419."]);
  assert.deepEqual(out.map((p) => p.page), [1, 3]);
});

test("date finders", () => {
  assert.equal(findPageLastUpdated("blah Page last updated: 9/21/26 blah"), "9/21/26");
  assert.equal(findPageLastUpdated("Page Last Updated December 22, 2025"), "December 22, 2025");
  assert.equal(findFirstDate("Notice\nEffective November 16, 2017 the fee"), "November 16, 2017");
});

test("text repeated on many pages is treated as boilerplate", () => {
  const pages = Array.from({ length: 20 }, (_, i) => [{ text: "Subscribe to email updates" }, { text: `unique ${i}` }, { text: "Contact", level: 2 }]);
  const b = boilerplateSet(pages);
  assert.ok(b.has("Subscribe to email updates"));
  assert.ok(!b.has("unique 3"));
  assert.ok(!b.has("Contact"), "headings are never dropped");
});
