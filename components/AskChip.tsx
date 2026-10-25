"use client";

import { askAssistant } from "./ask";

export default function AskChip({ question }: { question: string }) {
  return (
    <button type="button" className="chip" onClick={() => askAssistant(question)}>
      {question}
    </button>
  );
}
