"use client";

import { askAssistant } from "./ask";

/** A question that opens the assistant and asks it. "chip" sits under the hero box; "inline" ends a program list. */
export default function AskChip({ question, variant = "chip" }: { question: string; variant?: "chip" | "inline" }) {
  return (
    <button type="button" className={variant === "chip" ? "chip" : "ask-inline"} onClick={() => askAssistant(question)}>
      {variant === "inline" ? (
        <>
          <span className="ask-inline-label">Ask</span> {question}
        </>
      ) : (
        question
      )}
    </button>
  );
}
