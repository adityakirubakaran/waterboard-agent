import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveDeadline, extractClaims, isRecord, judge, quoteFound, type Claim } from "../lib/conflicts";

const NOW = new Date("2026-10-27T12:00:00Z");
const page = (url: string, title = "Page", date?: string) => ({ url, title, date });

function claim(text: string, url: string, title = "Page", type?: Claim["type"]): Claim {
  const cs = extractClaims({ id: "x", text }, page(url, title));
  const c = type ? cs.find((x) => x.type === type) : cs[0];
  assert.ok(c, `no ${type ?? ""} claim in: ${text}`);
  return c!;
}

test("deadline wording: 'before February 1' is January 31; 'no later than February 1' is February 1", () => {
  assert.equal(effectiveDeadline("before", "February", "1"), "01-31");
  assert.equal(effectiveDeadline("prior to", "March", "1", "2028"), "2028-02-29");
  assert.equal(effectiveDeadline("no later than", "February", "1", "2027"), "2027-02-01");
});

test("the water use report deadline pages are flagged, and same-meaning wording is not", () => {
  const rights = "https://www.waterboards.ca.gov/waterrights/";
  const a = claim(
    "All water right holders are required to electronically submit an Annual Report of Water Diversion and Use. Reports for the previous water year are due the following year no later than February 1 for all water right types.",
    `${rights}a`, "Water Rights", "deadline",
  );
  const b = claim("Annual reports must be filed each year through CalWATRS, and are due by January 31 of each year.", `${rights}b`, "Water Rights", "deadline");
  const c = claim("You can avoid late fees by submitting your water right annual report on time, before February 1 of each year.", `${rights}c`, "Water Rights", "deadline");
  assert.equal(judge(a, b, NOW).label, "likely conflict");
  assert.equal(judge(b, c, NOW).label, "same value"); // January 31 = before February 1
});

test("different grades, fee types or programs are not conflicts", () => {
  const ww = "https://www.waterboards.ca.gov/water_issues/programs/operator_certification/";
  const g1 = claim("Examination fee for Grade I wastewater operator $296", `${ww}a`, "Fee Schedule", "fee");
  const g2 = claim("Examination fee for Grade II wastewater operator $382", `${ww}b`, "Fee Schedule", "fee");
  assert.equal(judge(g1, g2, NOW).label, "different subject");
  const rights = "https://www.waterboards.ca.gov/waterrights/";
  const reg = claim("Small Domestic or Livestock Stockpond Registration fee §1068(a) $250", `${rights}a`, "Water Right Fee Schedule", "fee");
  const ann = claim("Small Domestic or Livestock Stockpond Annual Fee §1068(b) $100", `${rights}b`, "Water Right Fee Schedule", "fee");
  assert.equal(judge(reg, ann, NOW).label, "different subject");
});

test("a value stated for a past year is not a conflict with this year's value", () => {
  const rights = "https://www.waterboards.ca.gov/waterrights/";
  const now = claim("Livestock Stockpond Use Registration fee is $250", `${rights}a`, "Water Rights Fees", "fee");
  const then = claim("The Livestock Stockpond Use Registration fee for fiscal year 2018-2019 is $50", `${rights}b`, "Water Rights Fees", "fee");
  assert.equal(judge(now, then, NOW).label, "different period");
});

test("card rules: a FAQ answer is read from the next sentence, and programs must match", () => {
  const ww = "https://www.waterboards.ca.gov/water_issues/programs/operator_certification/docs/";
  const no = claim("Can I use my Debit Card, Credit Card, or Paypal?\nNo. The Wastewater Operator Certification Program cannot accept such payments.", `${ww}faq.pdf`, "WWOCP FAQ", "card");
  assert.equal(no.value, "no");
  const yes = claim("WWOCP can accept electronic payments as ACH debit payments or from credit cards to pay for application fees.", `${ww}oit.pdf`, "Operator-in-Training", "card");
  assert.equal(yes.value, "yes");
  assert.equal(judge(no, yes, NOW).label, "likely conflict");
  const dw = claim("Credit Cards or Debit Cards ARE NOT accepted for payments.", "https://www.waterboards.ca.gov/drinking_water/certlic/occupations/guide.pdf", "Payment Guide", "card");
  assert.equal(judge(dw, yes, NOW).label, "different subject");
});

test("dated records are skipped; old guidance that is still online is kept", () => {
  assert.ok(isRecord(page("https://www.waterboards.ca.gov/board_info/agendas/2026/oct/10062026-agenda.pdf", "Agenda"), NOW));
  assert.ok(isRecord(page("https://www.waterboards.ca.gov/waterrights/docs/fy1617_finalfee.pdf", "Fees"), NOW));
  assert.ok(!isRecord(page("https://www.waterboards.ca.gov/water_issues/programs/operator_certification/docs/online_payments_user_guide.pdf", "Online Payments User Guide (Updated as of 06/06/2016)"), NOW));
  assert.ok(!isRecord(page("https://www.waterboards.ca.gov/resources/fees/stakeholder/docs/fee-schedule-summary.pdf", "SWRCB Water Rights Fiscal Year 2025-2026 Fee Schedule Summary"), NOW));
});

test("second-opinion quotes must be found in the passage", () => {
  assert.ok(quoteFound("due the following year no later than February 1", "Reports ... are due the following year no later than February 1 for all"));
  assert.ok(!quoteFound("due no later than January 31", "Reports are due the following year no later than February 1"));
});
