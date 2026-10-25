"use client";

import { useState } from "react";
import { askAssistant } from "./ask";

/** The header search box hands the query to the assistant. */
export default function SiteSearch() {
  const [q, setQ] = useState("");
  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) askAssistant(q.trim());
        setQ("");
      }}
    >
      <label htmlFor="site-search" className="sr-only">
        Ask a question
      </label>
      <input id="site-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question about the Water Boards" />
      <button type="submit">Ask</button>
    </form>
  );
}
