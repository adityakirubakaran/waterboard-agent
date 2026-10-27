/**
 * Find places where two Water Boards pages give different answers to the same question (see lib/conflicts.ts).
 *
 *   npm run conflicts                      # the saved pages in data/corpus, no keys needed
 *   npm run conflicts -- --source upstash  # every passage in the full-site Upstash index (needs
 *                                          # UPSTASH_VECTOR_REST_URL and _TOKEN; see .github/workflows/conflicts.yml)
 *   GEMINI_API_KEY=... npm run conflicts -- --second-opinion
 *                                          # also asks Gemini about each likely conflict and drops pairs it
 *                                          # calls different subject / period / same meaning
 *
 * Writes <out>/pairs.csv (every pair that got past the vector step, with the verdict and the reason) and
 * <out>/likely.md (only the likely conflicts, grouped by page pair, for a person to check). <out> is
 * data/conflicts for the saved pages and data/conflicts/upstash for the full index (or --out <dir>).
 * A likely conflict is a lead, not a finding: open both live pages before calling it a conflict.
 * data/conflicts/review.csv records what a person found for each lead of the 10/26/2026 run on the saved pages.
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { toCsv } from "../lib/csv";
import { CHAT_MODEL, gemini, hasGeminiKey, withRetry } from "../lib/gemini";
import { readChunks } from "../lib/retrieval";
import type { CorpusMeta } from "../lib/types";
import { fromVectorData, vectorConfigured, vectorIndex, type VectorMeta } from "../lib/vectorStore";
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
  type ClaimType,
  type Verdict,
} from "../lib/conflicts";

const DIR = path.join(process.cwd(), "data", "corpus");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, d: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const optStr = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args[i + 1]) : d;
};
const SOURCE = optStr("source", "corpus");
if (!["corpus", "upstash"].includes(SOURCE)) throw new Error(`--source must be corpus or upstash, not ${SOURCE}`);
const OUT = path.resolve(optStr("out", path.join("data", "conflicts", SOURCE === "upstash" ? "upstash" : "")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Passage {
  id: string;
  text: string;
  doc: ClaimDoc;
}

/** The saved pages: data/corpus, with page titles and dates from meta.json. */
async function* corpusPassages(): AsyncGenerator<Passage> {
  const meta: CorpusMeta = JSON.parse(fs.readFileSync(path.join(DIR, "meta.json"), "utf8"));
  const docs = new Map<string, ClaimDoc>(
    meta.sources.map((s) => [s.id, { url: s.url, title: s.title ?? s.url, date: (s as { pageLastUpdated?: string }).pageLastUpdated }]),
  );
  for (const c of readChunks(DIR)) yield { id: c.id, text: c.text, doc: docs.get(c.sourceId) ?? { url: c.url, title: c.title, date: c.date } };
}

/**
 * Every passage in the full-site index, read 1,000 at a time with Upstash's range command (one read request per
 * 1,000 passages). Passages keep the URL, title and date the crawler stored with them.
 */
