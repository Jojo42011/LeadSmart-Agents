/**
 * Payment ledger checks, run against a throwaway SQLite file.
 *
 * The ledger is the record of money that actually left the company, so the
 * properties asserted here are the ones that would cost real money to get
 * wrong: an unknown amount must never read as $0, apportioned shares must add
 * back to the payment total exactly, un-ticking a checkbox must not erase a
 * real transfer, and the backfill must be safe to run on every boot.
 *
 * Run: npx ts-node scripts/checkPaymentLedger.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leadsmart-ledger-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "test";

import {
  markAffiliatePaidForMonths,
  markAffiliatePaidForWeeks,
  getSharedDb,
} from "../lib/logger";
import {
  apportionAcrossPeriods,
  buildLedgerReport,
  backfillLedgerFromPaidFlags,
  ensurePaymentLedgerSchema,
  getLedgerSummaryForPeriod,
  getLedgerTotalsForPeriod,
  getPaymentHistoryForPublisher,
  hasPaymentForPeriod,
  recordAffiliatePayment,
  voidManualPaymentsForPeriod,
} from "../lib/paymentLedger";

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.error(
    `  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`
  );
}

ensurePaymentLedgerSchema();

/* 1. A real Wise payment is recorded with its amount and reference. */
console.log("recording a Wise payment:");
recordAffiliatePayment({
  publisherName: "Alpha Affiliate",
  method: "Wise",
  amount: 1234.56,
  targetAmount: 107_900.12,
  targetCurrency: "INR",
  reference: "Wise transfer #900001",
  periodType: "month",
  periods: [{ key: "2026-08", amount: 1234.56, attribution: "measured" }],
});
let aug = getLedgerSummaryForPeriod("month", "2026-08");
check("one affiliate settled for August", aug.length === 1, aug);
check("amount is the amount sent", aug[0]?.paidAmount === 1234.56, aug[0]);
check("not flagged as estimated", aug[0]?.estimated === false);
check("reference is kept", aug[0]?.references.includes("Wise transfer #900001"));
check("hasPaymentForPeriod sees it", hasPaymentForPeriod("Alpha Affiliate", "month", "2026-08"));

/* 2. An unknown amount must stay unknown — never $0 folded into a total. */
console.log("unknown amounts:");
recordAffiliatePayment({
  publisherName: "Beta Affiliate",
  method: "Legacy",
  amount: null,
  periodType: "month",
  periods: [{ key: "2026-08", amount: null, attribution: "unknown" }],
});
aug = getLedgerSummaryForPeriod("month", "2026-08");
const beta = aug.find((row) => row.publisherName === "Beta Affiliate");
check("settled but contributes nothing to the total", beta?.paidAmount === 0);
check("counted as unknown, not as zero", beta?.unknownPayments === 1, beta);
check("no known payments", beta?.knownPayments === 0, beta);
let totals = getLedgerTotalsForPeriod("month", "2026-08");
check("totals count both affiliates as settled", totals.affiliatesSettled === 2, totals);
check("totals report only the known money", totals.paidAmount === 1234.56, totals);
check(
  "totals surface the unrecoverable one",
  totals.affiliatesWithUnknownAmount === 1,
  totals
);

/* 3. Apportioning one payment across months must not invent or lose cents. */
console.log("apportioning across periods:");
const weights = { "2026-06": 300, "2026-07": 600.01 };
const split = apportionAcrossPeriods(900.01, ["2026-06", "2026-07"], weights);
const splitSum = split.reduce((sum, part) => sum + (part.amount ?? 0), 0);
check("shares add back to the total exactly", Math.round(splitSum * 100) === 90001, split);
check("every share is marked apportioned", split.every((p) => p.attribution === "apportioned"));
check(
  "weighting follows the earnings",
  (split.find((p) => p.key === "2026-07")?.amount ?? 0) >
    (split.find((p) => p.key === "2026-06")?.amount ?? 0),
  split
);
const evenSplit = apportionAcrossPeriods(100, ["2026-01", "2026-02", "2026-03"]);
check(
  "an unweighted split still adds up",
  Math.round(evenSplit.reduce((s, p) => s + (p.amount ?? 0), 0) * 100) === 10000,
  evenSplit
);
const unknownSplit = apportionAcrossPeriods(null, ["2026-01", "2026-02"]);
check(
  "an unknown total stays unknown per period",
  unknownSplit.every((p) => p.amount === null && p.attribution === "unknown"),
  unknownSplit
);
const single = apportionAcrossPeriods(500, ["2026-05"], { "2026-05": 500 });
check(
  "a single measured period is measured, not apportioned",
  single[0]?.attribution === "measured" && single[0]?.amount === 500,
  single
);

