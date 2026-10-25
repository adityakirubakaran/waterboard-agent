# Water Boards Assistant (student prototype)

A mockup of the California Water Boards website with a chat box in the bottom-right corner. The assistant answers
questions using **only** the pages and files our team marked Tier 1 in the content inventory, links the source for
every answer, and says so (and points to staff) when the answer isn't there.

**Prototype built by UC Berkeley students. Not official Water Board guidance.**

## How it stays inside the data store

The model never browses. Four things keep it to our material:

1. **The data store is a fixed snapshot of Tier 1 rows only.** `npm run sources` reads the inventory export in
   `data/inventory/` and keeps only rows whose *Suggested tier* is `1` (184 unique pages and files). Tier 2 and 3 rows,
   including the outdated files we flagged (the 2017 wastewater fee notice, the 2018 registration fee notice), never
   enter it. `npm run corpus` downloads exactly those URLs, with no link following and no crawling, and saves the text to
   `data/corpus/`. A test (`tests/misc.test.ts`) fails if a non-Tier 1 URL ever appears in `data/sources.csv`.
2. **Gemini gets no tools.** We call it without Google Search grounding, URL context or code execution, so it can't
   look anything up. It only sees the passages we pass in with each question.
3. **The prompt only allows answers from those passages.** The model must return JSON with a status (`answered`,
   `not_found`, `clarify`, `out_of_scope`), the answer, and the ids of the passages it used.
4. **Code checks every reply before it's shown.** An "answered" reply that doesn't cite a passage it was given is
   replaced with a hand-off to staff, and any web address that isn't one of our sources is removed.

Gemini still has its training knowledge, so the guardrails make outside facts much less likely, not impossible. The
eval's *Grounded* criterion checks for exactly this.

## How a question is answered

```
visitor question
  -> query rewrite (small Gemini model turns "appeal" into "petition for review", Fresno into Central Valley Region 5, ...)
  -> search the snapshot (keyword BM25 + optional embeddings) -> top 8 passages, at most 3 per page
  -> Gemini (no tools) with the rules in lib/prompt.ts -> JSON {status, answer, citations}
  -> guardrails in lib/agent.ts -> answer + source links shown in the chat
  -> question logged (no names or emails)
```

| Rubric item | Where it's handled |
|---|---|
| Cited | Every `answered` reply must cite a passage; the chat shows the page link (PDFs open at the cited page). |
| Knows its limits / hands off | `not_found` status, then the program contact from the passages, or Contact Us and the regional board map. |
| Clarifies | `clarify` status: one question (county, type of business, drinking water vs. wastewater...). |
| Stays in scope | `out_of_scope` status for legal advice, predictions about someone's own case, and off-topic requests. |
| Plain language | Prompt rules: short sentences, explain acronyms, under ~120 words. |
| Current | Each passage carries the date printed on its page or file; the prompt prefers the newest dated version and gives today's date. |
| Visible disclaimer | Banner at the top of the page and a fixed line in the chat box. |
| Question log | `lib/questionLog.ts`; the notice is shown in the chat box and on the page. |

## Put it online (about 10 minutes)

1. Push this folder to GitHub (`git push -u origin main`).
2. **Build the data store.** The "Build data store" action (Actions tab) starts on its own after the first push. It
   downloads the Tier 1 pages, commits `data/corpus/` and takes a few minutes. You can also run it locally (below).
3. **Deploy on Vercel.** Go to vercel.com -> Add New -> Project -> import `waterboard-agent`. Keep the defaults.
4. In the Vercel project, open **Settings -> Environment Variables** and add `GEMINI_API_KEY` (Rahnon has the key).
   Optional: `ADMIN_TOKEN` (any password) for downloading the question log.
5. **Question log:** in Vercel, **Storage -> Create Database -> Upstash for Redis** and connect it to the project. It
   adds the database variables for you. Without it, questions still show up in Vercel's runtime logs as `[question]`
   lines.
6. Redeploy. Share the `*.vercel.app` link.

If the data store isn't committed yet when Vercel builds, the build downloads it itself (`npm run build` runs the
corpus step when `data/corpus/` is missing). If the site can't be reached, the page still deploys and the chat says
the data store isn't ready.

## Run it on your laptop

Needs Node 22.

