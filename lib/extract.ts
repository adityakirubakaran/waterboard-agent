/**
 * Turning fetched pages and PDFs into passages. Used only by scripts/build-corpus.ts and the tests,
 * never by the running app (the app reads the finished snapshot in data/corpus/).
 */
import * as cheerio from "cheerio";
import { cleanText } from "./text";

export interface Block {
  text: string;
  /** Heading level (1-4) when this block is a heading. */
  level?: number;
  /** First row of the table this row belongs to, repeated at the top of a passage that starts mid-table. */
  tableHeader?: string;
}

export interface Passage {
  heading?: string;
  text: string;
  page?: number;
}

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "nav", "form", "button", "select", "input", "img", "picture", "video", "audio", "map"]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "aside", "li", "ul", "ol", "dl", "dt", "dd", "blockquote", "pre",
  "table", "thead", "tbody", "tfoot", "tr", "caption", "figure", "figcaption", "address", "hr", "details", "summary", "center",
]);
const HEADING: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 4, h6: 4 };
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const DATE = `(?:${MONTH}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}/\\d{1,2}/\\d{2,4}|\\d{4}-\\d{2}-\\d{2})`;

/** The "Page last updated" date that Water Boards pages print near the bottom. */
export function findPageLastUpdated(text: string): string | undefined {
  const m = text.replace(/\s+/g, " ").match(new RegExp(`(?:page\\s+)?last\\s+(?:updated|modified|revised)\\s*(?:on)?\\s*:?\\s*(${DATE})`, "i"));
  return m?.[1];
}

/** First full date printed on a PDF's first page (for example the date on a fee notice). */
export function findFirstDate(text: string): string | undefined {
  const m = text.replace(/\s+/g, " ").match(new RegExp(`(${MONTH}\\s+\\d{1,2},?\\s+\\d{4})`, "i"));
  return m?.[1];
}

/** HTML to ordered text blocks. Global menus, scripts and forms are dropped; tables keep their header row. */
export function htmlToBlocks(html: string): { title?: string; blocks: Block[]; pageLastUpdated?: string } {
  const $ = cheerio.load(html);
  const pageLastUpdated = findPageLastUpdated($("body").text() || $.root().text());
  const title = cleanText($("h1").first().text()) || cleanText($("title").first().text()) || undefined;
  $("body > header, header.global-header, #header, .global-header, .utility-header, #skip-to-content, .skip-to-content").remove();
  $("footer, .global-footer, .site-footer, #footer, .breadcrumb, .breadcrumbs, #breadcrumb, .sr-only, [aria-hidden=true]").remove();

  const blocks: Block[] = [];
  let buf = "";
  let tableHeader: string | undefined;
  let inTable = 0;
  let rowIndex = 0;
  const flush = (extra: Partial<Block> = {}) => {
    const t = cleanText(buf.replace(/\s*\|\s*$/, ""));
    buf = "";
    if (t) blocks.push({ text: t, ...extra });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any) => {
    if (node.type === "text") {
      buf += node.data.replace(/\s+/g, " ");
      return;
    }
    if (node.type !== "tag" && node.type !== "root") return;
    const name: string = node.name ?? "";
    if (SKIP.has(name)) return;
    if (name === "br") {
      buf += "\n";
      return;
    }
    if (HEADING[name]) {
      flush();
      const t = cleanText($(node).text());
      if (t) blocks.push({ text: t, level: HEADING[name] });
      return;
    }
    if (name === "table") {
      flush();
      inTable++;
      const saved = tableHeader;
      const savedRow = rowIndex;
      tableHeader = undefined;
      rowIndex = 0;
      for (const c of node.children ?? []) walk(c);
      flush();
      tableHeader = saved;
      rowIndex = savedRow;
      inTable--;
      return;
    }
    if (name === "tr" && inTable) {
      flush();
      for (const c of node.children ?? []) walk(c);
      const t = cleanText(buf.replace(/\s*\|\s*$/, ""));
      buf = "";
      if (t) {
        if (rowIndex === 0) {
          tableHeader = t;
          blocks.push({ text: t });
        } else {
          blocks.push({ text: t, tableHeader });
        }
        rowIndex++;
      }
      return;
    }
    if (name === "td" || name === "th") {
      for (const c of node.children ?? []) walk(c);
      buf += " | ";
      return;
    }
    if (name === "li") {
      flush();
      buf += "- ";
      for (const c of node.children ?? []) walk(c);
      flush();
      return;
    }
    if (BLOCK.has(name)) {
      flush();
      for (const c of node.children ?? []) walk(c);
      flush();
      return;
    }
    for (const c of node.children ?? []) walk(c);
  };
  const body = $("body")[0] ?? $.root()[0];
  walk(body);
  flush();
  return { title, blocks: blocks.filter((b) => b.text !== "-"), pageLastUpdated };
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?\n]+[.!?]*(\s+|$)|\n/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Group blocks into passages of up to ~maxChars. A heading starts a new passage (once the current one
 * has some substance), every passage remembers the heading it sits under, and a passage that starts
 * mid-table repeats the table's header row.
 */