/* 4. Un-ticking a checkbox must not erase money that actually moved. */
console.log("voiding:");
recordAffiliatePayment({
  publisherName: "Alpha Affiliate",
  method: "Manual",
  amount: 50,
  note: "marked paid by hand",
  periodType: "month",
  periods: [{ key: "2026-08", amount: 50, attribution: "assumed" }],
});
let alphaBefore = getLedgerSummaryForPeriod("month", "2026-08").find(
  (r) => r.publisherName === "Alpha Affiliate"
);
check("manual entry adds to the total", alphaBefore?.paidAmount === 1284.56, alphaBefore);
check("total is now flagged estimated", alphaBefore?.estimated === true);

const voided = voidManualPaymentsForPeriod(
  "Alpha Affiliate",
  "month",
  "2026-08",
  "unticked in the dashboard"
);
check("the manual entry is voided", voided.voided === 1, voided);
check("the real Wise transfer is kept", voided.keptRealPayments === 1, voided);
const alphaAfter = getLedgerSummaryForPeriod("month", "2026-08").find(
  (r) => r.publisherName === "Alpha Affiliate"
);
check("the Wise amount survives the void", alphaAfter?.paidAmount === 1234.56, alphaAfter);
const history = getPaymentHistoryForPublisher("Alpha Affiliate");
check("voided payments stay on the record", history.length === 2, history.length);
check(
  "the voided one is marked, not deleted",
  history.some((p) => p.status === "voided" && p.voidReason === "unticked in the dashboard"),
  history.map((p) => p.status)
);

/* 5. The backfill fills gaps, counts what it skips, and is boot-safe. */
console.log("backfill:");
markAffiliatePaidForMonths("Alpha Affiliate", ["2026-08"]); // already in the ledger
markAffiliatePaidForMonths("Gamma Affiliate", ["2026-07", "2026-08"]);
markAffiliatePaidForWeeks("Gamma Affiliate", ["2026-08-03"]);

const first = backfillLedgerFromPaidFlags();
check("backfills the missing month flags", first.monthsInserted === 2, first);
check("backfills the missing week flag", first.weeksInserted === 1, first);
check("skips the flag already covered by a real payment", first.alreadyPresent === 1, first);

const second = backfillLedgerFromPaidFlags();
check(
  "a second run inserts nothing",
  second.monthsInserted === 0 && second.weeksInserted === 0,
  second
);
check("and reports everything as already present", second.alreadyPresent === 4, second);

const gammaJul = getLedgerSummaryForPeriod("month", "2026-07").find(
  (r) => r.publisherName === "Gamma Affiliate"
);
check("backfilled rows carry no amount", gammaJul?.paidAmount === 0, gammaJul);
check("and are counted as unknown", gammaJul?.unknownPayments === 1, gammaJul);
check(
  "weeks are tracked separately from months",
  getLedgerSummaryForPeriod("week", "2026-08-03").length === 1
);
check(
  "a month key is rejected as a week key",
  getLedgerSummaryForPeriod("week", "2026-08").length === 0
);

/* 6. Nothing here touched the existing flag tables. */
console.log("existing tables untouched:");
const flagCount = (
  getSharedDb()
    .prepare("SELECT COUNT(*) AS n FROM affiliate_paid_months")
    .get() as { n: number }
).n;
check("paid-month flags still readable and intact", flagCount === 3, flagCount);

