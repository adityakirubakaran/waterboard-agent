import { Redis } from "@upstash/redis";

/**
 * Logs the questions people type so the team can see what visitors look for first.
 * Only the question text is kept (with emails and phone numbers masked), plus the time,
 * a random per-tab session id and the turn number. No names, emails, IPs or answers.
 */

export interface LoggedQuestion {
  at: string;
  session: string; // random id made in the browser tab, not tied to a person
  turn: number; // 1 = first question in that chat
  question: string;
  status?: string;
}

const KEY = "questions";

export function scrub(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email removed]")
    .replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone removed]")
    .replace(/\b([Mm]y name is|[Nn]ame:)\s+([A-Z][a-z'-]+(\s+[A-Z][a-z'-]+)?)/g, "$1 [name removed]")
    .slice(0, 1000);
}

function redis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export async function logQuestion(entry: LoggedQuestion): Promise<void> {
  const clean: LoggedQuestion = { ...entry, question: scrub(entry.question), session: entry.session.slice(0, 40) };
  const r = redis();
  if (!r) {
    // Without a database the line still lands in the hosting logs (Vercel → Logs).
    console.log("[question]", JSON.stringify(clean));
    return;
  }
  try {
    await r.rpush(KEY, JSON.stringify(clean));
  } catch (e) {
    console.error("[question] log failed:", String(e).slice(0, 200));
    console.log("[question]", JSON.stringify(clean));
  }
}

export async function readQuestions(): Promise<LoggedQuestion[] | null> {
  const r = redis();
  if (!r) return null;
  const rows = await r.lrange<string | LoggedQuestion>(KEY, 0, -1);
  return rows.map((x) => (typeof x === "string" ? (JSON.parse(x) as LoggedQuestion) : x));
}
