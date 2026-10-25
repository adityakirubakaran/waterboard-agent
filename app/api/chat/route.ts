import { NextResponse } from "next/server";
import { answerQuestion, MAX_QUESTION_CHARS, MAX_TURNS } from "@/lib/agent";
import { hasGeminiKey } from "@/lib/gemini";
import { logQuestion } from "@/lib/questionLog";
import { corpusAvailable } from "@/lib/retrieval";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  messages?: ChatMessage[];
  session?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const messages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_CHARS) }));
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !last.content.trim()) {
    return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  }
  if (!hasGeminiKey()) {
    return NextResponse.json({ error: "The assistant is not configured yet (missing GEMINI_API_KEY)." }, { status: 503 });
  }

  if (!corpusAvailable()) {
    return NextResponse.json({ error: "The assistant's data store has not been built yet (run npm run corpus)." }, { status: 503 });
  }

  const turn = messages.filter((m) => m.role === "user").length;
  try {
    const result = await answerQuestion(messages);
    await logQuestion({
      at: new Date().toISOString(),
      session: body.session ?? "unknown",
      turn,
      question: last.content,
      status: result.status,
    });
    return NextResponse.json({ status: result.status, answer: result.answer, sources: result.sources });
  } catch (e) {
    console.error("[chat] failed:", e);
    await logQuestion({ at: new Date().toISOString(), session: body.session ?? "unknown", turn, question: last.content, status: "error" });
    return NextResponse.json(
      { error: "Sorry, something went wrong on our side. Please try again in a moment." },
      { status: 500 },
    );
  }
}
