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

function Drop() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 4c6.5 8.7 11 14.6 11 20.2A11 11 0 0 1 9 24.2C9 18.6 13.5 12.7 20 4Z" fill="currentColor" />
    </svg>
  );
}

function isPdf(url: string) {
  return /\.pdf(#|$)/i.test(url);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // grow the text box with its content, up to a few lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [input]);

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
        if (!res.ok) throw new Error(data.error ?? "The assistant didn't respond. Try again in a moment.");
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

  // the hero box, the "Try" questions and the program questions open the chat with a question
  useEffect(() => {
    const onAsk = (e: Event) => void send(String((e as CustomEvent).detail ?? ""));
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [send]);

  if (!open) {
    return (
      <button type="button" className="launcher" onClick={() => setOpen(true)}>
        <span className="launcher-mark">
          <Drop />
        </span>
        Ask the Water Boards
      </button>
    );
  }

  return (
    <section className="chat" role="dialog" aria-label="Water Boards Assistant">
      <header className="chat-head">
        <span className="chat-mark">
          <Drop />
        </span>
        <div className="chat-title">
          <h2>Water Boards Assistant</h2>
          <p>Answers from saved Water Board pages</p>
        </div>
        <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Close the assistant">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <p className="chat-disclaimer">{DISCLAIMER}</p>

      <div className="chat-body" ref={bodyRef} aria-live="polite">
        {msgs.length === 0 && (
          <div className="chat-intro">
            <p>
              Ask about fees, permits, deadlines or forms. I&apos;ll answer from Water Board pages and link where it came
              from. If I can&apos;t find it, I&apos;ll tell you who to contact.
            </p>
            <p className="chat-intro-note">I can&apos;t give legal advice or look up your own permit, application or payment.</p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s} type="button" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg msg-user">
              {m.content}
            </div>
          ) : (
            <div key={i} className={`msg msg-bot${m.error ? " msg-error" : ""}${m.status && m.status !== "answered" ? " msg-handoff" : ""}`}>
              <div className="msg-text">{m.content}</div>
              {!m.error && m.sources && m.sources.length > 0 && (
                <div className="msg-sources">
                  <p>{m.status === "answered" ? "Sources" : "Where to get help"}</p>
                  <ul>
                    {m.sources.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer">
                          <span className={`doc-badge${isPdf(s.url) ? " doc-pdf" : ""}`}>{isPdf(s.url) ? "PDF" : "Page"}</span>
                          <span className="doc-title">
                            {s.title}
                            {s.page && s.page > 1 ? <span className="doc-page">, page {s.page}</span> : null}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ),
        )}

        {busy && (
          <div className="typing" aria-label="The assistant is looking through the pages">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <form
        className="composer"
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
          placeholder="Ask a question"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12h15M13 6l6 6-6 6" />
          </svg>
        </button>
      </form>
      <p className="chat-notice">We save the questions you type, not your name or email. Please leave out personal details.</p>
    </section>
  );
}
