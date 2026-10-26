import AskChip from "@/components/AskChip";
import ChatWidget from "@/components/ChatWidget";
import SiteSearch from "@/components/SiteSearch";
import { DISCLAIMER } from "@/lib/constants";
import { corpusInfo } from "@/lib/corpusInfo";

export const dynamic = "force-static";

const SITE = "https://www.waterboards.ca.gov";
const REPO = "https://github.com/adityakirubakaran/waterboard-agent";

const NAV = [
  { label: "Board", href: `${SITE}/board_info/` },
  { label: "Drinking Water", href: `${SITE}/drinking_water/programs/` },
  { label: "Water Quality", href: `${SITE}/water_issues/programs/` },
  { label: "Water Rights", href: `${SITE}/waterrights/` },
  { label: "Funding", href: `${SITE}/water_issues/programs/grants_loans/` },
];

const PROGRAMS = [
  {
    name: "Drinking Water",
    links: [
      { label: "Operator certification", href: `${SITE}/drinking_water/certlic/occupations/DWopcert.html` },
      { label: "Lab accreditation (ELAP)", href: `${SITE}/drinking_water/certlic/labs/` },
      { label: "Public water system permits", href: `${SITE}/drinking_water/certlic/drinkingwater/Permits.html` },
    ],
    ask: "How much is the grade 2 drinking water operator exam?",
  },
  {
    name: "Water Quality",
    links: [
      { label: "Storm water permits", href: `${SITE}/water_issues/programs/stormwater/` },
      { label: "Underground storage tanks", href: `${SITE}/water_issues/programs/ust/` },
      { label: "Cannabis cultivation", href: `${SITE}/water_issues/programs/cannabis/cannabis_water_quality.html` },
    ],
    ask: "We're grading a 2-acre lot to build a house. What do we need for storm water?",
  },
  {
    name: "Water Rights",
    links: [
      { label: "Annual water use reports", href: `${SITE}/waterrights/water_issues/programs/water_diversion_reporting/` },
      { label: "Water right fees", href: `${SITE}/resources/fees/water_rights/` },
      { label: "Registrations", href: `${SITE}/waterrights/water_issues/programs/registrations/` },
    ],
    ask: "When do I have to turn in my annual water use report?",
  },
  {
    name: "Funding",
    links: [
      { label: "Clean Water State Revolving Fund", href: `${SITE}/water_issues/programs/grants_loans/srf/` },
      { label: "Grants and loans", href: `${SITE}/water_issues/programs/grants_loans/` },
      { label: "Underground tank cleanup fund", href: `${SITE}/water_issues/programs/ustcf/` },
    ],
    ask: "Is there state money to help a small gas station replace its old fuel tanks?",
  },
  {
    name: "The Board",
    links: [
      { label: "Meetings and agendas", href: `${SITE}/board_info/calendar/` },
      { label: "Find your regional board", href: `${SITE}/waterboards_map.html` },
      { label: "Contact us", href: `${SITE}/about_us/contact_us/` },
    ],
    ask: "How long do I have to appeal a regional water board decision?",
  },
];

const TRY = [
  "How much is the grade 2 drinking water operator exam?",
  "When is my annual water use report due?",
  "Where's the regional board office in Fresno?",
];

function DropMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 4c6.5 8.7 11 14.6 11 20.2A11 11 0 0 1 9 24.2C9 18.6 13.5 12.7 20 4Z" fill="currentColor" />
      <path d="M14.5 25.5a6 6 0 0 0 5.5 5.3" stroke="#0e2a47" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity=".55" />
    </svg>
  );
}

/** A river and its tributaries, drawn in on page load. Purely decorative. */
function RiverArt() {
  return (
    <svg className="river-art" viewBox="0 0 640 440" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <g className="contours" fill="none">
        <path d="M330 20c60-22 160-18 220 30s70 120 20 160" />
        <path d="M360 52c48-16 126-12 170 26s52 92 14 124" />
        <path d="M392 86c34-10 86-6 116 20s34 62 8 84" />
        <path d="M120 300c40-30 120-34 170-6" />
        <path d="M90 330c50-38 160-44 220-8" />
      </g>
      <g className="streams" fill="none" strokeLinecap="round">
        <path className="s1" d="M660 30C580 64 548 112 498 146S392 206 368 258 300 334 214 362 84 402-20 414" />
        <path className="s2" d="M650 214c-58-8-100-24-128-46s-12-14-24-22" />
        <path className="s3" d="M600 340c-70-16-150-30-196-54s-26-20-36-28" />
        <path className="s4" d="M300 70C322 118 300 168 330 208S360 246 368 258" />
        <path className="s5" d="M660 96C612 104 566 112 534 124S508 138 498 146" />
        <path className="s6" d="M200 192C246 214 296 232 336 246S360 255 368 258" />
      </g>
    </svg>
  );
}