export function chunkBlocks(blocks: Block[], maxChars = 1200, minChars = 120): Passage[] {
  const out: Passage[] = [];
  const stack: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let curHeading: string | undefined;
  let lastTableHeader: string | undefined;
  const headingPath = () => stack.filter(Boolean).slice(-2).join(" > ") || undefined;
  const flush = (carry?: string) => {
    const text = cur.join("\n").trim();
    if (text) out.push({ heading: curHeading, text });
    cur = carry ? [carry] : [];
    curLen = carry ? carry.length : 0;
    lastTableHeader = undefined;
  };
  for (const b of blocks) {
    if (b.level) {
      if (curLen >= minChars) flush();
      const lvl = Math.max(1, b.level);
      stack.length = lvl - 1;
      stack[lvl - 1] = b.text;
      if (curLen === 0) {
        curHeading = headingPath();
      } else {
        cur.push(b.text);
        curLen += b.text.length + 1;
      }
      continue;
    }
    for (const piece of splitLong(b.text, maxChars)) {
      if (curLen + piece.length + 1 > maxChars && curLen > 0) {
        const last = cur[cur.length - 1];
        flush(last && last.length < 200 && !b.tableHeader ? last : undefined);
        curHeading = headingPath();
      }
      if (b.tableHeader && lastTableHeader !== b.tableHeader && !cur.includes(b.tableHeader)) {
        cur.push(b.tableHeader);
        curLen += b.tableHeader.length + 1;
        lastTableHeader = b.tableHeader;
      }
      if (curLen === 0) curHeading = headingPath();
      cur.push(piece);
      curLen += piece.length + 1;
    }
  }
  flush();
  return out;
}

/** PDF pages to passages. Passages never cross a page, so a citation can point at the exact page. */
export function chunkPdfPages(pages: string[], maxChars = 1200): Passage[] {
  const out: Passage[] = [];
  pages.forEach((raw, i) => {
    const text = cleanText(raw);
    if (!text) return;
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const blocks: Block[] = [];
    // join wrapped lines back into paragraphs: a line that does not end a sentence continues on the next
    let para = "";
    for (const l of lines) {
      para = para ? `${para}${/[-]$/.test(para) ? "" : " "}${l}` : l;
      if (/[.:;!?)]$/.test(l) || l.length < 50) {
        blocks.push({ text: para });
        para = "";
      }
    }
    if (para) blocks.push({ text: para });
    for (const p of chunkBlocks(blocks, maxChars)) out.push({ text: p.text, page: i + 1 });
  });
  return out;
}

/** Drop text blocks that repeat across many pages (site menus, footers, sign-up boxes). */
export function boilerplateSet(pages: Block[][], minPages = 10, share = 0.25): Set<string> {
  const counts = new Map<string, number>();
  for (const blocks of pages) {
    for (const t of new Set(blocks.filter((b) => !b.level).map((b) => b.text))) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const need = Math.max(minPages, Math.ceil(pages.length * share));
  return new Set([...counts].filter(([, n]) => n >= need).map(([t]) => t));
}
