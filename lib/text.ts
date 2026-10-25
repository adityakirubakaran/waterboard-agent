/** Tokenizing, light stemming and visitor-word expansion for the keyword (BM25) retriever. */

const STOP = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to was we were what when where " +
    "which who why will with would you your yours about any also just much many more most should may might must " +
    "get got need want like please tell know"
  ).split(" "),
);

/** Visitors rarely use the site's words, so expand a few common ones before searching. */
const EXPAND: Record<string, string[]> = {
  test: ["exam", "examination"],
  tests: ["exam", "examination"],
  exam: ["examination"],
  license: ["certificate", "certification"],
  licence: ["certificate", "certification"],
  level: ["grade"],
  cost: ["fee"],
  costs: ["fee"],
  price: ["fee"],
  pay: ["fee", "payment"],
  appeal: ["petition"],
  dumping: ["discharge", "complaint"],
  creek: ["stream", "water"],
  sewer: ["wastewater"],
  sewage: ["wastewater"],
  tank: ["ust", "storage"],
  tanks: ["ust", "storage"],
  gas: ["fuel", "petroleum"],
  loan: ["srf", "financing"],
  grant: ["funding"],
  rain: ["stormwater"],
  runoff: ["stormwater"],
  stormwater: ["storm"],
  report: ["reporting"],
  deadline: ["due"],
  office: ["contact", "address"],
  phone: ["contact"],
  weed: ["cannabis"],
  marijuana: ["cannabis"],
  pot: ["cannabis"],
  well: ["groundwater"],
  pond: ["stockpond", "registration"],
};

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+(?:['.][a-z0-9]+)*/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    out.push(stem(w.replace(/'s$/, "")));
  }
  return out;
}

export function tokenizeQuery(text: string): string[] {
  const base = text.toLowerCase().match(/[a-z0-9]+(?:['.][a-z0-9]+)*/g) ?? [];
  const out: string[] = [];
  for (const w of base) {
    if (!STOP.has(w)) out.push(stem(w));
    for (const extra of EXPAND[w] ?? []) out.push(stem(extra));
  }
  return out;
}

/** Collapse whitespace while keeping paragraph breaks. */
export function cleanText(s: string): string {
  return s
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
