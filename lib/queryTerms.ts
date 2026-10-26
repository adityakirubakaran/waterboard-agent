/**
 * Visitors say "test", "license" and "how much"; Water Board pages say "examination", "certificate" and "fee".
 * This writes one extra search query that adds the site's own words to the question, without calling a model,
 * so the search finds the official schedule or form even when the query-rewrite step is off or misses a term.
 */

const ROMAN = ["", "I", "II", "III", "IV", "V"];

const TERMS: [RegExp, string][] = [
  [/\b(?:tests?|exams?|testing)\b/i, "examination"],
  [/\blicen[cs](?:e[sd]?|ing)\b/i, "certificate certification"],
  [/\b(?:how much|costs?|price[sd]?|pricing|charges?|expensive|fees?)\b/i, "fee schedule"],
  [/\b(?:sewage|sewer plant)\b/i, "wastewater"],
  [/\b(?:appeal|challenge)\b/i, "petition for review"],
  [/\bgas station tanks?\b/i, "underground storage tank UST"],
  [/\bstock ?ponds?\b/i, "Livestock Stockpond registration"],
  [/\b(?:credit|debit) cards?\b|\bpay(?:ing)? online\b/i, "payment methods accepted ACH EFT electronic payment"],
  [/\b(?:written|public) comments?\b/i, "comment letters commentletters agenda deadline"],
  [/\bwater quality (?:rules|standards|regulations)\b/i, "Basin Plan water quality control plan"],
  [/\b(?:my|our)\b.*\b(?:status|processed|owe|balance|account|application)\b/i, "program contact phone email"],
];

export function officialTermsQuery(question: string): string | undefined {
  const q = question.replace(/\s+/g, " ").trim();
  const add: string[] = [];
  for (const [re, terms] of TERMS) if (re.test(q)) add.push(terms);
  const words = new Set(q.toLowerCase().split(/\W+/));
  const extra = [...new Set(add.join(" ").split(" "))].filter((w) => !words.has(w.toLowerCase()));
  // wastewater grades are written "Grade II"; drinking water grades are T1-T5 and D1-D5
  for (const m of q.matchAll(/\bgrade\s*([1-9])\b/gi)) {
    const n = Number(m[1]);
    // operator grades stop at 5 (I to V, T5, D5), so a higher grade needs the program's contact, not a fee
    if (n > 5) {
      extra.push("grades I to V program contact phone email");
      continue;
    }
    extra.push(`Grade ${ROMAN[n]}`);
    if (/drinking|treatment|distribution/i.test(q)) extra.push(`T${n} D${n}`);
  }
  return extra.length ? `${q} ${extra.join(" ")}` : undefined;
}
