/** Helpers for the eval runner: reading the team's test suites, fact checks and the rubric's scoring rules. */
import fs from "node:fs";
import { parseCsv } from "./csv";

export type Suite = "answer_accuracy" | "conversation";

export interface TestCase {
  suite: Suite;
  id: string;
  /** Visitor turns, in order. */
  turns: string[];
  /** Sent only if the agent asks a clarifying question after the first turn. */
  replyIfAsked?: string;
  expected: string;
  mustInclude: string;
  mustNot: string;
  why: string;
  criteria: string[]; // e.g. ["C1 Correct", "C4 Cited"]
  questionType: string;
  difficulty: string;
  section: string;
  sourceNames: string;
  sourceUrls: string[];
}

const get = (r: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return "";
};

export function splitTurns(cell: string): { turns: string[]; replyIfAsked?: string } {
  const text = cell.replace(/\r/g, "").trim();
  const reply = text.match(/Visitor'?s reply if asked:\s*["“]?([\s\S]*?)["”]?\s*$/i);
  const head = reply ? text.slice(0, reply.index).trim() : text;
  const parts = head.split(/\n?\s*Q\d+:\s*/).map((s) => s.trim()).filter(Boolean);
  return { turns: parts.length ? parts : [head], replyIfAsked: reply?.[1]?.trim() };
}

export function readSuite(file: string, suite: Suite, urlMap: Record<string, string[]> = {}): TestCase[] {
  const rows = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  return rows
    .filter((r) => get(r, "ID").trim())
    .map((r) => {
      const { turns, replyIfAsked } = splitTurns(get(r, "Question", "Question(s)"));
      const id = get(r, "ID").trim();
      return {
        suite,
        id,
        turns,
        replyIfAsked,
        expected: get(r, "Expected answer", "Answer key"),
        mustInclude: get(r, "Must include (to pass)"),
        mustNot: get(r, "Must not include (known wrong answers)"),
        why: get(r, "Why it's in the suite (the trap)"),
        criteria: get(r, "Rubric criteria tested").split(";").map((s) => s.trim()).filter(Boolean),
        questionType: get(r, "Question type", "Criterion targeted"),
        difficulty: get(r, "Difficulty"),
        section: get(r, "Section"),
        sourceNames: get(r, "Source Link"),
        sourceUrls: urlMap[id] ?? [],
      };
    });
}

/** Concrete facts in a cell that can be checked by string match: dollar amounts, emails, phone numbers, dates. */
export function atoms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion))?/gi)) out.add(m[0].replace(/\s/g, "").toLowerCase());
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g)) out.add(m[0].replace(/\D/g, ""));
  for (const m of text.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g)) out.add(m[0].toLowerCase());
  return [...out];
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\$\s+/g, "$")
    .replace(/(\d),(\d{3})/g, "$1$2");
}

/** Which atoms appear in a text (phone numbers are matched on digits only). */
export function atomsFound(list: string[], text: string): string[] {
  const t = normalizeForMatch(text);
  const digits = text.replace(/\D/g, "");
  return list.filter((a) => (/^\d{10}$/.test(a) ? digits.includes(a) : t.includes(normalizeForMatch(a).replace(/,/g, ""))));
}

export function isUnanswerable(t: TestCase): boolean {
  return /unanswerable/i.test(t.questionType) || /^not on site/i.test(t.expected.trim());
}

export type Grade = "Pass" | "Partial" | "Fail" | "N/A";

/** Answer Accuracy rubric. Critical: Correct, Current, Grounded. Major: Cited, Knows its limits. Minor: Direct. */
export const AA_CRITERIA = [
  { key: "C1", name: "Correct", severity: "Critical" },
  { key: "C2", name: "Current", severity: "Critical" },
  { key: "C3", name: "Grounded", severity: "Critical" },
  { key: "C4", name: "Cited", severity: "Major" },
  { key: "C5", name: "Knows its limits", severity: "Major" },
  { key: "C6", name: "Direct", severity: "Minor" },
] as const;

export const CONV_CRITERIA = [
  { key: "C1", name: "Goal reached", severity: "Critical" },
  { key: "C2", name: "Clarifies", severity: "Major" },
  { key: "C3", name: "Stays in scope", severity: "Critical" },
  { key: "C4", name: "Follow-ups", severity: "Major" },
  { key: "C5", name: "Handoff", severity: "Major" },
  { key: "C6", name: "Plain language", severity: "Minor" },
] as const;

/**
 * The rubric's combine rule: a Partial or Fail on a Critical criterion fails the answer; a Fail on a
 * Major criterion fails it; any other Partial (or a Minor Fail) makes it Partial; N/A is skipped.
 */
export function combine(
  grades: Record<string, Grade | undefined>,
  criteria: readonly { key: string; name: string; severity: string }[],
): { overall: "Pass" | "Partial" | "Fail"; critical: string[]; failedOn: string[] } {
  const critical: string[] = [];
  const failedOn: string[] = [];
  let partial = false;
  for (const c of criteria) {
    const g = grades[c.key];
    if (!g || g === "N/A" || g === "Pass") continue;
    if (c.severity === "Critical") {
      critical.push(`${c.key} ${c.name} (${g})`);
      failedOn.push(c.key);
    } else if (c.severity === "Major" && g === "Fail") {
      failedOn.push(c.key);
    } else {
      partial = true;
    }
  }
  const overall = failedOn.length ? "Fail" : partial ? "Partial" : "Pass";
  return { overall, critical, failedOn };
}
