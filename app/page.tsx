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
  { label: "Financial Assistance", href: `${SITE}/water_issues/programs/grants_loans/` },
  { label: "Regional Boards", href: `${SITE}/waterboards_map.html` },
];

const TOPICS = [
  {
    title: "Drinking Water Operator Certification",
    href: `${SITE}/drinking_water/certlic/occupations/DWopcert.html`,
    text: "Exams, certificates, renewals and fees for treatment and distribution operators.",
  },
  {
    title: "Wastewater Operator Certification",
    href: `${SITE}/water_issues/programs/operator_certification/`,
    text: "Becoming a certified wastewater treatment plant operator.",
  },
  {
    title: "Storm Water",
    href: `${SITE}/water_issues/programs/stormwater/`,
    text: "Construction and industrial storm water permits and the SMARTS reporting system.",
  },
  {
    title: "Water Rights Fees",
    href: `${SITE}/resources/fees/water_rights/`,
    text: "Annual fees, fee schedules and payment questions.",
  },
  {
    title: "Water Use Reporting",
    href: `${SITE}/waterrights/water_issues/programs/water_diversion_reporting/`,
    text: "Annual reports of water diversion and use, filed in CalWATRS.",
  },
  {
    title: "Grants and Loans",
    href: `${SITE}/water_issues/programs/grants_loans/`,
    text: "State Revolving Funds and other funding for water projects.",
  },
  {
    title: "Find Your Regional Board",
    href: `${SITE}/waterboards_map.html`,
    text: "Nine regional boards cover California. Find the one for your area.",
  },
  {
    title: "Board Meetings",
    href: `${SITE}/board_info/calendar/`,
    text: "Meeting calendar, agendas and how to take part.",
  },
];

const EXAMPLES = [
  "How much does it cost to take the grade 2 drinking water operator exam?",
  "When do I have to turn in my annual water use report?",
  "We're grading a 2-acre lot to build a house. What do we need for storm water?",
  "What will the annual water right fee be for 2027-28?",
];

function DropMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="21" fill="#046b99" />
      <path d="M22 9c5 7 9 11.6 9 16.2A9 9 0 0 1 13 25.2C13 20.6 17 16 22 9Z" fill="#fff" />
      <path d="M17.5 26.5a4.6 4.6 0 0 0 4.5 4" stroke="#046b99" strokeWidth="2" fill="none" strokeLinecap="round" />
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
      <div className="proto-banner" role="note">
        <div className="wrap">
          <span>
            <strong>{DISCLAIMER}</strong> This is a mockup for testing, not the real Water Boards website.
          </span>
          <a href="#about">About this prototype</a>
        </div>
      </div>

      <header className="site-header">
        <div className="wrap">
          <a className="brand" href="#">
            <DropMark />
            <span>
              <span className="brand-name">
                California Water Boards <span className="proto-pill">Prototype</span>
              </span>
              <br />
              <span className="brand-sub">State Water Resources Control Board (student mockup)</span>
            </span>
          </a>
          <SiteSearch />
        </div>
      </header>

      <nav className="main-nav" aria-label="Main">
        <div className="wrap">
          <ul>
            {NAV.map((n) => (
              <li key={n.label}>
                <a href={n.href} target="_blank" rel="noopener noreferrer">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <main>
        <section className="hero">
          <div className="wrap">
            <h1>How can we help you today?</h1>
            <p>
              Ask the Water Boards Assistant (bottom right) about fees, permits, operator certification, water rights or
              funding. It answers only from a fixed set of Water Board pages and files, and links the page each answer
              comes from.
            </p>
            <div className="chips">
              {EXAMPLES.map((q) => (
                <AskChip key={q} question={q} />
              ))}
            </div>
          </div>
        </section>

        <div className="wrap">
          <h2 className="section-title">Popular topics</h2>
          <div className="cards">
            {TOPICS.map((t) => (
              <article className="card" key={t.title}>
                <h3>
                  <a href={t.href} target="_blank" rel="noopener noreferrer">
                    {t.title}
                  </a>
                </h3>
                <p>{t.text}</p>
              </article>
            ))}
          </div>

          <section className="about" id="about">
            <h2>About this prototype</h2>
            <p>
              {DISCLAIMER} It was built for a UC Berkeley student consulting project to test how a chat assistant on
              waterboards.ca.gov could work. Topic links above open the real Water Boards website.
            </p>
            <ul>
              <li>
                The assistant can only use the {info ? info.ok : "Tier 1"} pages and files the team marked Tier 1 in the
                content inventory
                {info?.builtAt ? `, as downloaded on ${formatDate(info.builtAt)}` : ""}. It has no web search or internet
                access, so it cannot look anything up elsewhere.
              </li>
              <li>Every answer links its source. If the answer is not in those pages, it says so and points you to staff.</li>
              <li>It does not give legal advice and cannot see anyone&apos;s permits, applications or payments.</li>
              <li>
                We save the questions people type (not names or emails, which are removed if typed) so the team can see
                what visitors ask. Please don&apos;t include personal details.
              </li>
            </ul>
            {!info && <p><strong>The data store has not been built yet, so the assistant is not ready.</strong></p>}
          </section>
        </div>
      </main>

      <footer className="site-footer">
        <div className="wrap">
          Student prototype. Not affiliated with or endorsed by the State Water Resources Control Board. For official
          information visit <a href={SITE}>waterboards.ca.gov</a>. Code: <a href={REPO}>GitHub</a>.
        </div>
      </footer>

      <ChatWidget />
    </>
  );
}
