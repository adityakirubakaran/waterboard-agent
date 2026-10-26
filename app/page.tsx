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

type IconName = "tap" | "drop" | "stream" | "fund" | "board";

const PROGRAMS: { name: string; icon: IconName; blurb: string; links: { label: string; href: string }[]; ask: string }[] = [
  {
    name: "Drinking Water",
    icon: "tap",
    blurb: "Operators, labs and public water systems",
    links: [
      { label: "Operator certification", href: `${SITE}/drinking_water/certlic/occupations/DWopcert.html` },
      { label: "Lab accreditation (ELAP)", href: `${SITE}/drinking_water/certlic/labs/` },
      { label: "Public water system permits", href: `${SITE}/drinking_water/certlic/drinkingwater/Permits.html` },
    ],
    ask: "How much is the grade 2 drinking water operator exam?",
  },
  {
    name: "Water Quality",
    icon: "drop",
    blurb: "Permits that keep pollution out of water",
    links: [
      { label: "Storm water permits", href: `${SITE}/water_issues/programs/stormwater/` },
      { label: "Underground storage tanks", href: `${SITE}/water_issues/programs/ust/` },
      { label: "Cannabis cultivation", href: `${SITE}/water_issues/programs/cannabis/cannabis_water_quality.html` },
    ],
    ask: "We're grading a 2-acre lot to build a house. What do we need for storm water?",
  },
  {
    name: "Water Rights",
    icon: "stream",
    blurb: "Who can take water, and how much",
    links: [
      { label: "Annual water use reports", href: `${SITE}/waterrights/water_issues/programs/water_diversion_reporting/` },
      { label: "Water right fees", href: `${SITE}/resources/fees/water_rights/` },
      { label: "Registrations", href: `${SITE}/waterrights/water_issues/programs/registrations/` },
    ],
    ask: "When do I have to turn in my annual water use report?",
  },
  {
    name: "Funding",
    icon: "fund",
    blurb: "Grants and loans for water projects",
    links: [
      { label: "Clean Water State Revolving Fund", href: `${SITE}/water_issues/programs/grants_loans/srf/` },
      { label: "Grants and loans", href: `${SITE}/water_issues/programs/grants_loans/` },
      { label: "Underground tank cleanup fund", href: `${SITE}/water_issues/programs/ustcf/` },
    ],
    ask: "Is there state money to help a small gas station replace its old fuel tanks?",
  },
  {
    name: "The Board",
    icon: "board",
    blurb: "Meetings, regional boards and contacts",
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
      <path d="M14.5 25.5a6 6 0 0 0 5.5 5.3" stroke="#062033" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity=".5" />
    </svg>
  );
}

function ProgramIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    tap: (
      <>
        <path d="M4 9h7a3 3 0 0 1 3 3v1" />
        <path d="M7 6h2M8 6v3M4 7v4" />
        <path d="M14 13h3.5a2.5 2.5 0 0 1 2.5 2.5V16" />
        <path d="M20 19.5c0 .8-.7 1.5-1.5 1.5S17 20.3 17 19.5c0-.9 1.5-2.5 1.5-2.5s1.5 1.6 1.5 2.5Z" />
      </>
    ),
    drop: (
      <>
        <path d="M12 3c3.3 4.3 6 7.6 6 10.8a6 6 0 0 1-12 0C6 10.6 8.7 7.3 12 3Z" />
        <path d="m9.5 14 1.8 1.8 3.4-3.6" />
      </>
    ),
    stream: (
      <>
        <path d="M3 7c2 0 2-1.5 4.5-1.5S9.5 7 12 7s2.5-1.5 4.5-1.5S19 7 21 7" />
        <path d="M3 12c2 0 2-1.5 4.5-1.5S9.5 12 12 12s2.5-1.5 4.5-1.5S19 12 21 12" />
        <path d="M3 17c2 0 2-1.5 4.5-1.5S9.5 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17" />
      </>
    ),
    fund: (
      <>
        <ellipse cx="10" cy="7" rx="6" ry="2.5" />
        <path d="M4 7v4c0 1.4 2.7 2.5 6 2.5M4 11v4c0 1.4 2.7 2.5 6 2.5" />
        <path d="M16 9v.5M13 14.5c0 1.4 1.3 2.5 3 2.5s3-1 3-2.2c0-2.6-6-1.4-6-4 0-1.2 1.3-2.3 3-2.3s3 1 3 2.3M16 17v1.5" />
      </>
    ),
    board: (
      <>
        <path d="M3 20h18M5 20v-8M9.5 20v-8M14.5 20v-8M19 20v-8" />
        <path d="M2.5 12h19L12 5z" />
      </>
    ),
  };
  return (
    <svg className="program-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/** Long, slow swells across the bottom of the hero. Each line is two screens wide (its wavelength divides 1440) and slides left by one screen, so the loop is seamless. */
function Swell() {
  const wave = (y: number, amp: number, len: number) => {
    let d = `M0 ${y}`;
    for (let x = 0; x < 2880; x += len) {
      d += ` q ${len / 4} ${-amp} ${len / 2} 0 t ${len / 2} 0`;
    }
    return d;
  };
  return (
    <svg className="swell" viewBox="0 0 1440 260" preserveAspectRatio="none" aria-hidden="true">
      <g className="swell-lines" fill="none">
        <path className="w1" d={wave(70, 18, 360)} />
        <path className="w2" d={wave(110, 14, 480)} />
        <path className="w3" d={wave(150, 22, 288)} />
        <path className="w4" d={wave(190, 12, 720)} />
        <path className="w5" d={wave(225, 16, 240)} />
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
      <div className="ocean">
        <div className="mesh" aria-hidden="true">
          <span className="glow glow-teal" />
          <span className="glow glow-cyan" />
          <span className="glow glow-sun" />
          <span className="glow glow-deep" />
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
          <section className="hero" aria-labelledby="hero-title">
            <div className="wrap hero-inner">
              <p className="hero-note">
                <span className="hero-note-dot" aria-hidden="true" />
                {DISCLAIMER}
              </p>
              <h1 id="hero-title">Ask the Water Boards</h1>
              <p className="lede">
                Fees, permits, deadlines and forms, answered from Water Board pages with a link to every source.
              </p>
              <div className="glass">
                <SiteSearch />
                <div className="try">
                  <span className="try-label">Try</span>
                  {TRY.map((q) => (
                    <AskChip key={q} question={q} />
                  ))}
                </div>
              </div>
            </div>
            <Swell />
          </section>
        </main>

        <svg className="shoreline" viewBox="0 0 1440 90" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 52C180 18 330 12 520 34s330 52 520 40 290-46 400-50V90H0Z" />
        </svg>
      </div>

      <section className="programs" aria-labelledby="programs-title">
        <div className="wrap">
          <div className="section-head">
            <h2 id="programs-title">Find a program</h2>
            <p>Links open the real waterboards.ca.gov. Or ask the assistant from any card.</p>
          </div>
          <div className="program-grid">
            {PROGRAMS.map((p) => (
              <article className="program" key={p.name}>
                <div className="program-top">
                  <span className="program-badge">
                    <ProgramIcon name={p.icon} />
                  </span>
                  <h3>{p.name}</h3>
                  <p>{p.blurb}</p>
                </div>
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
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="about" id="about" aria-labelledby="about-title">
        <div className="wrap about-grid">
          <div className="about-intro">
            <h2 id="about-title">How this prototype works</h2>
            <p>
              UC Berkeley students built this assistant for a consulting project, to test how a chat assistant on
              waterboards.ca.gov could work. It is not official Water Board guidance.
            </p>
            {info ? (
              <p className="about-meta">
                It searches its own saved crawl of {info.ok.toLocaleString("en-US")} Water Board pages and files
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

      <footer className="footer">
        <div className="wrap">
          <div className="footer-top">
            <a className="brand" href="#top">
              <DropMark className="brand-mark" />
              <span className="brand-text">
                <span className="brand-name">California Water Boards</span>
                <span className="brand-sub">Student prototype</span>
              </span>
            </a>
            <p className="footer-disclaimer">
              Student prototype built by UC Berkeley students. Not official Water Board guidance, and not affiliated with
              or endorsed by the State Water Resources Control Board.
            </p>
          </div>
          <div className="footer-bottom">
            <p>For official information, visit the Water Boards website.</p>
            <ul className="footer-links">
              <li>
                <a href={SITE}>waterboards.ca.gov</a>
              </li>
              <li>
                <a href="#about">How it works</a>
              </li>
              <li>
                <a href={REPO}>Code on GitHub</a>
              </li>
            </ul>
          </div>
        </div>
      </footer>

      <ChatWidget />
    </>
  );
}
