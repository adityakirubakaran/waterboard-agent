import { readQuestions } from "@/lib/questionLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download the question log as CSV: /api/questions?token=ADMIN_TOKEN */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return new Response("Not found", { status: 404 });
  }
  const rows = await readQuestions();
  if (!rows) return new Response("No database configured; see the Vercel runtime logs for [question] lines.", { status: 200 });
  const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const csv = ["at,session,turn,status,question", ...rows.map((r) => [r.at, r.session, r.turn, r.status, r.question].map(esc).join(","))].join("\n");
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=questions.csv" },
  });
}
