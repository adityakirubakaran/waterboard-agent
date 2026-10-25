import type { AgentAnswer, AnswerStatus, ChatMessage, CitedSource } from "./types";
import { loadCorpus, normalize, retrieve, type Corpus, type Hit } from "./retrieval";
import { CHAT_MODEL, REWRITE_MODEL, embedTexts, gemini, withRetry } from "./gemini";
import { CONTACT_PAGE, REGIONAL_MAP, RESPONSE_SCHEMA, REWRITE_INSTRUCTION, systemInstruction } from "./prompt";

export const MAX_QUESTION_CHARS = 1000;
export const MAX_TURNS = 12;

/** A model call: takes the system prompt and the conversation, returns raw JSON text. Swappable in tests. */
export type ModelCall = (system: string, contents: { role: "user" | "model"; text: string }[]) => Promise<{
  text: string;
  model?: string;
}>;

export const geminiCall: ModelCall = async (system, contents) => {
  const ai = gemini();
  const res = await withRetry(
    () =>
      ai.models.generateContent({
        model: CHAT_MODEL,
        contents: contents.map((c) => ({ role: c.role, parts: [{ text: c.text }] })),
        config: {
          systemInstruction: system,
          temperature: 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_SCHEMA,
          // No `tools`: the model cannot search the web, open URLs or run code.
        },
      }),
    "generate",
  );
  return { text: res.text ?? "", model: res.modelVersion ?? CHAT_MODEL };
};

/** Turns the conversation into up to three standalone search queries in the site's own terms. Search only; it never answers. */
export type QueryRewriter = (messages: ChatMessage[]) => Promise<string[] | undefined>;

export const geminiRewrite: QueryRewriter = async (messages) => {
  if (process.env.QUERY_REWRITE === "off") return undefined;
  const ai = gemini();
  const convo = messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Visitor" : "Assistant"}: ${m.content.slice(0, 600)}`)
    .join("\n");
  const res = await ai.models.generateContent({
    model: REWRITE_MODEL,
    contents: [{ role: "user", parts: [{ text: convo }] }],
    config: {
      systemInstruction: REWRITE_INSTRUCTION,
      temperature: 0,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: { queries: { type: "array", items: { type: "string" } } },
        required: ["queries"],
      },
    },
  });
  const parsed = JSON.parse(res.text ?? "{}");
  const qs = (Array.isArray(parsed.queries) ? parsed.queries : [parsed.query])
    .map((q: unknown) => String(q ?? "").trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 3);
  return qs.length ? qs : undefined;
};

export function todayPacific(d = new Date()): string {
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** For follow-ups ("what about Grade III?") search with the previous question too. */
export function retrievalQuery(messages: ChatMessage[]): string {
  const users = messages.filter((m) => m.role === "user").map((m) => m.content);
  const last = users[users.length - 1] ?? "";
  const prev = users[users.length - 2];
  return prev && last.split(/\s+/).length < 12 ? `${prev}\n${last}` : last;
}

function sourceLink(hit: Hit): CitedSource {
  const c = hit.chunk;
  const url = c.format === "pdf" && c.page && c.page > 1 ? `${c.url}#page=${c.page}` : c.url;
  return { title: c.title, url, page: c.format === "pdf" ? c.page : undefined, sourceId: c.sourceId };
}

export function formatExcerpts(corpus: Corpus, hits: Hit[]): string {
  return hits
    .map((h, i) => {
      const c = h.chunk;
      const src = corpus.sourcesById.get(c.sourceId);
      const where = c.format === "pdf" ? `PDF, page ${c.page ?? 1}` : "web page";
      const dated = src?.pageLastUpdated ? `; date printed on it: ${src.pageLastUpdated}` : "";
      const heading = c.heading ? `\nSection: ${c.heading}` : "";
      return `[E${i + 1}] ${c.title} (${where}${dated})\nLink: ${c.url}${heading}\n${c.text}`;
    })
    .join("\n\n---\n\n");
}

const URL_RE = /\bhttps?:\/\/[^\s)\]>"']+/gi;

/** Remove any web address the model typed that is not one of our sources or fixed referrals. */
export function stripUnknownUrls(answer: string, allowed: Set<string>): { text: string; removed: string[] } {
  const removed: string[] = [];
  const text = answer.replace(URL_RE, (u) => {
    const clean = u.replace(/[.,;:]+$/, "");
    const base = clean.split("#")[0];
    if (allowed.has(base) || allowed.has(base.replace(/\/$/, ""))) return u;
    removed.push(clean);
    return "";
  });
  return { text: text.replace(/\(\s*\)/g, "").replace(/ {2,}/g, " ").trim(), removed };
}

export function handoffText(): string {
  return (
    "I couldn't find that in the pages I was given, so I don't want to guess. " +
    "Please check with Water Boards staff through the Contact Us page, or use the regional board map to find your local office."
  );
}