function formatDate(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
}

export default function Home() {
  const info = corpusInfo();
  return (
    <>
      <div className="notice" role="note">
        <div className="wrap notice-row">
          <p>
            <strong>{DISCLAIMER}</strong> <span className="notice-extra">This is a mockup, not the real Water Boards website.</span>
          </p>
          <a href="#about">How it works</a>
        </div>
      </div>

      <header className="masthead">
        <div className="wrap masthead-row">
          <a className="brand" href="#top">
            <DropMark className="brand-mark" />
            <span className="brand-text">
              <span className="brand-name">California Water Boards</span>
              <span className="brand-sub">Student prototype</span>
            </span>
          </a>
          <nav className="nav-wrap" aria-label="Water Boards website sections">
            <ul className="nav">
              {NAV.map((n) => (
                <li key={n.label}>
                  <a href={n.href} target="_blank" rel="noopener noreferrer">
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <RiverArt />
          <div className="wrap hero-inner">
            <h1>Ask the Water&nbsp;Boards</h1>
            <p className="lede">
              Fees, permits, operator certification, water rights and funding. Every answer comes from Water Board pages and
              links to its source.
            </p>
            <SiteSearch />
            <div className="try">
              <span className="try-label">Try</span>
              {TRY.map((q) => (
                <AskChip key={q} question={q} />
              ))}
            </div>
          </div>
        </section>

        <section className="programs wrap" aria-labelledby="programs-title">
          <div className="section-head">
            <h2 id="programs-title">Find a program</h2>
            <p>Links open the real waterboards.ca.gov.</p>
          </div>
          <div className="program-grid">
            {PROGRAMS.map((p) => (
              <div className="program" key={p.name}>
                <h3>{p.name}</h3>
                <ul>
                  {p.links.map((l) => (
                    <li key={l.label}>
                      <a href={l.href} target="_blank" rel="noopener noreferrer">
                        {l.label}
                      </a>
                    </li>
                  ))}
                </ul>
                <AskChip question={p.ask} variant="inline" />
              </div>
            ))}
          </div>
        </section>

        <section className="about" id="about" aria-labelledby="about-title">
          <div className="wrap about-grid">
            <div className="about-intro">
              <h2 id="about-title">How this prototype works</h2>
              <p>
                {DISCLAIMER} It was built for a student consulting project to test how a chat assistant on
                waterboards.ca.gov could work.
              </p>
              {info ? (
                <p className="about-meta">
                  It searches a saved copy of {info.ok.toLocaleString("en-US")} Water Board pages and files
                  {info.description ? ` (${info.description})` : ""}
                  {info.builtAt ? `, last updated ${formatDate(info.builtAt)}` : ""}.
                </p>
              ) : (
                <p className="about-meta">The assistant&apos;s pages haven&apos;t been downloaded yet, so it can&apos;t answer.</p>
              )}
            </div>
            <ul className="principles">
              <li>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 3h8l4 4v14H6z" />
                  <path d="M14 3v4h4M9 12h6M9 16h6" />
                </svg>
                <div>
                  <h3>Only Water Board pages</h3>
                  <p>It has no web search. It answers from the saved pages and files, nothing else.</p>
                </div>
              </li>
              <li>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" />
                  <path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" />
                </svg>
                <div>
                  <h3>A source with every answer</h3>
                  <p>Each answer links the page it came from, and PDFs open at the right page.</p>
                </div>
              </li>
              <li>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5 20c1.2-3.6 3.8-5.5 7-5.5s5.8 1.9 7 5.5" />
                </svg>
                <div>
                  <h3>Staff when it doesn&apos;t know</h3>
                  <p>If the answer isn&apos;t in its pages, it says so and points you to the right office. No legal advice.</p>
                </div>
              </li>
              <li>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 5h16v11H9l-5 4z" />
                  <path d="M8 9h8M8 12h5" />
                </svg>
                <div>
                  <h3>Questions are saved</h3>
                  <p>We keep the questions people type, without names or emails, to see what visitors need.</p>
                </div>
              </li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer-row">
          <p>Student prototype. Not affiliated with or endorsed by the State Water Resources Control Board.</p>
          <p>
            Official information: <a href={SITE}>waterboards.ca.gov</a>
            <span aria-hidden="true">&ensp;/&ensp;</span>
            <a href={REPO}>Code on GitHub</a>
          </p>
        </div>
      </footer>

      <ChatWidget />
    </>
  );
}
