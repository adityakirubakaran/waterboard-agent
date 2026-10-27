/**
 * Find places where two Water Boards pages give different answers to the same question (see lib/conflicts.ts).
 *
 *   npm run conflicts                      # the saved pages in data/corpus, no keys needed
 *   GEMINI_API_KEY=... npm run conflicts -- --second-opinion
 *                                          # also asks Gemini about each likely conflict and drops pairs it
 *                                          # calls different subject / period / same meaning
 *
 * Writes data/conflicts/pairs.csv (every pair that got past the vector step, with the verdict and the reason)
 * and data/conflicts/likely.md (only the likely conflicts, grouped by page pair, for a person to check).
 * A likely conflict is a lead, not a finding: open both live pages before calling it a conflict.
 * data/conflicts/review.csv records what a person found for each lead of the 10/26/2026 run.
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { toCsv } from "../lib/csv";
import { CHAT_MODEL, gemini, hasGeminiKey, withRetry } from "../lib/gemini";
import { readChunks } from "../lib/retrieval";
import type { CorpusMeta } from "../lib/types";
import {
  buildVectors,
  extractClaims,
  isRecord,
  judge,
  JUDGE_INSTRUCTION,
  JUDGE_SCHEMA,
  neighbors,
  quoteFound,
  type Claim,
  type ClaimDoc,
  type Verdict,
} from "../lib/conflicts";

const DIR = path.join(process.cwd(), "data", "corpus");
const OUT = path.join(process.cwd(), "data", "conflicts");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, d: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};

async function secondOpinion(a: Claim, b: Claim, passages: Map<string, string>) {
  const pa = passages.get(a.chunkId)!;
  const pb = passages.get(b.chunkId)!;
  const ai = gemini();
  const res = await withRetry(
    () =>
      ai.models.generateContent({
        model: CHAT_MODEL,
        contents: [
          {
            role: "user",
            parts: [{ text: `PASSAGE A (${a.doc.title}, ${a.doc.url}):\n${pa}\n\nPASSAGE B (${b.doc.title}, ${b.doc.url}):\n${pb}\n\nValues in question: A says ${a.raw}; B says ${b.raw}.` }],
          },
        ],
        config: { systemInstruction: JUDGE_INSTRUCTION, temperature: 0, responseMimeType: "application/json", responseJsonSchema: JUDGE_SCHEMA },
      }),
    "judge",
  );
  const j = JSON.parse(res.text ?? "{}");
  const quotesOk = quoteFound(j.quote_a ?? "", pa) && quoteFound(j.quote_b ?? "", pb);
  return { verdict: String(j.verdict ?? "unclear"), reason: String(j.reason ?? ""), quotesOk };
}

async function main() {
  const meta: CorpusMeta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8"));
  const docs = new Map<string, ClaimDoc>(
    meta.sources.map((s) => [s.id, { url: s.url, title: s.title ?? s.url, date: (s as { pageLastUpdated?: string }).pageLastUpdated }]),
  );
  const chunks = readChunks(DIR);
  const passages = new Map(chunks.map((c) => [c.id, c.text]));

  // 1. claims, from pages a visitor reads as current guidance (dated records are skipped, see isRecord)
  const claims: Claim[] = [];
  const skipped = new Set<string>();
  for (const c of chunks) {
    const doc = docs.get(c.sourceId) ?? { url: c.url, title: c.title, date: c.date };
    if (isRecord(doc)) {
      skipped.add(doc.url);
      continue;
    }
    claims.push(...extractClaims(c, doc, claims.length));
  }
  console.log(`[conflicts] skipped ${skipped.size} dated records (agendas, notices, orders, slides, drafts, past years' files)`);
  const byType = new Map<string, number>();
  for (const c of claims) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  console.log(`[conflicts] ${chunks.length} passages, ${claims.length} claims: ${[...byType].map(([t, n]) => `${n} ${t}`).join(", ")}`);

  // 2. vectors and nearest claims on other pages
  const V = buildVectors(claims);
  // Each claim's 8 closest claims on other pages. The bar is low on purpose: the same fact is often worded very
  // differently on two pages, and steps 3-4 below decide what is really about the same thing.
  const pairs = neighbors(claims, V, { minSim: opt("min-sim", 0.1), k: opt("k", 8) });
  console.log(`[conflicts] ${pairs.length} close pairs (same kind of claim, different pages)`);

  // 3-4. values and guards
  const judged: { a: Claim; b: Claim; sim: number; v: Verdict; second?: Awaited<ReturnType<typeof secondOpinion>> }[] = pairs.map((p) => ({
    ...p,
    v: judge(p.a, p.b),
  }));
  const counts = new Map<string, number>();
  for (const j of judged) counts.set(j.v.label, (counts.get(j.v.label) ?? 0) + 1);
  console.log(`[conflicts] ${[...counts].map(([l, n]) => `${n} ${l}`).join(", ")}`);

  // 5. optional second opinion
  if (flag("second-opinion")) {
    if (!hasGeminiKey()) throw new Error("--second-opinion needs GEMINI_API_KEY");
    const likely = judged.filter((j) => j.v.label === "likely conflict");
    for (const [i, j] of likely.entries()) {
      j.second = await secondOpinion(j.a, j.b, passages);
      if (j.second.verdict !== "contradiction" || !j.second.quotesOk) {
        j.v = { label: "different subject", why: `second opinion: ${j.second.verdict}${j.second.quotesOk ? "" : " (quotes not found)"}: ${j.second.reason}` };
      }
      if ((i + 1) % 20 === 0) console.log(`  second opinion ${i + 1}/${likely.length}`);
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const rows = judged
    .sort((x, y) => (x.v.label === "likely conflict" ? 0 : 1) - (y.v.label === "likely conflict" ? 0 : 1) || y.sim - x.sim)
    .map((j) => ({
      verdict: j.v.label,
      reason: j.v.why,
      older_page: j.v.label === "likely conflict" && j.v.older ? "yes" : "",
      kind: j.a.type,
      similarity: j.sim.toFixed(2),
      value_a: j.a.raw,
      value_b: j.b.raw,
      says_a: j.a.sentence.slice(0, 400),
      says_b: j.b.sentence.slice(0, 400),
      page_a: j.a.doc.url,
      page_b: j.b.doc.url,
      date_a: j.a.doc.date ?? "",
      date_b: j.b.doc.date ?? "",
      second_opinion: j.second ? `${j.second.verdict}${j.second.quotesOk ? "" : " (quotes not found)"}: ${j.second.reason}` : "",
      checked_on_live_site: "",
    }));
  fs.writeFileSync(path.join(OUT, "pairs.csv"), toCsv(rows));

  // likely conflicts, grouped by page pair so one disagreement repeated in five sentences reads as one lead
  const groups = new Map<string, typeof judged>();
  for (const j of judged.filter((x) => x.v.label === "likely conflict")) {
    const [p, q] = [j.a.doc.url, j.b.doc.url].sort();
    const key = `${j.a.type}|${p}|${q}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(j);
  }
  const lines = [
    `# Likely conflicts on the saved Water Boards pages`,
    ``,
    `${groups.size} page pairs from ${claims.length} claims (${new Date().toISOString().slice(0, 10)}). Each is a lead for a person to check on the live site, not a finding.`,
    ``,
  ];
  for (const [key, js] of [...groups].sort((x, y) => y[1][0].sim - x[1][0].sim)) {
    const j = js[0];
    lines.push(`## ${key.split("|")[0]}: ${j.a.raw} vs ${j.b.raw}${j.v.label === "likely conflict" && j.v.older ? " (one page is 3+ years older)" : ""}`);
    lines.push(`- A: ${j.a.doc.title} (${j.a.doc.date ?? "no date"}) ${j.a.doc.url}`);
    lines.push(`  > ${j.a.sentence.slice(0, 300)}`);
    lines.push(`- B: ${j.b.doc.title} (${j.b.doc.date ?? "no date"}) ${j.b.doc.url}`);
    lines.push(`  > ${j.b.sentence.slice(0, 300)}`);
    if (js.length > 1) lines.push(`- ${js.length - 1} more sentence pairs on these two pages`);
    lines.push(``);
  }
  fs.writeFileSync(path.join(OUT, "likely.md"), lines.join("\n"));
  console.log(`[conflicts] ${groups.size} likely conflicts (page pairs) -> data/conflicts/likely.md; all pairs -> data/conflicts/pairs.csv`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
