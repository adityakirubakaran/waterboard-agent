"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DISCLAIMER } from "@/lib/constants";
import { ASK_EVENT } from "./ask";

interface Source {
  title: string;
  url: string;
  page?: number;
}
interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  status?: string;
  error?: boolean;
}

const STARTERS = [
  "How much is the grade 2 drinking water operator exam?",
  "When is my annual water use report due?",
  "Do I need a storm water permit for my business?",
  "How much does it cost to register a small stock pond?",
];

/** A random id per browser tab, so the log can group one visitor's questions without knowing who they are. */
function sessionId(): string {
  const make = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  try {
    const existing = sessionStorage.getItem("wb-session");
    if (existing) return existing;
    const id = make();
    sessionStorage.setItem("wb-session", id);
    return id;
  } catch {
    return make();
  }
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z" />
      <path d="M8.5 10.5h7M8.5 13.5h4.5" />
    </svg>
  );
}

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const session = useRef<string>("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const msgsRef = useRef<Msg[]>([]);
  msgsRef.current = msgs;

  useEffect(() => {
    session.current = sessionId();
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      setOpen(true);
      setInput("");
      const history: Msg[] = [...msgsRef.current.filter((m) => !m.error), { role: "user", content: q }];
      setMsgs((m) => [...m, { role: "user", content: q }]);
      setBusy(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: session.current,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Something went wrong. Please try again.");
        setMsgs((m) => [...m, { role: "assistant", content: data.answer, sources: data.sources ?? [], status: data.status }]);
      } catch (e) {
        setMsgs((m) => [...m, { role: "assistant", content: String((e as Error).message ?? e), error: true }]);
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy],
  );

  // Buttons and the search box elsewhere on the page open the chat with a question.
  useEffect(() => {
    const onAsk = (e: Event) => void send(String((e as CustomEvent).detail ?? ""));
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [send]);

  if (!open) {
    return (
      <button type="button" className="chat-launch" onClick={() => setOpen(true)} aria-label="Open the Water Boards Assistant">
        <ChatIcon />
        Ask the Water Boards Assistant
      </button>
    );
  }

  return (
    <section className="chat-panel" role="dialog" aria-label="Water Boards Assistant">
      <div className="chat-head">
        <span className="title">Water Boards Assistant</span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close chat">
          ×
        </button>
      </div>
      <div className="chat-disclaimer">{DISCLAIMER}</div>

      <div className="chat-body" ref={bodyRef} aria-live="polite">
        {msgs.length === 0 && (
          <div className="chat-intro">
            <p>
              Hi! I answer questions using a set of Water Board web pages and files, and I link the page each answer comes
              from. If I can&apos;t find something, I&apos;ll say so and point you to the right staff.
            </p>
            <p>I can&apos;t give legal advice or look up your own permit, application or payment.</p>
            <div className="chips">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role === "user" ? "user" : "bot"}${m.error ? " error" : ""}`}>
            {m.content}
            {m.role === "assistant" && !m.error && m.sources && m.sources.length > 0 && (
              <div className="sources">
                <div className="sources-label">{m.status === "answered" ? "Sources" : "Where to get help"}</div>
                <ol>
                  {m.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.title}
                      </a>
                      {s.page ? ` (page ${s.page})` : ""}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        ))}
        {busy && <div className="typing">Looking through the Water Board pages…</div>}
      </div>

      <div className="chat-notice">
        We save the questions you type (not your name or email) to improve this prototype. Please don&apos;t include
        personal details.
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Your question
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={1}
          value={input}
          maxLength={1000}
          placeholder="Type your question"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