async function* upstashPassages(maxPages: number): AsyncGenerator<Passage> {
  if (!vectorConfigured()) throw new Error("--source upstash needs UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN");
  const index = vectorIndex();
  const info = await index.info();
  console.log(`[conflicts] reading ${info.vectorCount.toLocaleString()} passages from the full-site index`);
  let cursor: string | number = 0;
  let pages = 0;
  let seen = 0;
  const started = Date.now();
  for (;;) {
    let res: Awaited<ReturnType<typeof index.range<VectorMeta>>> | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await index.range<VectorMeta>({ cursor, limit: 1000, includeMetadata: true, includeData: true });
        break;
      } catch (e) {
        if (attempt >= 6) throw e;
        const wait = Math.min(60_000, 2000 * 2 ** attempt);
        console.warn(`[conflicts] read failed (${String((e as Error)?.message ?? e).slice(0, 120)}); retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
    pages++;
    for (const v of res.vectors) {
      const m = v.metadata;
      if (!m?.url || typeof v.data !== "string") continue; // the crawler's write check, or a passage without text
      seen++;
      yield { id: String(v.id), text: fromVectorData(v.data), doc: { url: m.url, title: m.title || m.url, date: m.date } };
    }
    if (pages % 50 === 0) {
      const rate = seen / ((Date.now() - started) / 1000);
      console.log(`  ${seen.toLocaleString()} passages read (${Math.round(rate)}/s, about ${Math.round((info.vectorCount - seen) / rate / 60)} min left)`);
    }
    if (!res.nextCursor || res.nextCursor === String(cursor) || !res.vectors.length || pages >= maxPages) break;
    cursor = res.nextCursor;
  }
  console.log(`[conflicts] read ${seen.toLocaleString()} passages in ${pages} requests`);
}

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
  // 1. claims, from pages a visitor reads as current guidance (dated records are skipped, see isRecord).
  // Only passages that hold a claim are kept in memory (for the second opinion), so the full index fits.
  const claims: Claim[] = [];
  const passages = new Map<string, string>();
  const skipped = new Set<string>();
  let read = 0;
  const source = SOURCE === "upstash" ? upstashPassages(opt("max-pages", Infinity)) : corpusPassages();
  for await (const p of source) {
    read++;
    if (isRecord(p.doc)) {
      skipped.add(p.doc.url);
      continue;
    }
    const found = extractClaims({ id: p.id, text: p.text }, p.doc, claims.length);
    if (found.length) {
      claims.push(...found);
      passages.set(p.id, p.text);
    }
  }
  console.log(`[conflicts] skipped ${skipped.size} dated records (agendas, notices, orders, slides, drafts, past years' files)`);
  const byType = new Map<ClaimType, Claim[]>();
  for (const c of claims) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c);
  }
  console.log(`[conflicts] ${read} passages, ${claims.length} claims: ${[...byType].map(([t, cs]) => `${cs.length} ${t}`).join(", ")}`);

  // 2. vectors and nearest claims on other pages, one kind of claim at a time. Each claim's 8 closest claims on
  // other pages; the bar is low on purpose (the same fact is often worded very differently on two pages), and
  // steps 3-4 decide what is really about the same thing.
  // Word weights come from all claims together (so "credit card" stays a telling word among card rules); the
  // search for neighbors runs within each kind.
  const V = buildVectors(claims);
  const pairs: ReturnType<typeof neighbors> = [];
  for (const [type, cs] of byType) {
    const t0 = Date.now();
    const ids = new Set(cs.map((c) => c.id));
    const postings = new Map<string, number[]>();
    for (const [g, list] of V.postings) {
      const mine = list.filter((id) => ids.has(id));
      if (mine.length) postings.set(g, mine);
    }
    // In the full index the same file often sits at several URLs, so identical twins would fill every neighbor
    // slot; there, a neighbor with exactly the same value is passed over (it could never be a conflict).
    const found = neighbors(cs, { vecs: V.vecs, postings }, {
      minSim: opt("min-sim", 0.1),
      k: opt("k", 8),
      maxPost: opt("max-post", 2000),
      skipSameValue: SOURCE === "upstash",
    });
    pairs.push(...found);
    console.log(`  ${type}: ${found.length} close pairs (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
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
  const where = SOURCE === "upstash" ? "the full-site index" : "the saved Water Boards pages";
  const lines = [
    `# Likely conflicts on ${where}`,
    ``,
    `${groups.size} page pairs from ${claims.length} claims in ${read} passages (${new Date().toISOString().slice(0, 10)}). Each is a lead for a person to check on the live site, not a finding.`,
    ``,
  ];
  // pages of the same era first (an old page that disagrees with a new one is still worth a look, but second),
  // then the pairs that disagree in the most sentences, then the closest
  const older = (js: typeof judged) => (js[0].v.label === "likely conflict" && js[0].v.older ? 1 : 0);
  for (const [key, js] of [...groups].sort((x, y) => older(x[1]) - older(y[1]) || y[1].length - x[1].length || y[1][0].sim - x[1][0].sim)) {
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
  fs.writeFileSync(
    path.join(OUT, "summary.json"),
    JSON.stringify(
      {
        source: SOURCE,
        ranAt: new Date().toISOString(),
        passages: read,
        skippedRecords: skipped.size,
        claims: Object.fromEntries([...byType].map(([t, cs]) => [t, cs.length])),
        closePairs: pairs.length,
        verdicts: Object.fromEntries(counts),
        likelyPagePairs: groups.size,
      },
      null,
      2,
    ),
  );
  const rel = path.relative(process.cwd(), OUT);
  console.log(`[conflicts] ${groups.size} likely conflicts (page pairs) -> ${rel}/likely.md; all pairs -> ${rel}/pairs.csv`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
