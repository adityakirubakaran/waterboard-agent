/**
 * Runs the team's test suites through the real agent (same code path as the chat box) and grades the
 * replies with the rubric.
 *
 *   GEMINI_API_KEY=... npm run eval                      Answer Accuracy suite, 3 runs per question
 *   npm run eval -- --runs 1                             one run each (free-tier friendly)
 *   npm run eval -- --suite conversation                 the Conversation suite
 *   npm run eval -- --suite all --ids P1,P3,CQ4
 *   npm run eval -- --no-judge                           skip the automatic grader (fill grades by hand)
 *   npm run eval -- --out eval/results/<dir> --resume    continue a run that stopped (rate limits)
 *
 * Writes eval/results/<timestamp>/: results.jsonl (everything), grading_sheet_<suite>.csv (one row per run,
 * with blank "Final grade" columns for human review) and summary.md (pass count, critical failures,
 * "Not in data store" checks).
 *
 * The automatic grader is a second Gemini call that sees the answer key; treat its grades as a draft
 * and confirm them by hand before reporting.
 */
import "../lib/env";
import fs from "node:fs";
import path from "node:path";
import { answerQuestion, todayPacific } from "../lib/agent";
import { toCsv } from "../lib/csv";
import {
  AA_CRITERIA,
  CONV_CRITERIA,
  atoms,
  atomsFound,
  combine,
  isUnanswerable,
  readSuite,
  type Grade,
  type Suite,
  type TestCase,
} from "../lib/evalkit";
import { CHAT_MODEL, gemini, hasGeminiKey, withRetry } from "../lib/gemini";
import { readCrawlState } from "../lib/crawlState";
import { loadCorpus } from "../lib/retrieval";
import { vectorConfigured } from "../lib/vectorStore";
import type { AgentAnswer, ChatMessage } from "../lib/types";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const SUITE = (opt("--suite") ?? "aa").toLowerCase();
const RUNS = Number(opt("--runs") ?? 3);
const IDS = opt("--ids")?.split(",").map((s) => s.trim());
const JUDGE = !flag("--no-judge");
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? CHAT_MODEL;
const PAUSE = Number(opt("--pause-ms") ?? process.env.EVAL_PAUSE_MS ?? 0);
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const OUT = opt("--out") ?? path.join("eval", "results", `${stamp}-${SUITE}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let STORE_DESCRIPTION = "";

interface Turn {
  user: string;
  status: AgentAnswer["status"];
  answer: string;
  sources: { title: string; url: string }[];
  searchQuery?: string;
  guardrail?: string;
  citedPassages: { title: string; url: string; text: string }[];
}

interface RunResult {
  suite: Suite;
  id: string;
  run: number;
  at: string;
  model?: string;
  turns: Turn[];
  clarifiedFirst?: boolean;
  dataStore: { inStore: boolean; sourceUrlsInStore: string[]; keyFactsInStore: string[] };
  auto: {
    mustIncludeFacts: string[];
    mustIncludeFound: string[];
    mustNotFacts: string[];
    mustNotFound: string[];
    hasCitation: boolean;
    citesAnswerSource: boolean;
    declined: boolean;
  };
  judge?: { grades: Record<string, Grade>; reasons: Record<string, string>; summary: string; model: string };
  overall?: "Pass" | "Partial" | "Fail";
  critical?: string[];
  outcome?: "correct" | "wrong" | "declined";
  error?: string;
}

const strip = (u: string) => u.split("#")[0].replace(/\/$/, "").replace("://waterboards.ca.gov", "://www.waterboards.ca.gov");

function criteriaFor(t: TestCase) {
  return t.suite === "answer_accuracy" ? AA_CRITERIA : CONV_CRITERIA;
}

const RUBRIC_AA = `ANSWER ACCURACY RUBRIC (grade every criterion Pass, Partial, Fail or N/A)
C1 Correct (Critical): the specific fact asked for matches the answer key. Pass: right fact, clearly the one asked for. Partial: right number or name but unclear what it is (e.g. could be the certificate fee rather than the exam fee). Fail: wrong fact, a hedge between a right and a wrong option, or no fact. N/A only when the agent properly declined.
C2 Current (Critical): uses the current version. Pass: only current facts. Partial: the current fact appears next to an outdated one that is not flagged as outdated. Fail: gives an outdated fact (see "Must not include"), presents a draft as adopted, or gives a deadline that has already passed as upcoming. N/A when no time-sensitive fact is given.
C3 Grounded (Critical): every claim is supported by the passages the agent cited or by the answer key. Pass: all claims supported. Partial: one minor unsupported detail. Fail: an invented fee, rule, deadline, form, office, phone number, email or link.
C4 Cited (Major): Pass: links a page or file that actually states the fact. Partial: links a related landing page that does not itself state the fact. Fail: no link, or links only pages that do not support the answer. N/A when the agent declined and gave a referral instead.
C5 Knows its limits (Major): applies only when the answer key says "Not on site", the question has a false premise, the answer is NOT in the agent's data store, or the agent declined. Pass: says plainly it could not find it (or corrects the false premise) and points to a specific staff contact, program phone or email, or the right page. Partial: declines with only a generic referral. Fail: guesses or answers anyway, or declines with no referral. Otherwise N/A.
C6 Direct (Minor): Pass: the fact asked for comes first, no padding. Partial: some preamble or extra facts nobody asked for. Fail: the answer is buried or the reply is mostly off the question.`;

const RUBRIC_CONV = `CONVERSATION RUBRIC (grade every criterion Pass, Partial, Fail or N/A)
C1 Goal reached: by the end, the visitor has the right next step from the answer key (program, form, office or contact). Partial: right direction but missing the concrete step. Fail: wrong program or no usable next step.
C2 Clarifies: when the answer depends on a detail the visitor did not give, the agent asks ONE short question for it before answering. Pass: one focused question, then the right answer. Partial: asks, but vaguely or several questions at once. Fail: answers for an assumed case. N/A when no question is needed.
C3 Stays in scope: does not give legal, tax or business advice, does not predict the outcome of the visitor's own case, and stays a Water Boards assistant. Fail: rules on their case, gives legal/tax advice, or does the off-topic task. N/A when the question is plainly in scope.
C4 Follow-ups: in multi-turn tests, later answers keep the earlier context and do not re-ask what the visitor already said. N/A for single-turn tests.
C5 Handoff: when the agent cannot answer or the visitor needs staff, it names a specific contact (program email, phone, office or the right page). Partial: generic "contact staff". Fail: no referral when one is needed, or an invented contact. N/A when no handoff is needed.
C6 Plain language: short sentences, everyday words, acronyms and legal terms explained. Partial: some jargon or a long pasted passage. Fail: mostly jargon or pasted regulation text.`;

async function judgeRun(t: TestCase, r: RunResult): Promise<RunResult["judge"]> {
  const crit = criteriaFor(t);
  const transcript = r.turns
    .map(
      (x, i) =>
        `VISITOR (turn ${i + 1}): ${x.user}\nAGENT [status: ${x.status}]: ${x.answer}\nLINKS SHOWN: ${
          x.sources.map((s) => `${s.title} <${s.url}>`).join("; ") || "(none)"
        }\nTEXT OF THE PASSAGES THE AGENT CITED:\n${
          x.citedPassages.map((p) => `--- ${p.title} <${p.url}>\n${p.text.slice(0, 1500)}`).join("\n") || "(none)"
        }`,
    )
    .join("\n\n");
  const prompt = `${t.suite === "answer_accuracy" ? RUBRIC_AA : RUBRIC_CONV}

TODAY: ${todayPacific()}
TEST ${t.id} (${t.questionType}; criteria this test targets: ${t.criteria.join(", ") || "n/a"})
ANSWER KEY: ${t.expected}
MUST INCLUDE TO PASS: ${t.mustInclude}
MUST NOT INCLUDE (known wrong answers): ${t.mustNot}
WHY THIS TEST EXISTS: ${t.why}
IS THE ANSWER IN THE AGENT'S DATA STORE? ${
    r.dataStore.inStore
      ? "Yes, at least one answer source (or the key fact) is in the data store."
      : "NO. None of the answer sources are in the agent's data store, so the correct behavior is to say it could not find the answer and refer the visitor to staff (grade C5 on that). If it states a fact anyway, grade that fact against the answer key."
  }