/* 7. The earned-vs-paid join — the report the team actually reads. */
console.log("earned vs paid report:");
const report = buildLedgerReport(
  [
    // Paid in full, then revenue revised DOWN. Not owed anything.
    { publisherName: "Revised Down", totalAmount: 900 },
    // Paid, then revenue revised UP. The top-up must surface — this is the
    // case a paid flag can never show.
    { publisherName: "Topped Up", totalAmount: 1500 },
    // Never paid.
    { publisherName: "Never Paid", totalAmount: 640.25 },
    // Settled long ago with no recoverable amount. Not dunned for our gap.
    { publisherName: "Legacy Flag", totalAmount: 700 },
    // Revenue but no money either way, filtered out by having none of both.
    { publisherName: "No Revenue", totalAmount: 0 },
  ],
  [
    {
      publisherName: "Revised Down",
      paidAmount: 1000,
      knownPayments: 1,
      unknownPayments: 0,
      estimated: false,
      methods: ["Wise"],
      references: ["Wise transfer #1"],
      lastPaidAt: "2026-09-01T00:00:00.000Z",
    },
    {
      publisherName: "Topped Up",
      paidAmount: 1000,
      knownPayments: 1,
      unknownPayments: 0,
      estimated: false,
      methods: ["Bill.com"],
      references: ["Bill.com payment 7"],
      lastPaidAt: "2026-09-02T00:00:00.000Z",
    },
    {
      publisherName: "Legacy Flag",
      paidAmount: 0,
      knownPayments: 0,
      unknownPayments: 1,
      estimated: false,
      methods: ["Legacy"],
      references: [],
      lastPaidAt: "2026-07-01T00:00:00.000Z",
    },
    {
      // Paid, but gone from this month's revenue — renamed in Ringba, or the
      // revenue was revised away entirely.
      publisherName: "Renamed Away",
      paidAmount: 420,
      knownPayments: 1,
      unknownPayments: 0,
      estimated: false,
      methods: ["Wise"],
      references: ["Wise transfer #2"],
      lastPaidAt: "2026-09-03T00:00:00.000Z",
    },
  ]
);

const row = (name: string) => report.rows.find((r) => r.publisherName === name);
check("a zero-revenue unsettled affiliate is left out", row("No Revenue") === undefined);
check("an overpaid affiliate owes nothing", row("Revised Down")?.owed === 0, row("Revised Down"));
check(
  "the overpayment is reported",
  row("Revised Down")?.overpaid === 100,
  row("Revised Down")
);
check(
  "a top-up on an already-settled affiliate surfaces",
  row("Topped Up")?.owed === 500,
  row("Topped Up")
);
check("an unpaid affiliate owes the full amount", row("Never Paid")?.owed === 640.25);
check(
  "a legacy flag is never dunned for our own missing record",
  row("Legacy Flag")?.owed === 0 && row("Legacy Flag")?.amountUnknown === true,
  row("Legacy Flag")
);
check(
  "an affiliate paid but missing from revenue still appears",
  row("Renamed Away")?.paid === 420 && row("Renamed Away")?.earned === 0,
  row("Renamed Away")
);
check("owed totals add up", report.totalOwed === 1140.25, report.totalOwed);
check("paid totals add up", report.totalPaid === 2420, report.totalPaid);
check("overpaid totals add up", report.totalOverpaid === 520, report.totalOverpaid);
check("affiliates owed counted", report.affiliatesOwed === 2, report.affiliatesOwed);
check("affiliates settled counted", report.affiliatesSettled === 4, report.affiliatesSettled);
check(
  "unknown-amount settlements counted",
  report.affiliatesWithUnknownAmount === 1,
  report.affiliatesWithUnknownAmount
);
check(
  "the biggest debt sorts first",
  report.rows[0]?.publisherName === "Never Paid",
  report.rows.map((r) => r.publisherName)
);

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll payment ledger checks passed.");
