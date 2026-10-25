/**
 * Ask the agent one question from the terminal and see what it searched for and what it cited.
 *
 *   npm run ask -- "How much is the grade 2 drinking water exam?"
 *   npm run ask -- "Do I need a storm water permit?" "We run a metal parts factory"   (multi-turn)
 */
import "../lib/env";
import { answerQuestion } from "../lib/agent";
import type { ChatMessage } from "../lib/types";

async function main() {
  const turns = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!turns.length) {
    console.log('Usage: npm run ask -- "your question" ["follow-up" ...]');
    return;
  }
  const messages: ChatMessage[] = [];
  for (const t of turns) {
    messages.push({ role: "user", content: t });
    const r = await answerQuestion(messages);
    messages.push({ role: "assistant", content: r.answer });
    console.log(`\nVISITOR: ${t}`);
    console.log(`SEARCHED: ${r.debug?.searchQuery?.replace(/\n/g, " | ")}`);
    console.log(`TOP PASSAGES:\n${(r.debug?.retrieved ?? []).map((h, i) => `  E${i + 1} ${h.chunkId} ${h.title}`).join("\n")}`);
    console.log(`\nAGENT [${r.status}${r.debug?.guardrail ? `, guardrail: ${r.debug.guardrail}` : ""}]: ${r.answer}`);
    for (const s of r.sources) console.log(`  source: ${s.title} <${s.url}>`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
