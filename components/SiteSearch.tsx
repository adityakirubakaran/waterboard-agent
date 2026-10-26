"use client";

import { useState } from "react";
import { askAssistant } from "./ask";

/** The hero question box. It hands the question to the assistant in the corner. */
export default function SiteSearch() {
  const [q, setQ] = useState("");
  return (
    <form
      className="askbox"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) askAssistant(q.trim());
        setQ("");
      }}
    >
      <label htmlFor="site-ask" className="sr-only">
        Your question
      </label>
      <svg className="askbox-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </svg>
      <input
        id="site-ask"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Ask about a fee, permit, deadline or form"
        autoComplete="off"
      />
      <button type="submit">Ask</button>
    </form>
  );
}