```bash
npm install
cp .env.example .env.local          # then paste the Gemini key into .env.local
npm run corpus                      # download the Tier 1 pages and files into data/corpus/ (a few minutes)
npm run embed                       # optional: add embeddings for better matching
npm run dev                         # http://localhost:3000
npm run ask -- "How much is the grade 2 drinking water operator exam?"   # one question in the terminal
```

## Run the eval (Guidesheet step 5)

The two suites from our test sheet are in `eval/suites/` (30 Answer Accuracy, 30 Conversation tests).

```bash
npm run eval                         # Answer Accuracy, 3 runs per question (rubric rule)
npm run eval -- --runs 1             # 1 run each (use this on a free-tier key)
npm run eval -- --suite conversation
npm run eval -- --ids P1,P3,W4
npm run eval -- --out eval/results/<folder> --resume   # continue after hitting a rate limit
```

Or from GitHub: Actions -> **Run eval** -> Run workflow (add `GEMINI_API_KEY` as a repository secret first). Results
are committed to `eval/results/<run>/`:

- `summary.md`: pass count, every Critical failure, and a **Not in data store** table that shows whether the agent
  said it didn't know.
- `grading_sheet_answer_accuracy.csv` (and `_conversation.csv`): one row per run with the agent's reply, links, fact checks and draft grades per criterion,
  plus blank *Final grade* and *Critical failure?* columns for us to fill in.
- `results.jsonl`: everything, including the passages the agent cited.

A test is marked **Not in data store** when none of its answer source URLs are in the Tier 1 list and none of its
key facts (dollar amounts, emails, phone numbers, dates) appear anywhere in the snapshot. For those, the right
behavior is "I couldn't find that" plus a staff contact.

The draft grades come from a second Gemini call that sees the answer key and applies our rubric (Correct, Current
and Grounded are Critical; Cited and Knows its limits are Major; Direct is Minor; a question passes only if every
run passes). Treat them as a first pass and confirm each one by hand before reporting.

## Question log

Each entry keeps only the question text, the time, a random id per browser tab, the turn number and the answer
status. Emails, phone numbers and "my name is ..." are masked before saving. No IP addresses, names or answers are
stored. Download everything as CSV at `/api/questions?token=<ADMIN_TOKEN>`.

## Known data store issues

- **Snapshot of 10/25/2026:** 179 of 184 sources downloaded. Not usable: `fee_increase.pdf` and
  `dwocp_payment_form.pdf` (both now return "not found" on the live site), and three pages with no text
  (`gama/wq_privatewells.html`, `water_recycling_policy/`, `diversion_use/water_use.html`).
- **Wastewater exam fee.** The only Tier 1 wastewater fee file was `fee_increase.pdf`, which the site has taken down,
  and the current schedule (`ww-fee-schedule.pdf`, $382) isn't in the inventory. So the data store has no wastewater
  exam fee at all: for P1, P2 and P5 the right behavior is now "I couldn't find that" plus the program contact.
  Adding `ww-fee-schedule.pdf` as a Tier 1 row and re-running `npm run sources && npm run corpus` would let it answer.
- 20 Tier 1 rows are flagged "Outdated" in the inventory's Issues column. They stay in, since the guidesheet says to
  use Tier 1 exactly; the prompt's *Current* rule and the dates on each passage are what protect against them.
- One Tier 1 row (water measurement regulation) has a blank URL in the export; `scripts/make-sources.ts` fills in
  the page it describes and prints a note.

## Files

```
app/page.tsx                 mock Water Boards page (banner, header, topics, about section)
components/ChatWidget.tsx    bottom-right chat box
app/api/chat/route.ts        chat endpoint
app/api/questions/route.ts   question log CSV export (needs ADMIN_TOKEN)
lib/agent.ts                 retrieval -> Gemini -> guardrails
lib/prompt.ts                the model's rules
lib/retrieval.ts             keyword + vector search over the snapshot
lib/questionLog.ts           question logging and scrubbing
scripts/make-sources.ts      inventory -> data/sources.csv (Tier 1 only)
scripts/build-corpus.ts      data/sources.csv -> data/corpus/ snapshot
scripts/embed-corpus.ts      optional embeddings
scripts/run-eval.ts          eval runner and grader
eval/suites/                 our test suites
data/corpus/text/            readable text of every source, for checking what the agent can see
```
