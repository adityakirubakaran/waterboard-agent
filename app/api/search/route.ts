import { NextResponse } from "next/server";
import { passageKey, searchAll } from "@/lib/agent";
import { corpusAvailable, loadCorpus, type Hit } from "@/lib/retrieval";
import { vectorConfigured, vectorIndex } from "@/lib/vectorStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Search check, for the team: /api/search?q=your+question shows which passages the assistant would read
 * for a question, from which store, and whether the full-site index is reachable. It does not call the chat
 * model and does not log the question. Add &rewrite=1 to include the query-rewrite step (one small Gemini call).
 * Everything it returns is public Water Board text.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim().slice(0, 300);
  const configured = vectorConfigured();

  let index: Record<string, unknown> | undefined;
  let indexError: string | undefined;
  if (configured) {
    try {
      const info = await vectorIndex().info();
      index = { passagesStored: info.vectorCount, stillIndexing: info.pendingVectorCount, dimension: info.dimension };
    } catch (e) {
      indexError = String((e as Error)?.message ?? e).slice(0, 300);
    }
  }
  const status = {
    fullSiteIndex: configured ? (indexError ? { reachable: false, error: indexError } : { reachable: true, ...index }) : "not configured",
    snapshot: corpusAvailable() ? "available" : "missing",
  };
  if (!q) return NextResponse.json({ ...status, usage: "add ?q=your+question to see what the assistant would read" });

  const corpus = corpusAvailable() ? loadCorpus() : undefined;
  const r = await searchAll([{ role: "user", content: q }], { corpus, rewrite: params.get("rewrite") === "1" ? undefined : false });
  const inFull = new Set((r.fullSite ?? []).map(passageKey));
  const inSnap = new Set((r.snapshot ?? []).map(passageKey));
  const show = (h: Hit) => ({
    title: h.chunk.title,
    url: h.chunk.url,
    ...(h.chunk.page ? { page: h.chunk.page } : {}),
    ...(h.chunk.date ? { date: h.chunk.date } : {}),
    text: h.chunk.text.replace(/\s+/g, " ").slice(0, 160),
  });
  return NextResponse.json(
    {
      ...status,
      question: q,
      queries: r.queries,
      fullSiteError: r.fullSiteError,
      excerptsForTheModel: r.hits.map((h, i) => ({
        n: i + 1,
        from: inFull.has(passageKey(h)) ? (inSnap.has(passageKey(h)) ? "both" : "full-site index") : "snapshot",
        ...show(h),
      })),
      fullSiteTop: (r.fullSite ?? []).slice(0, 10).map(show),
      snapshotTop: (r.snapshot ?? []).slice(0, 10).map(show),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