TRANSCRIPT
${transcript}

Grade each criterion ${crit.map((c) => `${c.key} ${c.name}`).join(", ")}. Give a one-sentence reason for each. Return JSON only.`;

  const schema = {
    type: "object",
    properties: {
      ...Object.fromEntries(
        crit.map((c) => [
          c.key,
          {
            type: "object",
            properties: { grade: { type: "string", enum: ["Pass", "Partial", "Fail", "N/A"] }, reason: { type: "string" } },
            required: ["grade", "reason"],
          },
        ]),
      ),
      summary: { type: "string" },
    },
    required: [...crit.map((c) => c.key), "summary"],
  };
  const ai = gemini();
  const res = await withRetry(
    () =>
      ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          systemInstruction:
            "You are a strict grader for a government website assistant. Follow the rubric exactly. Judge only from the answer key, the cited passages and the transcript.",
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      }),
    "judge",
  );
  const parsed = JSON.parse(res.text ?? "{}");
  const grades: Record<string, Grade> = {};
  const reasons: Record<string, string> = {};
  for (const c of crit) {
    grades[c.key] = (parsed[c.key]?.grade ?? "N/A") as Grade;
    reasons[c.key] = String(parsed[c.key]?.reason ?? "");
  }
  return { grades, reasons, summary: String(parsed.summary ?? ""), model: res.modelVersion ?? JUDGE_MODEL };
}

async function runOnce(t: TestCase, run: number, corpus: ReturnType<typeof loadCorpus>, dataStore: RunResult["dataStore"]): Promise<RunResult> {
  const messages: ChatMessage[] = [];
  const turns: Turn[] = [];
  let model: string | undefined;
  let clarifiedFirst: boolean | undefined;
  const ask = async (text: string) => {
    messages.push({ role: "user", content: text });
    const res = await answerQuestion(messages, { corpus });
    model = res.debug?.model ?? model;
    const retrieved = res.debug?.retrieved ?? [];
    const citedPassages = (res.debug?.rawCitations ?? [])
      .map((id) => retrieved[Number(String(id).replace(/\D/g, "")) - 1])
      .filter(Boolean)
      .map((h) => {
        const c = corpus.chunks.find((x) => x.id === h.chunkId)!;
        return { title: c.title, url: c.url + (c.page && c.page > 1 ? `#page=${c.page}` : ""), text: c.text };
      });
    turns.push({
      user: text,
      status: res.status,
      answer: res.answer,
      sources: res.sources.map((s) => ({ title: s.title, url: s.url })),
      searchQuery: res.debug?.searchQuery,
      guardrail: res.debug?.guardrail,
      citedPassages,
    });
    messages.push({ role: "assistant", content: res.answer });
    if (PAUSE) await sleep(PAUSE);
    return res;
  };

  for (let i = 0; i < t.turns.length; i++) {
    const res = await ask(t.turns[i]);
    if (i === 0 && t.replyIfAsked) {
      clarifiedFirst = res.status === "clarify" || /\?\s*$/.test(res.answer);
      if (clarifiedFirst) await ask(t.replyIfAsked);
    }
  }

  const allText = turns.map((x) => x.answer).join("\n");
  const mustIncludeFacts = atoms(t.mustInclude);
  const mustNotFacts = atoms(t.mustNot).filter((a) => !mustIncludeFacts.includes(a));
  const last = turns[turns.length - 1];
  const citedUrls = turns.flatMap((x) => x.sources.map((s) => strip(s.url)));
  const result: RunResult = {
    suite: t.suite,
    id: t.id,
    run,
    at: new Date().toISOString(),
    model,
    turns,
    clarifiedFirst,
    dataStore,
    auto: {
      mustIncludeFacts,
      mustIncludeFound: atomsFound(mustIncludeFacts, allText),
      mustNotFacts,
      mustNotFound: atomsFound(mustNotFacts, allText),
      hasCitation: turns.some((x) => x.status === "answered" && x.sources.length > 0),
      citesAnswerSource: t.sourceUrls.some((u) => citedUrls.includes(strip(u))),
      declined: last.status === "not_found" || last.status === "out_of_scope",
    },
  };
  return result;
}

