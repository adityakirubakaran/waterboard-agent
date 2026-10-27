/**
 * Finding places where two Water Boards pages give a visitor different answers to the same question.
 *
 *  1. Claims: pull checkable statements out of every passage (fees, deadlines for things visitors file or pay,
 *     office phone numbers, and whether cards are accepted), each with the words that say what it is about.
 *  2. Vectors: turn each claim's words into a vector with the numbers masked out, so two sentences that say
 *     the same thing with different numbers land on top of each other. Pair each claim with its closest
 *     claims of the same kind on other pages.
 *  3. Values: keep only pairs whose values really differ ("before February 1" and "January 31" are the same
 *     deadline; "$382" and "$382.00" are the same fee).
 *  4. Guards: drop pairs that are about different things (Grade I vs Grade II, registration vs annual fee,
 *     drinking water vs wastewater) or different periods (FY 2018-19 vs this year), and one-off dates that
 *     differ by design (comment periods, hearings).
 *  5. What is left is a "likely conflict" for a person to check on the live site. Nothing is called a
 *     conflict until someone has read both pages.
 */
import { tokenize } from "./text";

export type ClaimType = "fee" | "deadline" | "phone" | "card";

export interface ClaimDoc {
  url: string;
  title: string;
  date?: string; // date printed on the page or file
}

export interface Claim {
  id: number;
  type: ClaimType;
  chunkId: string;
  doc: ClaimDoc;
  raw: string; // the value as written: "$250", "no later than February 1", "(916) 341-5300"
  value: string; // normalized: "250", "02-01" or "2027-01-31", "9163415300", "no" / "yes"
  sentence: string; // the sentence or table line it came from
  window: string; // the words around the value (the claim's subject)
  masked: string; // window with every number, date and contact masked (what the vector is built from)
  subject: string[]; // the content words that say what the value is about
  others: Set<string>; // every normalized value of the same type in the same sentence
  periods: string[]; // fiscal or calendar years the window is about ("2018-19", "2026")
  dims: Record<string, string[]>; // subject markers: grade, program, fee kind, region, unit
}