const FIXED_REFERRALS: CitedSource[] = [
  { title: "Water Boards Contact Us page", url: CONTACT_PAGE, sourceId: "referral" },
  { title: "Regional board map", url: REGIONAL_MAP, sourceId: "referral" },
];

export interface AnswerOptions {
  corpus?: Corpus;
  model?: ModelCall;
  embedQuery?: (q: string) => Promise<Float32Array | undefined>;
  /** Query rewriting before search; pass false to search with the visitor's words only. */
  rewrite?: QueryRewriter | false;
  today?: string;
  k?: number;
}

export const geminiEmbedQuery = async (q: string): Promise<Float32Array | undefined> => {
  try {
    const [v] = await embedTexts([q], "RETRIEVAL_QUERY");
    return v?.length ? normalize(v) : undefined;
  } catch (e) {
    console.warn("[agent] query embedding failed, using keyword search only:", String(e).slice(0, 200));
    return undefined;
  }
};

export async function answerQuestion(messages: ChatMessage[], opts: AnswerOptions = {}): Promise<AgentAnswer> {
  const corpus = opts.corpus ?? loadCorpus();
  const model = opts.model ?? geminiCall;
  const convo = messages.slice(-MAX_TURNS);
  const question = convo[convo.length - 1]?.content?.trim() ?? "";

  const base = retrievalQuery(convo);
  let rewritten: string[] | undefined;
  if (opts.rewrite !== false) {
    try {
      rewritten = await (opts.rewrite ?? geminiRewrite)(convo);
    } catch (e) {
      console.warn("[agent] query rewrite failed, searching with the visitor's words:", String(e).slice(0, 200));
    }
  }
  const queries = [base, ...(rewritten ?? [])];
  const queryVector = corpus.vectors ? await (opts.embedQuery ?? geminiEmbedQuery)(rewritten?.[0] ?? base) : undefined;
  const hits = retrieve(corpus, queries, { k: opts.k ?? 10, queryVector });

  const contents: { role: "user" | "model"; text: string }[] = convo.slice(0, -1).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    text: m.content,
  }));
  contents.push({
    role: "user",
    text: `EXCERPTS (the only material you may use):\n\n${hits.length ? formatExcerpts(corpus, hits) : "(none found)"}\n\nVISITOR'S QUESTION: ${question}`,
  });

  const raw = await model(systemInstruction(opts.today ?? todayPacific()), contents);
  let parsed: { status?: string; answer?: string; citations?: unknown };
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    const m = raw.text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { status: "not_found", answer: handoffText(), citations: [] };
  }

  const statuses: AnswerStatus[] = ["answered", "not_found", "clarify", "out_of_scope"];
  let status: AnswerStatus = statuses.includes(parsed.status as AnswerStatus) ? (parsed.status as AnswerStatus) : "not_found";
  let answer = String(parsed.answer ?? "").trim();
  const rawCitations = Array.isArray(parsed.citations) ? parsed.citations.map(String) : [];

  // Map excerpt ids back to sources, keeping only ids that were actually shown to the model.
  const cited: CitedSource[] = [];
  const seen = new Set<string>();
  for (const id of rawCitations) {
    const n = Number(String(id).replace(/[^0-9]/g, ""));
    const hit = hits[n - 1];
    if (!hit) continue;
    const s = sourceLink(hit);
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    cited.push(s);
  }

  let guardrail: string | undefined;
  // Cited + Grounded: a factual answer with no valid citation is not shown; the visitor is handed off instead.
  if (status === "answered" && cited.length === 0) {
    guardrail = "answered-without-citation";
    status = "not_found";
    answer = handoffText();
  }
  if (!answer) {
    guardrail = guardrail ?? "empty-answer";
    status = "not_found";
    answer = handoffText();
  }

  const allowed = new Set<string>([CONTACT_PAGE, REGIONAL_MAP]);
  for (const s of corpus.meta.sources) {
    allowed.add(s.url);
    allowed.add(s.url.replace(/\/$/, ""));
  }
  const stripped = stripUnknownUrls(answer.replace(/\[E\d+\]/g, "").trim(), allowed);
  answer = stripped.text;
  if (stripped.removed.length) guardrail = [guardrail, `removed-urls:${stripped.removed.length}`].filter(Boolean).join(",");

  const sources =
    (status === "not_found" || status === "out_of_scope") && cited.length === 0 ? FIXED_REFERRALS : cited;

  return {
    status,
    answer,
    sources,
    debug: {
      model: raw.model,
      searchQuery: queries.join(" | "),
      retrieved: hits.map((h) => ({ chunkId: h.chunk.id, sourceId: h.chunk.sourceId, title: h.chunk.title, score: h.score })),
      rawCitations,
      guardrail,
    },
  };
}