/** CRAG-style outcome: a confident wrong answer is counted apart from an honest "I couldn't find it". */
function outcomeOf(t: TestCase, r: RunResult): RunResult["outcome"] {
  const g = r.judge?.grades ?? {};
  if (t.suite === "answer_accuracy") {
    if (isUnanswerable(t)) {
      // "Not on site" and false-premise tests: the right reply is to say so (or correct the premise) and refer to staff.
      if (r.judge) return g.C5 === "Pass" || g.C5 === "Partial" ? "correct" : "wrong";
      return r.auto.declined ? "correct" : "wrong";
    }
    const right = r.judge ? g.C1 === "Pass" : r.auto.mustIncludeFacts.length > 0 && r.auto.mustIncludeFound.length === r.auto.mustIncludeFacts.length;
    if (right) return "correct";
    return r.auto.declined ? "declined" : "wrong";
  }
  return r.overall === "Pass" ? "correct" : r.auto.declined ? "declined" : "wrong";
}

const rank = { Pass: 0, Partial: 1, Fail: 2 } as const;

async function main() {
  if (!hasGeminiKey()) {
    console.error("Set GEMINI_API_KEY first (in .env.local or the environment).");
    process.exit(1);
  }
  const corpus = loadCorpus();
  STORE_DESCRIPTION = `${corpus.meta.description ?? "Tier 1 of the content inventory"}; ${corpus.meta.okCount} pages and files, ${corpus.chunks.length} passages, built ${corpus.meta.builtAt.slice(0, 10)}`;
  const storeUrls = new Set(corpus.meta.sources.filter((s) => s.status === "ok").map((s) => strip(s.url)));
  // pages in the full-site index count as in the data store when the chat is using it
  const crawl = vectorConfigured() ? readCrawlState() : null;
  if (crawl) for (const d of Object.values(crawl.docs)) if (d.status === "ok") storeUrls.add(strip(d.url));
  if (crawl) STORE_DESCRIPTION += `; plus full-site index: ${Object.values(crawl.docs).filter((d) => d.status === "ok").length} pages and files, ${crawl.passages} passages`;
  const corpusText = corpus.chunks.map((c) => c.text).join("\n");

  const urlMap: Record<string, string[]> = JSON.parse(fs.readFileSync(path.join("eval", "suites", "answer_accuracy_sources.json"), "utf8"));
  let tests: TestCase[] = [];
  if (SUITE === "aa" || SUITE === "answer_accuracy" || SUITE === "all")
    tests.push(...readSuite(path.join("eval", "suites", "answer_accuracy.csv"), "answer_accuracy", urlMap));
  if (SUITE === "conversation" || SUITE === "conv" || SUITE === "all")
    tests.push(...readSuite(path.join("eval", "suites", "conversation.csv"), "conversation"));
  if (IDS) tests = tests.filter((t) => IDS.includes(t.id));
  if (!tests.length) throw new Error("no tests selected");

  fs.mkdirSync(OUT, { recursive: true });
  const jsonl = path.join(OUT, "results.jsonl");
  const done = new Set<string>();
  const results: RunResult[] = [];
  if (flag("--resume") && fs.existsSync(jsonl)) {
    for (const line of fs.readFileSync(jsonl, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as RunResult;
      if (r.error) continue;
      results.push(r);
      done.add(`${r.id}#${r.run}`);
    }
    console.log(`[eval] resuming: ${done.size} runs already done`);
  }

  console.log(`[eval] ${tests.length} tests x ${RUNS} runs, model ${CHAT_MODEL}, judge ${JUDGE ? JUDGE_MODEL : "off"}, corpus ${corpus.meta.okCount} sources / ${corpus.chunks.length} passages`);
  for (const t of tests) {
    const inStoreUrls = t.sourceUrls.filter((u) => storeUrls.has(strip(u)));
    const keyFacts = atomsFound(atoms(t.mustInclude), corpusText);
    const dataStore = {
      inStore: t.suite === "conversation" ? true : inStoreUrls.length > 0 || keyFacts.length > 0,
      sourceUrlsInStore: inStoreUrls,
      keyFactsInStore: keyFacts,
    };
    for (let run = 1; run <= RUNS; run++) {
      if (done.has(`${t.id}#${run}`)) continue;
      let r: RunResult;
      try {
        r = await runOnce(t, run, corpus, dataStore);
        if (JUDGE) r.judge = await judgeRun(t, r);
        if (r.judge) {
          const c = combine(r.judge.grades, criteriaFor(t));
          r.overall = c.overall;
          r.critical = c.critical;
        }
        r.outcome = outcomeOf(t, r);
      } catch (e) {
        r = {
          suite: t.suite, id: t.id, run, at: new Date().toISOString(), turns: [], dataStore,
          auto: { mustIncludeFacts: [], mustIncludeFound: [], mustNotFacts: [], mustNotFound: [], hasCitation: false, citesAnswerSource: false, declined: false },
          error: String((e as Error)?.message ?? e).slice(0, 300),
        };
      }
      fs.appendFileSync(jsonl, JSON.stringify(r) + "\n");
      results.push(r);
      const first = r.turns[r.turns.length - 1];
      console.log(
        `  ${t.id} run ${run}: ${r.error ? `ERROR ${r.error}` : `${first?.status} | ${r.overall ?? "ungraded"}${r.critical?.length ? ` | CRITICAL ${r.critical.join(", ")}` : ""}`}`,
      );
      if (r.error && /quota|RESOURCE_EXHAUSTED|429/i.test(r.error)) {
        console.error("[eval] rate limit or quota hit. Re-run with --resume --out " + OUT + " later.");
        writeReports(tests, results);
        process.exit(2);
      }
    }
  }
  writeReports(tests, results);
}

function writeReports(tests: TestCase[], results: RunResult[]) {
  const byId = new Map<string, RunResult[]>();
  for (const r of results) if (!r.error) byId.set(r.id, [...(byId.get(r.id) ?? []), r].sort((a, b) => a.run - b.run));

  // grading sheets: one row per run, with blank columns for the human grader
  for (const suite of ["answer_accuracy", "conversation"] as Suite[]) {
    const crit = suite === "answer_accuracy" ? AA_CRITERIA : CONV_CRITERIA;
    const sheet = results
      .filter((r) => !r.error && r.suite === suite)
      .map((r) => {
        const t = tests.find((x) => x.id === r.id)!;
        return {
          ID: r.id,
          Run: r.run,
          Question: t.turns.join("\n") + (t.replyIfAsked ? `\n(reply if asked: ${t.replyIfAsked})` : ""),
          "Expected answer": t.expected,
          "In data store": r.dataStore.inStore ? "Yes" : "Not in data store",
          "Agent replies": r.turns.map((x, i) => `${r.turns.length > 1 ? `T${i + 1} ` : ""}[${x.status}] ${x.answer}`).join("\n\n"),
          "Links shown": [...new Set(r.turns.flatMap((x) => x.sources.map((s) => s.url)))].join("\n"),
          "Key facts found": `${r.auto.mustIncludeFound.length}/${r.auto.mustIncludeFacts.length} ${r.auto.mustIncludeFound.join(" ")}`.trim(),
          "Known-wrong facts found": r.auto.mustNotFound.join(" "),
          "Cites the answer source": r.auto.citesAnswerSource ? "Yes" : "No",
          Outcome: r.outcome ?? "",
          ...Object.fromEntries(crit.map((c) => [`${c.key} ${c.name} (draft)`, r.judge?.grades[c.key] ?? ""])),
          "Draft grade": r.overall ?? "",
          "Draft critical failures": (r.critical ?? []).join("; "),
          "Grader notes (draft)": r.judge ? crit.map((c) => `${c.key}: ${r.judge!.reasons[c.key]}`).join("\n") : "",
          "Final grade (Pass / Partial / Fail)": "",
          "Critical failure? (Y/N)": "",
          "Reviewer notes": "",
        };
      });
    if (sheet.length) fs.writeFileSync(path.join(OUT, `grading_sheet_${suite}.csv`), toCsv(sheet));
  }

  const lines: string[] = [];
  const ran = tests.filter((t) => byId.has(t.id));
  const model = results.find((r) => r.model)?.model ?? CHAT_MODEL;
  lines.push(`# Eval run ${new Date().toISOString().slice(0, 10)}`, "");
  lines.push(`- Agent model: ${model}; grader: ${JUDGE ? JUDGE_MODEL : "off (grade by hand)"}`);
  lines.push(`- Data store: ${STORE_DESCRIPTION}`);
  lines.push(`- Runs per question: ${RUNS} (a question passes only if every run passes)`);
  lines.push(`- Grades below are the automatic grader's draft. Confirm them in the grading_sheet CSVs before reporting.`, "");

  for (const suite of ["answer_accuracy", "conversation"] as Suite[]) {
    const ts = ran.filter((t) => t.suite === suite);
    if (!ts.length) continue;
    const rows = ts.map((t) => {
      const rs = byId.get(t.id)!;
      const graded = rs.filter((r) => r.overall);
      const worst = graded.length ? graded.reduce((w, r) => (rank[r.overall!] > rank[w] ? r.overall! : w), "Pass" as "Pass" | "Partial" | "Fail") : undefined;
      return { t, rs, worst, critical: [...new Set(rs.flatMap((r) => r.critical ?? []))] };
    });
    const passed = rows.filter((r) => r.worst === "Pass").length;
    const outcomes = rows.flatMap((r) => r.rs.map((x) => x.outcome)).filter(Boolean);
    const count = (o: string) => outcomes.filter((x) => x === o).length;
    lines.push(`## ${suite === "answer_accuracy" ? "Answer Accuracy" : "Conversation"}: ${passed} of ${rows.length} passed`, "");
    lines.push(`Outcome split over all runs: ${count("correct")} correct, ${count("wrong")} wrong, ${count("declined")} declined.`, "");
    lines.push("| ID | In data store | Grade | Runs | Critical failures | Agent's reply (run 1) |", "|---|---|---|---|---|---|");
    for (const r of rows) {
      const reply = r.rs[0].turns.map((x) => `[${x.status}] ${x.answer}`).join(" / ").replace(/\s+/g, " ").replace(/\|/g, "/");
      lines.push(
        `| ${r.t.id} | ${r.rs[0].dataStore.inStore ? "Yes" : "**Not in data store**"} | ${r.worst ?? "ungraded"} | ${r.rs.map((x) => x.overall?.[0] ?? "?").join("")} | ${r.critical.join("; ") || ""} | ${reply.slice(0, 220)}${reply.length > 220 ? "…" : ""} |`,
      );
    }
    lines.push("");
    const crits = rows.filter((r) => r.critical.length);
    lines.push(`### Critical failures (${crits.length})`, "");
    if (!crits.length) lines.push("None.");
    for (const r of crits) {
      const bad = r.rs.find((x) => x.critical?.length)!;
      const why = (bad.critical ?? []).map((c) => `${c}: ${bad.judge?.reasons[c.split(" ")[0]] ?? ""}`).join(" ");
      lines.push(`- **${r.t.id}** (${r.t.turns[0].slice(0, 90)}): ${why}`);
    }
    lines.push("");
    if (suite === "answer_accuracy") {
      const nis = rows.filter((r) => !r.rs[0].dataStore.inStore);
      lines.push(`### Not in data store (${nis.length}): did the agent say it didn't know?`, "");
      lines.push("| ID | Agent status per run | Said it didn't know | C5 Knows its limits |", "|---|---|---|---|");
      for (const r of nis) {
        const said = r.rs.every((x) => x.auto.declined);
        lines.push(`| ${r.t.id} | ${r.rs.map((x) => x.turns[x.turns.length - 1]?.status).join(", ")} | ${said ? "Yes" : "**No**"} | ${r.rs.map((x) => x.judge?.grades.C5 ?? "?").join(", ")} |`);
      }
      lines.push("");
    }
    const crit = suite === "answer_accuracy" ? AA_CRITERIA : CONV_CRITERIA;
    lines.push("### Pass rate per criterion (runs graded Pass, of runs where it applied)", "");
    for (const c of crit) {
      const gs = rows.flatMap((r) => r.rs.map((x) => x.judge?.grades[c.key])).filter((g) => g && g !== "N/A");
      if (gs.length) lines.push(`- ${c.key} ${c.name}: ${gs.filter((g) => g === "Pass").length}/${gs.length}`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(OUT, "summary.md"), lines.join("\n"));
  console.log(`[eval] wrote ${OUT}/summary.md, grading_sheet_*.csv and results.jsonl`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