// ------------------------------------------------------------------ patterns

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(January|February|March|April|May|June|July|August|September|October|November|December)";
const DATE_RE = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+((?:19|20)\\d{2}))?\\b`, "g");
const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?(?!\d)/g;
const PHONE_RE = /(?<![\d-])\(?(\d{3})\)?[\s.-]{0,2}(\d{3})[\s.-](\d{4})(?![\d-])/g;
const EMAIL_RE = /\b[\w.+-]+@waterboards\.ca\.gov\b/gi;
const CARD_RE = /\b(credit|debit)\s+cards?\b/i;

/** Words right before a date that make it a deadline, and how to read them (exclusive = the day before). */
const DEADLINE_BEFORE = /(no later than|not later than|on or before|prior to|before|by|due(?: on| by)?|deadline(?: is| of)?)\s+(?:the\s+)?(?:\d{1,2}:\d{2}\s*[ap]\.?m\.?\s*(?:\(noon\)\s*)?(?:on\s+)?)?$/i;
const EXCLUSIVE = /^(before|prior to)$/i;

/** One-off dates that are different on every notice by design. */
const ONE_OFF = /\b(comments?|hearings?|meetings?|workshops?|testimony|solicitation|nominations?|proposals?|webinar|listening session|scoping|public notice|rfp|rfq|bids?|award(?:ed|s)?|released?|posted|adopted|issued|signed|translation|interpret\w*|sign language|accommodation|poll|survey|rsvp)\b/i;
/**
 * Dated records describe one moment (an agenda, a notice, an order, a meeting's slides, a draft, last decade's fee
 * schedule), so two of them can differ without either being wrong. Only pages a visitor reads as current guidance
 * are compared: web pages, forms, FAQs, guides, regulations and this year's or last year's fee schedules.
 */
const RECORD = /(agenda|minutes|notice|aviso|hearing|workshop|presentation|handout|slides|staff[_ -]?report|resolution|adopted_orders|board_decisions|\/orders?\/|\border (no\.?|r\d)|\/permits\/|public_notices|\/comments?\/|comment letter|press|newsletter|white ?paper|needs assessment|\/needs\/|draft|proposed|strike ?out|redline|\bisor\b|nopr|fsor|statement of reasons|transcript|meeting|mtg|webinar|petition|\bdecision|bulletin|\/archives?\/|_archive|memo|financial statement|audit)/i;

/**
 * True when a page is a dated record rather than current guidance (see RECORD), or is filed under a past year
 * (".../docs/2019/...", "fy1617_fees.pdf", a title naming "FY 2016-17"). A title that only says when the page was
 * last updated ("Updated 6/5/2017") does not make it a record: old guidance that is still online is what we want to find.
 */
export function isRecord(doc: ClaimDoc, now = new Date()): boolean {
  const s = `${doc.url} ${doc.title}`;
  if (RECORD.test(s)) return true;
  const path = doc.url.replace(/^https?:\/\/[^/]+/, "");
  const fyTitle = [...doc.title.matchAll(/\b(?:fy|fiscal year)\s*((?:19|20)\d{2})/gi)].map((m) => m[1]).join(" ");
  const years = [...`${path} ${fyTitle}`.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)|fy[_ -]?(\d{2})[_ -]?(\d{2})(?!\d)/gi)].map((m) =>
    m[1] ? Number(m[1]) : 2000 + Number(m[3]),
  );
  return years.length > 0 && Math.max(...years) < now.getFullYear() - 1;
}

/** Amounts that are case-specific rather than published fees. */
const NOT_A_FEE = /\b(penalt(?:y|ies)|liabilit(?:y|ies)|settlements?|award(?:ed|s)?|grants?|loans?|funding|funds|budget|appropriat\w*|million|billion|cost of the project|project costs?|estimated|reimburse\w*|salary|revenue|invoice[ds]? (?:total|amount))\b/i;
const FEE_WORDS = /\b(fees?|costs?|charges?|price|payable|pay)\b/i;

/** Subject markers: two claims that name different values on one of these are about different things. */
const DIMS: { name: string; re: RegExp; norm?: (m: RegExpExecArray) => string; fromTitle?: boolean }[] = [
  {
    name: "grade",
    re: /\bgrade\s*(iv|v|i{1,3}|[1-5])\b|\b([td])\s?([1-5])\b/gi,
    norm: (m) => (m[1] ? `g${roman(m[1])}` : `${m[2].toLowerCase()}${m[3]}`),
  },
  {
    name: "program",
    re: /\b(wastewater operator|wwocp|wwopcert\w*|drinking water operator|dwocp|dwopcert\w*|water treatment (?:and|or|and\/or) distribution|operator certification|water rights?|water quality certification|wqc|calwatrs|appropriative|riparian|cannabis|stormwater|storm water|underground storage tank|ust|groundwater recordation|laboratory|elap|recycled water|onsite wastewater|septic|dairy|irrigated lands|npdes|waste discharge requirements|wdr)\b/gi,
    norm: (m) => programKey(m[1]),
    fromTitle: true,
  },
  {
    name: "kind",
    re: /\b(registration|annual|renewal|application|re-?examination|re-?exam|examination|exam|late|filing|petition|change|transfer|extension|certificate|reinstatement|duplicate|replacement|reciprocity|appeal)\b/gi,
    norm: (m) => kindKey(m[1]),
  },
  {
    name: "user",
    re: /\b(small domestic|livestock stock ?pond|stock ?pond|small irrigation|siur|cannabis|irrigation|municipal|industrial|construction)\b/gi,
    norm: (m) => m[1].toLowerCase().replace(/\s+/g, " ").replace("livestock ", "").replace("stock pond", "stockpond"),
    fromTitle: true,
  },
  {
    // what is due: a deadline for one report says nothing about another report's deadline
    name: "due",
    re: /\b(eAR|electronic annual report|consumer confidence reports?|CCRs?|supplemental statements?|initial statements?|statements? of (?:water )?diversion and use|annual reports?|water use reports?|reports? for the previous water year|groundwater recordation|measuring devices?|measurement method\w*|alternative compliance plans?|ACPs?|monitoring reports?|disbursement requests?|invoices?|renewal|continuing education)\b/gi,
    norm: (m) => dueKey(m[1]),
  },
  {
    name: "region",
    re: /\b(north coast|san francisco bay|central coast|los angeles|central valley|lahontan|colorado river|santa ana|san diego|region\s*[1-9][a-z]?|fresno|redding|sacramento|oakland|riverside|victorville|south lake tahoe|san luis obispo|santa rosa|palm desert)\b/gi,
    norm: (m) => m[1].toLowerCase().replace(/\s+/g, " "),
  },
  { name: "unit", re: /\bper\s+([a-z-]+(?:\s+[a-z-]+)?)/gi, norm: (m) => m[1].toLowerCase().split(" ")[0] },
  { name: "line", re: /\b(fax\w*|toll[- ]free|tty|main line|phone|tel)\b/gi, norm: (m) => (/fax/i.test(m[1]) ? "fax" : /toll|tty/i.test(m[1]) ? m[1].toLowerCase() : "phone") },
];

function roman(s: string): string {
  const r: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5" };
  return r[s.toLowerCase()] ?? s;
}
function programKey(s: string): string {
  const t = s.toLowerCase();
  if (/wastewater operator|wwocp|wwopcert/.test(t)) return "wastewater operators";
  if (/drinking water operator|dwocp|dwopcert|treatment (and|or|and\/or) distribution/.test(t)) return "drinking water operators";
  if (/operator certification/.test(t)) return "operators";
  if (/water quality certification|wqc/.test(t)) return "water quality certification";
  if (/water right|calwatrs|appropriative|riparian/.test(t)) return "water rights";
  if (/storm ?water/.test(t)) return "stormwater";
  if (/underground storage tank|^ust$/.test(t)) return "tanks";
  if (/laboratory|elap/.test(t)) return "labs";
  if (/onsite wastewater|septic/.test(t)) return "septic";
  if (/waste discharge|wdr/.test(t)) return "wdr";
  return t;
}
function dueKey(s: string): string {
  const t = s.toLowerCase();
  if (/^ear$|electronic annual/.test(t)) return "eAR";
  if (/consumer confidence|^ccrs?$/.test(t)) return "CCR";
  if (/supplemental statement/.test(t)) return "supplemental statement";
  if (/initial statement/.test(t)) return "initial statement";
  if (/statements? of/.test(t)) return "annual water use report";
  if (/annual report|water use report|previous water year/.test(t)) return "annual water use report";
  if (/measur|alternative compliance|^acps?$/.test(t)) return "measurement";
  return t.replace(/s$/, "");
}

function kindKey(s: string): string {
  const t = s.toLowerCase().replace("-", "");
  if (/^reexam/.test(t)) return "re-exam";
  if (/^exam/.test(t)) return "exam";
  return t;
}

// ------------------------------------------------------------------ claims

/** Split a passage into sentences and table lines. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z“"(])/)) {
      const t = s.trim();
      if (t.length >= 8 || /^(yes|no)\b/i.test(t)) out.push(t); // keep a FAQ's bare "No."
    }
  }
  return out;
}

/** The words around a match: up to `before` words before it and `after` words after it, inside the sentence. */
export function windowAround(sentence: string, start: number, end: number, before = 16, after = 8): string {
  const left = sentence.slice(0, start).split(/\s+/).filter(Boolean).slice(-before).join(" ");
  const right = sentence.slice(end).split(/\s+/).filter(Boolean).slice(0, after).join(" ");
  return `${left} ${sentence.slice(start, end)} ${right}`.trim();
}

export function mask(s: string): string {
  return s
    .replace(EMAIL_RE, " EMAIL ")
    .replace(MONEY_RE, " AMOUNT ")
    .replace(DATE_RE, " DATE ")
    .replace(PHONE_RE, " PHONE ")
    .replace(/\b\d[\d,.:-]*\b/g, " NUM ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fiscal years and calendar years a window is about: "FY 2018-19" -> "2018-19", "2026" -> "2026". */
export function periods(s: string): string[] {
  const out = new Set<string>();
  const fy = /\b((?:19|20)\d{2})\s*[-–/]\s*((?:19|20)?\d{2})\b/g;
  let m: RegExpExecArray | null;
  const spans: [number, number][] = [];
  while ((m = fy.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2].length === 2 ? String(a).slice(0, 2) + m[2] : m[2]);
    if (b === a + 1) {
      out.add(`${a}-${String(b).slice(2)}`);
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  const yr = /\b((?:19|20)\d{2})\b/g;
  while ((m = yr.exec(s))) {
    const i = m.index;
    if (spans.some(([a, b]) => i >= a && i < b)) continue;
    out.add(m[1]);
  }
  return [...out];
}

/** Program named by where the file lives, for files whose text never says (a form that only says "this application"). */
export function programFromUrl(url: string): string | undefined {
  const u = url.toLowerCase();
  if (/drinking_water\/certlic\/occupations|dwopcert|dwocp/.test(u)) return "drinking water operators";
  if (/operator_certification|wwopcert|wwocp/.test(u)) return "wastewater operators";
  if (/waterrights|water_rights|calwatrs/.test(u)) return "water rights";
  if (/cannabis/.test(u)) return "cannabis";
  if (/stormwater|storm_water/.test(u)) return "stormwater";
  if (/water_quality|wqc|cwa401|401wqcert/.test(u)) return "water quality certification";
  return undefined;
}

/** Named offices and units ("Office of Public Affairs", "Division of Financial Assistance", "Fee Branch"). */
const UNIT_RE = /\b(?:Office|Division|Bureau) of(?: the)? [A-Z][A-Za-z&]+(?: (?:and |& )?[A-Z][A-Za-z&]+)*|\b(?:[A-Z][A-Za-z]+ ){1,4}(?:Unit|Section|Branch|Program|District)\b/g;
export function units(text: string): string[] {
  return [...new Set([...text.replace(/\s*\|\s*/g, " ").matchAll(UNIT_RE)].map((m) => m[0].toLowerCase().replace(/\s+/g, " ").replace(/^the /, "")))];
}

function dims(window: string, title: string, url = "", type?: ClaimType): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of DIMS) {
    if (d.name === "kind" && type !== "fee") continue; // fee types only separate fees
    if (d.name === "due" && type !== "deadline") continue;
    const vals = new Set<string>();
    for (const src of d.fromTitle ? [window, title] : [window]) {
      d.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = d.re.exec(src))) vals.add(d.norm ? d.norm(m) : m[0].toLowerCase());
      if (vals.size) break; // the window wins over the title
    }
    if (d.name === "program") {
      const p = programFromUrl(url);
      if (!vals.size && p) vals.add(p);
      // "operator certification" alone is vaguer than the drinking water or wastewater program it sits in
      if (vals.has("operators") && [...vals].some((v) => /water operators/.test(v))) vals.delete("operators");
      if (vals.has("operators") && p && /water operators/.test(p)) {
        vals.delete("operators");
        vals.add(p);
      }
    }
    if (vals.size) out[d.name] = [...vals];
  }
  if (type === "phone") {
    const u = units(window);
    if (u.length) out.unit = u;
    // a named person's own line ("Tom.Henderson@...") is not the office's number
    const people = [...window.matchAll(/\b([a-z]+\.[a-z-]+)@[\w.]+\.(?:gov|com|org)\b/gi)].map((m) => m[1].toLowerCase());
    if (people.length) out.person = [...new Set(people)];
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "before February 1" -> last day 01-31; "no later than February 1, 2027" -> 2027-02-01. */
export function effectiveDeadline(qualifier: string, month: string, day: string, year?: string): string {
  const mi = MONTHS.indexOf(month.toLowerCase());
  let y = year ? Number(year) : 2001; // a non-leap placeholder year for "every year" deadlines
  let mo = mi;
  let d = Number(day);
  if (EXCLUSIVE.test(qualifier.trim())) {
    const t = new Date(Date.UTC(y, mo, d - 1));
    y = t.getUTCFullYear();
    mo = t.getUTCMonth();
    d = t.getUTCDate();
  }
  return year ? `${y}-${pad(mo + 1)}-${pad(d)}` : `${pad(mo + 1)}-${pad(d)}`;
}

/** Words that name no subject on their own (labels, the agency's name, masked values). */
const GENERIC = new Set(
  (
    "state water board boards resource resources control regional region california ca division program phone tel telephone fax " +
    "email mail contact call line main number page see total amount date num business hour hours am pm m-f ext extension toll free " +
    "also each per following follow information info visit website web link click here us office suite street ste"
  )
    .split(" ")
    .map((w) => tokenize(w)[0] ?? w),
);
/** A deadline only counts when it is for something a visitor files, pays or renews. */
const OBLIGATION = /\b(reports?|statements?|renew\w*|fees?|payments?|applications?|registr\w*|permits?|certificat\w*|licen[cs]\w*|filed|filing|file|submit\w*|returns?|forms?|invoices?|recordation|plans?)\b/i;

/** The words that say what a value is about: content words with labels, numbers and the agency's name removed. */
export function subjectWords(text: string): string[] {
  return [...new Set(tokenize(mask(text)).filter((t) => !GENERIC.has(t) && !/^\d/.test(t)))];
}

/** Shared words over the shorter list: forgiving when one page says more around the same fact. */
export function overlap(a: string[], b: string[]): { share: number; shared: number } {
  if (!a.length || !b.length) return { share: 0, shared: 0 };
  const B = new Set(b);
  const shared = a.filter((x) => B.has(x)).length;
  return { share: shared / Math.min(a.length, b.length), shared };
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const inter = a.filter((x) => B.has(x)).length;
  return inter / (a.length + b.length - inter);
}

export function extractClaims(
  chunk: { id: string; text: string },
  doc: ClaimDoc,
  startId = 0,
): Claim[] {
  const out: Claim[] = [];
  let id = startId;
  const add = (c: Omit<Claim, "id" | "chunkId" | "doc" | "masked" | "periods" | "dims">, matched: string, dimText = c.window) => {
    out.push({
      ...c,
      id: id++,
      chunkId: chunk.id,
      doc,
      masked: mask(c.window),
      periods: periods(c.window.replace(matched, " ")), // the value's own year is not the subject's period
      dims: dims(dimText, doc.title, doc.url, c.type),
    });
  };
  const all = sentences(chunk.text);
  for (const [si, s] of all.entries()) {
    // fees: the subject is the words since the previous amount ("Grade II $382" -> "Grade II")
    const fees = [...s.matchAll(MONEY_RE)];
    const feeVals = new Set(fees.map((m) => moneyValue(m)));
    const financialRow = fees.length >= 4 && !/\b(grade|fees?)\b/i.test(s);
    if (!financialRow && FEE_WORDS.test(`${s} ${doc.title}`)) {
      let prevEnd = 0;
      for (const m of fees) {
        const left = s.slice(prevEnd, m.index!).split(/\s+/).filter(Boolean).slice(-12).join(" ");
        const right = s.slice(m.index! + m[0].length).split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
        prevEnd = m.index! + m[0].length;
        const w = `${left} ${m[0]} ${right}`.trim();
        const subject = subjectWords(left);
        if (moneyValue(m) === "0" || subject.length < 2 || NOT_A_FEE.test(w)) continue;
        add({ type: "fee", raw: m[0], value: moneyValue(m), sentence: s, window: w, subject, others: feeVals }, m[0]);
      }
    }
    // deadlines: only for things a visitor files, pays or renews, and never one-off event dates
    if (!ONE_OFF.test(s)) {
      const dates = [...s.matchAll(DATE_RE)];
      const dlVals = new Set<string>();
      const dls: { m: RegExpMatchArray; q: string; v: string; w: string }[] = [];
      for (const m of dates) {
        const before = s.slice(Math.max(0, m.index! - 60), m.index!);
        const q = before.match(DEADLINE_BEFORE);
        if (!q) continue;
        if (!OBLIGATION.test(s)) continue;
        // the sentence before often names the thing that is due ("...submit an Annual Report. Reports ... are due ...")
        const w = `${si > 0 ? all[si - 1].split(/\s+/).slice(-20).join(" ") : ""} ${windowAround(s, m.index!, m.index! + m[0].length, 16, 8)}`.trim();
        const v = effectiveDeadline(q[1], m[1], m[2], m[3]);
        dlVals.add(v);
        dls.push({ m, q: q[1], v, w });
      }
      // what is due is often named in the sentence before ("...submit an Annual Report. Reports ... are due ...")
      const around = `${si > 0 ? all[si - 1] : ""} ${s}`;
      for (const d of dls) {
        const subject = subjectWords(around);
        if (subject.length < 2) continue;
        add({ type: "deadline", raw: `${d.q} ${d.m[0]}`, value: d.v, sentence: s, window: d.w, subject, others: dlVals }, d.m[0], around);
      }
    }
    // phone numbers: the subject is the line itself plus the two lines above it (an office name, an address)
    const phones = [...s.matchAll(PHONE_RE)];
    const phoneVals = new Set(phones.map((m) => `${m[1]}${m[2]}${m[3]}`));
    let prevPhone = 0;
    for (const m of phones) {
      const left = s.slice(prevPhone, m.index!).split(/\s+/).filter(Boolean).slice(-12).join(" ");
      prevPhone = m.index! + m[0].length;
      const above = all.slice(Math.max(0, si - 2), si).join(" ").split(/\s+/).slice(-16).join(" ");
      const ctx = `${above} ${left}`;
      const subject = subjectWords(ctx);
      if (subject.length < 2 || !units(ctx).length) continue; // a number only conflicts with another for the same named office
      const w = `${left} ${m[0]} ${s.slice(prevPhone).split(/\s+/).filter(Boolean).slice(0, 3).join(" ")}`.trim();
      const after = s.slice(prevPhone).split(/\s+/).filter(Boolean).slice(0, 8).join(" "); // "... or Jane.Doe@waterboards.ca.gov"
      add({ type: "phone", raw: m[0], value: `${m[1]}${m[2]}${m[3]}`, sentence: `${above} | ${s}`.slice(-400), window: w, subject, others: phoneVals }, m[0], `${ctx} ${after}`);
    }
    // card payments: yes or no. A FAQ question ("Can I use my credit card?") takes its answer from the next sentence.
    const card = s.match(CARD_RE);
    if (card && /\b(pay|payments?|accept\w*|fees?|use)\b/i.test(s) && s.length < 400) {
      let neg: boolean | undefined;
      let said = s;
      if (/\?\s*$/.test(s)) {
        const next = all[si + 1] ?? "";
        if (/^no\b/i.test(next)) neg = true;
        else if (/^yes\b/i.test(next)) neg = false;
        said = `${s} ${next}`;
      } else {
        neg = /\b(not|no|cannot|can't|unable|won't|nor)\b/i.test(s);
      }
      if (neg !== undefined) {
        const w = windowAround(s, card.index!, card.index! + card[0].length, 18, 12);
        const v = neg ? "no" : "yes";
        const d = dims(w, doc.title, doc.url, "card");
        const subject = d.program ?? [];
        if (!subject.length) continue; // a card rule only means something for a named program
        add({ type: "card", raw: neg ? "cards not accepted" : "cards accepted", value: v, sentence: said, window: w, subject, others: new Set([v]) }, card[0]);
      }
    }
  }
  return out;
}

function moneyValue(m: RegExpMatchArray): string {
  const whole = m[1].replace(/,/g, "");
  return m[2] && m[2] !== "00" ? `${whole}.${m[2]}` : whole;
}

// ------------------------------------------------------------------ vectors

export interface Vectors {
  vecs: Map<number, Map<string, number>>; // claim id -> term weights (unit length)
  postings: Map<string, number[]>;
}

/** TF-IDF vectors over the masked windows (words and word pairs), one per claim, unit length. */
export function buildVectors(claims: Claim[]): Vectors {
  const terms = new Map<number, string[]>();
  const df = new Map<string, number>();
  for (const c of claims) {
    const toks = tokenize(c.masked).filter((t) => t.length > 1);
    const grams = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
    terms.set(c.id, grams);
    for (const g of new Set(grams)) df.set(g, (df.get(g) ?? 0) + 1);
  }
  const n = claims.length;
  const vecs = new Map<number, Map<string, number>>();
  const postings = new Map<string, number[]>();
  for (const c of claims) {
    const tf = new Map<string, number>();
    for (const g of terms.get(c.id)!) tf.set(g, (tf.get(g) ?? 0) + 1);
    const v = new Map<string, number>();
    let norm = 0;
    for (const [g, f] of tf) {
      const w = (1 + Math.log(f)) * Math.log((n + 1) / (df.get(g)! + 0.5));
      v.set(g, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [g, w] of v) v.set(g, w / norm);
    vecs.set(c.id, v);
    for (const g of v.keys()) {
      let p = postings.get(g);
      if (!p) postings.set(g, (p = []));
      p.push(c.id);
    }
  }
  return { vecs, postings };
}

/**
 * For each claim, its closest claims of the same kind on other pages (cosine >= minSim). Terms shared by more
 * than maxShare of all claims are skipped when collecting candidates (they still count in the cosine).
 */
export function neighbors(
  claims: Claim[],
  V: Vectors,
  opts: { minSim?: number; minSimByType?: Partial<Record<ClaimType, number>>; k?: number; maxShare?: number; maxPost?: number; skipSameValue?: boolean; embedSim?: (a: Claim, b: Claim) => number | undefined } = {},
): { a: Claim; b: Claim; sim: number }[] {
  const minSim = opts.minSim ?? 0.55;
  const k = opts.k ?? 8;
  const maxPost = Math.min(opts.maxPost ?? Infinity, Math.max(50, Math.floor(claims.length * (opts.maxShare ?? 0.05))));
  const byId = new Map(claims.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: { a: Claim; b: Claim; sim: number }[] = [];
  for (const a of claims) {
    const va = V.vecs.get(a.id)!;
    const acc = new Map<number, number>();
    for (const [g, w] of va) {
      const p = V.postings.get(g)!;
      if (p.length > maxPost) continue;
      for (const id of p) if (id !== a.id) acc.set(id, (acc.get(id) ?? 0) + w * V.vecs.get(id)!.get(g)!);
    }
    const best = [...acc.entries()]
      .map(([id]) => byId.get(id)!)
      .filter((b) => b.type === a.type && b.doc.url !== a.doc.url && !(opts.skipSameValue && b.value === a.value))
      .map((b) => ({ b, sim: opts.embedSim?.(a, b) ?? cosine(va, V.vecs.get(b.id)!) }))
      .filter((x) => x.sim >= (opts.minSimByType?.[a.type] ?? minSim))
      .sort((x, y) => y.sim - x.sim)
      .slice(0, k);
    for (const { b, sim } of best) {
      const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, sim });
    }
  }
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [g, w] of s) dot += w * (l.get(g) ?? 0);
  return dot;
}

// ------------------------------------------------------------------ judging a pair

export type Verdict =
  | { label: "likely conflict"; why: string; older?: boolean }
  | { label: "same value" | "different subject" | "different period" | "one-off"; why: string };

/** Years since a page date like "10/20/2026", "Rev. 07/2026" or "2004"; undefined if no date. */
export function docYear(date?: string): number | undefined {
  if (!date) return undefined;
  const y = date.match(/\b((?:19|20)\d{2})\b/);
  return y ? Number(y[1]) : undefined;
}

export function judge(a: Claim, b: Claim, now = new Date()): Verdict {
  // 1. the same value, possibly written differently
  if (a.value === b.value || b.others.has(a.value) || a.others.has(b.value)) return { label: "same value", why: `both say ${a.value}` };
  if (a.type === "deadline") {
    const ya = a.value.length > 5 ? a.value.slice(0, 4) : undefined;
    const yb = b.value.length > 5 ? b.value.slice(0, 4) : undefined;
    if (ya && yb && ya !== yb) return { label: "different period", why: `deadlines in different years (${ya} vs ${yb})` };
    if (a.value.slice(-5) === b.value.slice(-5)) return { label: "same value", why: `both mean ${a.value.slice(-5)}` };
    const old = (y?: string) => y !== undefined && Number(y) < now.getFullYear() - 1;
    if (old(ya) || old(yb)) return { label: "different period", why: `a ${[ya, yb].filter(old).join("/")} deadline is past (stale, not a conflict)` };
  }
  // 2. about different things: too few shared subject words, or a different grade, program, fee type, region...
  const words = `${a.subject.slice(0, 6).join(" ")} / ${b.subject.slice(0, 6).join(" ")}`;
  if (a.type === "fee") {
    const o = overlap(a.subject, b.subject);
    if (o.share < 0.6 || o.shared < 2) return { label: "different subject", why: `different fee labels: ${words}` };
  }
  if (a.type === "deadline" && !(a.dims.due && b.dims.due)) {
    const o = overlap(a.subject, b.subject);
    if (o.share < 0.5 || o.shared < 3) return { label: "different subject", why: `few shared words: ${words}` };
  }
  if (a.type === "phone" && !(a.dims.unit ?? []).some((u) => (b.dims.unit ?? []).includes(u))) {
    return { label: "different subject", why: `different offices: ${(a.dims.unit ?? []).join("/")} vs ${(b.dims.unit ?? []).join("/")}` };
  }
  // fees and deadlines belong to a program; when either page does not say which, we cannot tell they match
  if ((a.type === "fee" || a.type === "deadline") && !(a.dims.program && b.dims.program)) {
    return { label: "different subject", why: `program not named on ${a.dims.program ? "page B" : "page A"}` };
  }
  for (const d of Object.keys(a.dims)) {
    const x = a.dims[d];
    const y = b.dims[d];
    if (!y) continue;
    if (!x.some((v) => y.includes(v))) return { label: "different subject", why: `${d}: ${x.join("/")} vs ${y.join("/")}` };
  }
  // 3. about different years
  const pa = a.periods;
  const pb = b.periods;
  if (pa.length && pb.length && !pa.some((p) => pb.includes(p))) return { label: "different period", why: `${pa.join("/")} vs ${pb.join("/")}` };
  const cutoff = now.getFullYear() - 2;
  const past = (ps: string[]) => ps.length > 0 && ps.every((p) => Number(p.slice(0, 4)) < cutoff);
  if ((past(pa) && !pb.length) || (past(pb) && !pa.length)) {
    return { label: "different period", why: `one side is about ${[...pa, ...pb].join("/")}` };
  }
  // 4. what is left: two pages, same subject, different answer
  const ya = docYear(a.doc.date);
  const yb = docYear(b.doc.date);
  const older = ya !== undefined && yb !== undefined && Math.abs(ya - yb) >= 3;
  return { label: "likely conflict", why: `${a.raw} vs ${b.raw}`, older };
}

// ------------------------------------------------------------------ optional second opinion (Gemini)

export const JUDGE_INSTRUCTION = `You check whether two passages from the California Water Boards website contradict each other.
A contradiction means a visitor asking one question would get two different answers: the same fee, deadline, contact or rule for the same program, the same people and the same period, with values that cannot both be true.
It is NOT a contradiction when the passages are about different programs, grades, fee types, regions or years, when one is clearly a past year's value, when one is a general rule and the other a stated exception, or when the values mean the same thing ("before February 1" and "January 31").
Quote the exact words from each passage that carry the two values. Quotes must be copied character for character.`;

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["contradiction", "different subject", "different period", "same meaning", "unclear"] },
    quote_a: { type: "string" },
    quote_b: { type: "string" },
    reason: { type: "string" },
  },
  required: ["verdict", "quote_a", "quote_b", "reason"],
};

/** Quotes must really be in the passages, or the second opinion is thrown out. */
export function quoteFound(quote: string, passage: string): boolean {
  const n = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const q = n(quote);
  return q.length >= 6 && n(passage).includes(q);
}
