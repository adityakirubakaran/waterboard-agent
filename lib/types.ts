/** One page or file the agent is allowed to answer from (a Tier 1 row in the content inventory). */
export interface Source {
  id: string; // S001...
  url: string;
  title: string;
  format: "html" | "pdf";
  section: string;
  menuPath: string;
  inventoryTab: string;
  inventoryLastUpdated: string;
  /** Filled in by the corpus builder. */
  fetchedAt?: string;
  pageLastUpdated?: string; // "Page last updated" date printed on the page, when present
  status?: "ok" | "error";
  error?: string;
  chars?: number;
  pages?: number;
  chunks?: number;
  finalUrl?: string; // where the URL redirected to, when different
  tier?: string; // inventory tier ("1", "2", "3"), or "linked" for pages found through links
  discoveredFrom?: string; // for linked pages: the inventory page that links to it
}

/** A passage of a source, the unit the retriever ranks. */
export interface Chunk {
  id: string; // S001-0003
  sourceId: string;
  url: string;
  title: string;
  section: string;
  format: "html" | "pdf";
  page?: number; // first PDF page the passage comes from
  heading?: string; // nearest heading above the passage (HTML)
  text: string;
  date?: string; // date printed on the page or file (full-site index only; the snapshot keeps it per source)
}

export interface CorpusMeta {
  builtAt: string;
  sourceCount: number;
  okCount: number;
  chunkCount: number;
  description?: string; // what the data store holds, e.g. "Tier 1 of the content inventory"
  sources: Source[];
}

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type AnswerStatus = "answered" | "not_found" | "clarify" | "out_of_scope";

export interface CitedSource {
  title: string;
  url: string; // includes #page=N for PDF passages
  page?: number;
  sourceId: string;
}

export interface AgentAnswer {
  status: AnswerStatus;
  answer: string;
  sources: CitedSource[];
  /** Debug info for the eval runner (not shown in the chat). */
  debug?: {
    model?: string;
    searchQuery?: string;
    retrieved: { chunkId: string; sourceId: string; title: string; score: number }[];
    rawCitations?: string[];
    guardrail?: string;
  };
}
