import type Database from "better-sqlite3";
import { getSharedDb } from "./logger";

/**
 * The payment ledger: a record of money that actually left LeadSmart.
 *
 * The pre-existing affiliate_paid_months / affiliate_paid_weeks tables are
 * *flags* — they answer "was this affiliate settled for this period?" and
 * nothing more. They carry no amount, so every "paid $X" figure had to be
 * recomputed from live Ringba/Polyares revenue, which keeps moving after the
 * money is sent (CPL finalization, scrub voids, Polyares restatements).
 *
 * This ledger is the other half: one row per payment, recording what was
 * actually sent, by what method, against which reference. The flags stay the
 * source of truth for paid *status* — nothing about existing behaviour
 * changes — and the ledger becomes the source of truth for paid *amounts*.
 *
 * Two rules run through the whole module:
 *
 *  1. An unknown amount is NULL, never 0. A zero silently deflates every
 *     total it touches; a NULL is visible and countable. Callers get both
 *     the summed amount and the count of payments whose amount is unknown.
 *  2. Voiding is a status change, never a delete. A payment that really
 *     happened stays on the record.
 */

export type PaymentLedgerMethod = "Wise" | "Bill.com" | "Manual" | "Legacy";
export type PaymentPeriodType = "month" | "week";

/**
 * Where a period's share of a payment came from:
 *  - measured    — read from the payout data for that exact period
 *  - apportioned — one payment split across several periods pro-rata
 *  - assumed     — manually marked paid; the amount is that period's earnings,
 *                  not a confirmed transfer amount
 *  - unknown     — no amount is recoverable (backfilled historical flags)
 */
export type PeriodAttribution =
  | "measured"
  | "apportioned"
  | "assumed"
  | "unknown";

export type PaymentLedgerStatus = "paid" | "voided";

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const WEEK_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LedgerPeriodInput {
  key: string;
  /** This period's share of the payment in USD. null when unknown. */
  amount: number | null;
  attribution: PeriodAttribution;
}

export interface RecordPaymentInput {
  publisherName: string;
  /** Ringba publisher ID when known — survives renames, unlike the name. */
  publisherId?: string | null;
  method: PaymentLedgerMethod;
  /** Total USD actually sent. null when genuinely unknown. */
  amount: number | null;
  /** Converted amount in the recipient's currency, for non-USD Wise payouts. */
  targetAmount?: number | null;
  targetCurrency?: string | null;
  /** Provider handle: Wise transfer ID, Bill.com payment ID, … */
  reference?: string | null;
  note?: string | null;
  /** ISO timestamp the money moved. Defaults to now. */
  paidAt?: string;
  periodType: PaymentPeriodType;
  periods: LedgerPeriodInput[];
}

export interface LedgerPayment {
  id: number;
  publisherName: string;
  publisherId: string | null;
  method: PaymentLedgerMethod;
  amount: number | null;
  targetAmount: number | null;
  targetCurrency: string | null;
  reference: string | null;
  note: string | null;
  status: PaymentLedgerStatus;
  paidAt: string;
  recordedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  periods: Array<{
    periodType: PaymentPeriodType;
    periodKey: string;
    amount: number | null;
    attribution: PeriodAttribution;
  }>;
}

/** One affiliate's settled total for a single period. */
export interface LedgerPeriodSummaryRow {
  publisherName: string;
  /** Sum of known period amounts. Excludes unknown-amount payments. */
  paidAmount: number;
  /** Payments counted in paidAmount. */
  knownPayments: number;
  /** Payments recorded for this period whose amount is not recoverable. */
  unknownPayments: number;
  /** True when any counted amount is assumed/apportioned rather than measured. */
  estimated: boolean;
  methods: PaymentLedgerMethod[];
  references: string[];
  lastPaidAt: string | null;
}

let schemaReady = false;

function ensureSchema(database: Database.Database): void {
  if (schemaReady) {
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS affiliate_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publisherName TEXT NOT NULL,
      publisherId TEXT,
      method TEXT NOT NULL,
      amount REAL,
      targetAmount REAL,
      targetCurrency TEXT,
      reference TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'paid',
      paidAt TEXT NOT NULL,
      recordedAt TEXT NOT NULL,
      voidedAt TEXT,
      voidReason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_affiliate_payments_publisher
      ON affiliate_payments (publisherName);
    CREATE INDEX IF NOT EXISTS idx_affiliate_payments_status
      ON affiliate_payments (status);

    CREATE TABLE IF NOT EXISTS affiliate_payment_periods (
      paymentId INTEGER NOT NULL,
      periodType TEXT NOT NULL,
      periodKey TEXT NOT NULL,
      amount REAL,
      attribution TEXT NOT NULL,
      PRIMARY KEY (paymentId, periodType, periodKey)
    );

    CREATE INDEX IF NOT EXISTS idx_affiliate_payment_periods_period
      ON affiliate_payment_periods (periodType, periodKey);
  `);

  schemaReady = true;
}

function db(): Database.Database {
  const database = getSharedDb();
  ensureSchema(database);
  return database;
}

/** Tables are created lazily; call this at boot so the first read is cheap. */
export function ensurePaymentLedgerSchema(): void {
  db();
}

export function isValidPeriodKey(
  periodType: PaymentPeriodType,
  key: string
): boolean {
  return periodType === "week"
    ? WEEK_KEY_RE.test(key)
    : MONTH_KEY_RE.test(key);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeAmount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return roundMoney(value);
}

/**
 * Split one payment total across several periods.
 *
 * Uses the measured per-period earnings as weights when they are available,
 * so a $900 payment covering two months lands where the money was earned.
 * Falls back to an even split, and marks every share "apportioned" so no
 * report ever mistakes a derived number for a measured one.
 */
export function apportionAcrossPeriods(
  total: number | null,
  periodKeys: string[],
  weights?: Record<string, number> | null
): LedgerPeriodInput[] {
  if (periodKeys.length === 0) {
    return [];
  }

  if (periodKeys.length === 1) {
    const key = periodKeys[0];
    const measured = weights?.[key];
    return [
      {
        key,
        amount: normalizeAmount(total),
        // A single-period payment needs no splitting: the amount IS the
        // period's amount. It is measured when the payout data produced it.
        attribution:
          total === null
            ? "unknown"
            : typeof measured === "number" && roundMoney(measured) === normalizeAmount(total)
              ? "measured"
              : "apportioned",
      },
    ];
  }

  if (total === null) {
    return periodKeys.map((key) => ({
      key,
      amount: null,
      attribution: "unknown" as const,
    }));
  }

  const weightFor = (key: string): number => {
    const weight = weights?.[key];
    return typeof weight === "number" && Number.isFinite(weight) && weight > 0
      ? weight
      : 0;
  };
  const weightSum = periodKeys.reduce((sum, key) => sum + weightFor(key), 0);

  // Give every period its share, then put the rounding remainder on the
  // largest share so the parts always add back up to the total exactly.
  const shares = periodKeys.map((key) => {
    const share =
      weightSum > 0
        ? (total * weightFor(key)) / weightSum
        : total / periodKeys.length;
    return { key, amount: roundMoney(share) };
  });

  const drift = roundMoney(total - shares.reduce((s, r) => s + r.amount, 0));
  if (drift !== 0) {
    let largest = 0;
    for (let i = 1; i < shares.length; i += 1) {
      if (shares[i].amount > shares[largest].amount) {
        largest = i;
      }
    }
    shares[largest].amount = roundMoney(shares[largest].amount + drift);
  }

  return shares.map((share) => ({
    key: share.key,
    amount: share.amount,
    attribution: "apportioned" as const,
  }));
}

/**
 * Write one payment and its period breakdown. Returns the payment ID.
 * Payment and periods go in together or not at all.
 */
export function recordAffiliatePayment(input: RecordPaymentInput): number {
  const database = db();
  const publisherName = input.publisherName.trim();
  if (!publisherName) {
    throw new Error("recordAffiliatePayment requires a publisher name");
  }

  const periods = input.periods.filter((period) =>
    isValidPeriodKey(input.periodType, period.key)
  );
  if (periods.length === 0) {
    throw new Error(
      `recordAffiliatePayment requires at least one valid ${input.periodType} key`
    );
  }

  const now = new Date().toISOString();
  const paidAt = input.paidAt?.trim() || now;

  const insertPayment = database.prepare(
    `INSERT INTO affiliate_payments
       (publisherName, publisherId, method, amount, targetAmount, targetCurrency,
        reference, note, status, paidAt, recordedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`
  );
  const insertPeriod = database.prepare(
    `INSERT OR REPLACE INTO affiliate_payment_periods
       (paymentId, periodType, periodKey, amount, attribution)
     VALUES (?, ?, ?, ?, ?)`
  );

  const write = database.transaction((): number => {
    const result = insertPayment.run(
      publisherName,
      input.publisherId?.trim() || null,
      input.method,
      normalizeAmount(input.amount),
      normalizeAmount(input.targetAmount),
      input.targetCurrency?.trim().toUpperCase() || null,
      input.reference?.trim() || null,
      input.note?.trim() || null,
      paidAt,
      now
    );
    const paymentId = Number(result.lastInsertRowid);
    for (const period of periods) {
      insertPeriod.run(
        paymentId,
        input.periodType,
        period.key,
        normalizeAmount(period.amount),
        period.attribution
      );
    }
    return paymentId;
  });

  return write();
}

/**
 * Void the bookkeeping entries for one period — used when somebody un-ticks a
 * manually marked-paid affiliate.
 *
 * Only Manual and Legacy entries are voidable. A Wise or Bill.com row records
 * money that actually moved, and un-ticking a checkbox does not un-send a
 * transfer, so those are left alone and reported back to the caller.
 */
export function voidManualPaymentsForPeriod(
  publisherName: string,
  periodType: PaymentPeriodType,
  periodKey: string,
  reason: string
): { voided: number; keptRealPayments: number } {
  const database = db();
  if (!isValidPeriodKey(periodType, periodKey)) {
    return { voided: 0, keptRealPayments: 0 };
  }

  const rows = database
    .prepare(
      `SELECT p.id AS id, p.method AS method
         FROM affiliate_payments p
         JOIN affiliate_payment_periods pp ON pp.paymentId = p.id
        WHERE p.publisherName = ?
          AND p.status = 'paid'
          AND pp.periodType = ?
          AND pp.periodKey = ?`
    )
    .all(publisherName, periodType, periodKey) as Array<{
    id: number;
    method: string;
  }>;

  const voidable = rows.filter(
    (row) => row.method === "Manual" || row.method === "Legacy"
  );
  const keptRealPayments = rows.length - voidable.length;
  if (voidable.length === 0) {
    return { voided: 0, keptRealPayments };
  }

  const now = new Date().toISOString();
  const update = database.prepare(
    `UPDATE affiliate_payments
        SET status = 'voided', voidedAt = ?, voidReason = ?
      WHERE id = ? AND status = 'paid'`
  );
  const run = database.transaction(() => {
    for (const row of voidable) {
      update.run(now, reason, row.id);
    }
  });
  run();

  return { voided: voidable.length, keptRealPayments };
}

/** True when any live payment already covers this publisher/period. */
export function hasPaymentForPeriod(
  publisherName: string,
  periodType: PaymentPeriodType,
  periodKey: string
): boolean {
  const database = db();
  const row = database
    .prepare(
      `SELECT 1
         FROM affiliate_payments p
         JOIN affiliate_payment_periods pp ON pp.paymentId = p.id
        WHERE p.publisherName = ?
          AND p.status = 'paid'
          AND pp.periodType = ?
          AND pp.periodKey = ?
        LIMIT 1`
    )
    .get(publisherName, periodType, periodKey);
  return row !== undefined;
}

interface SummaryQueryRow {
  publisherName: string;
  paidAmount: number | null;
  knownPayments: number;
  unknownPayments: number;
  estimatedCount: number;
  methods: string | null;
  references: string | null;
  lastPaidAt: string | null;
}

/** Every affiliate settled for one period, with what was actually sent. */
export function getLedgerSummaryForPeriod(
  periodType: PaymentPeriodType,
  periodKey: string
): LedgerPeriodSummaryRow[] {
  const database = db();
  if (!isValidPeriodKey(periodType, periodKey)) {
    return [];
  }

  const rows = database
    .prepare(
      `SELECT p.publisherName                                    AS publisherName,
              SUM(CASE WHEN pp.amount IS NOT NULL THEN pp.amount ELSE 0 END) AS paidAmount,
              SUM(CASE WHEN pp.amount IS NOT NULL THEN 1 ELSE 0 END)         AS knownPayments,
              SUM(CASE WHEN pp.amount IS NULL THEN 1 ELSE 0 END)             AS unknownPayments,
              SUM(CASE WHEN pp.attribution IN ('assumed','apportioned') THEN 1 ELSE 0 END) AS estimatedCount,
              GROUP_CONCAT(DISTINCT p.method)                    AS methods,
              GROUP_CONCAT(p.reference)                          AS "references",
              MAX(p.paidAt)                                      AS lastPaidAt
         FROM affiliate_payments p
         JOIN affiliate_payment_periods pp ON pp.paymentId = p.id
        WHERE p.status = 'paid'
          AND pp.periodType = ?
          AND pp.periodKey = ?
        GROUP BY p.publisherName`
    )
    .all(periodType, periodKey) as SummaryQueryRow[];

  return rows.map((row) => ({
    publisherName: row.publisherName,
    paidAmount: roundMoney(row.paidAmount ?? 0),
    knownPayments: row.knownPayments ?? 0,
    unknownPayments: row.unknownPayments ?? 0,
    estimated: (row.estimatedCount ?? 0) > 0,
    methods: splitList(row.methods) as PaymentLedgerMethod[],
    references: splitList(row.references),
    lastPaidAt: row.lastPaidAt,
  }));
}

function splitList(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

/** Full payment history for one affiliate, newest first. */
export function getPaymentHistoryForPublisher(
  publisherName: string,
  limit = 200
): LedgerPayment[] {
  const database = db();
  const payments = database
    .prepare(
      `SELECT * FROM affiliate_payments
        WHERE publisherName = ?
        ORDER BY paidAt DESC, id DESC
        LIMIT ?`
    )
    .all(publisherName, Math.max(1, Math.min(1000, limit))) as Array<
    Record<string, unknown>
  >;

  if (payments.length === 0) {
    return [];
  }

  const ids = payments.map((row) => Number(row.id));
  const periodRows = database
    .prepare(
      `SELECT paymentId, periodType, periodKey, amount, attribution
         FROM affiliate_payment_periods
        WHERE paymentId IN (${ids.map(() => "?").join(",")})
        ORDER BY periodKey ASC`
    )
    .all(...ids) as Array<{
    paymentId: number;
    periodType: PaymentPeriodType;
    periodKey: string;
    amount: number | null;
    attribution: PeriodAttribution;
  }>;

  const byPayment = new Map<number, LedgerPayment["periods"]>();
  for (const row of periodRows) {
    const list = byPayment.get(row.paymentId) ?? [];
    list.push({
      periodType: row.periodType,
      periodKey: row.periodKey,
      amount: row.amount,
      attribution: row.attribution,
    });
    byPayment.set(row.paymentId, list);
  }

  return payments.map((row) => ({
    id: Number(row.id),
    publisherName: String(row.publisherName),
    publisherId: (row.publisherId as string | null) ?? null,
    method: row.method as PaymentLedgerMethod,
    amount: (row.amount as number | null) ?? null,
    targetAmount: (row.targetAmount as number | null) ?? null,
    targetCurrency: (row.targetCurrency as string | null) ?? null,
    reference: (row.reference as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    status: row.status as PaymentLedgerStatus,
    paidAt: String(row.paidAt),
    recordedAt: String(row.recordedAt),
    voidedAt: (row.voidedAt as string | null) ?? null,
    voidReason: (row.voidReason as string | null) ?? null,
    periods: byPayment.get(Number(row.id)) ?? [],
  }));
}

export interface LedgerBackfillResult {
  monthsInserted: number;
  weeksInserted: number;
  alreadyPresent: number;
}

/**
 * Give every pre-existing paid flag a ledger entry.
 *
 * These are historical assertions with no recoverable amount, so they land as
 * Legacy payments with a NULL amount: they count toward "settled", and they
 * are counted separately from money we can actually report on. Runs at boot
 * and only ever fills gaps, so it is safe to call repeatedly.
 */
export function backfillLedgerFromPaidFlags(): LedgerBackfillResult {
  const database = db();

  const monthFlags = database
    .prepare(
      `SELECT publisherName, month AS periodKey, paidAt
         FROM affiliate_paid_months`
    )
    .all() as Array<{ publisherName: string; periodKey: string; paidAt: string }>;
  const weekFlags = database
    .prepare(
      `SELECT publisherName, week AS periodKey, paidAt
         FROM affiliate_paid_weeks`
    )
    .all() as Array<{ publisherName: string; periodKey: string; paidAt: string }>;

  const covered = new Set(
    (
      database
        .prepare(
          `SELECT DISTINCT p.publisherName AS publisherName,
                  pp.periodType           AS periodType,
                  pp.periodKey            AS periodKey
             FROM affiliate_payments p
             JOIN affiliate_payment_periods pp ON pp.paymentId = p.id
            WHERE p.status = 'paid'`
        )
        .all() as Array<{
        publisherName: string;
        periodType: string;
        periodKey: string;
      }>
    ).map((row) => `${row.periodType}|${row.periodKey}|${row.publisherName}`)
  );

  let monthsInserted = 0;
  let weeksInserted = 0;
  let alreadyPresent = 0;

  const insert = (
    periodType: PaymentPeriodType,
    flags: Array<{ publisherName: string; periodKey: string; paidAt: string }>
  ): number => {
    let inserted = 0;
    for (const flag of flags) {
      const token = `${periodType}|${flag.periodKey}|${flag.publisherName}`;
      if (covered.has(token)) {
        alreadyPresent += 1;
        continue;
      }
      if (!isValidPeriodKey(periodType, flag.periodKey)) {
        continue;
      }
      recordAffiliatePayment({
        publisherName: flag.publisherName,
        method: "Legacy",
        amount: null,
        note: "Backfilled from the paid flag — amount not recorded at the time",
        paidAt: flag.paidAt,
        periodType,
        periods: [{ key: flag.periodKey, amount: null, attribution: "unknown" }],
      });
      covered.add(token);
      inserted += 1;
    }
    return inserted;
  };

  const run = database.transaction(() => {
    monthsInserted = insert("month", monthFlags);
    weeksInserted = insert("week", weekFlags);
  });
  run();

  return { monthsInserted, weeksInserted, alreadyPresent };
}

/** One affiliate's earned-vs-paid position for a period. */
export interface LedgerReportRow {
  publisherName: string;
  /** Revenue Ringba + Polyares currently report for the period. */
  earned: number;
  /** Money the ledger can account for. */
  paid: number;
  /** earned - paid, floored at 0. Positive means still owed. */
  owed: number;
  /** paid - earned, floored at 0. Usually a downward revision after payment. */
  overpaid: number;
  settled: boolean;
  /** Settled, but with no recoverable amount — a backfilled legacy flag. */
  amountUnknown: boolean;
  /** The counted amount is assumed or apportioned rather than measured. */
  estimated: boolean;
  methods: string[];
  references: string[];
  lastPaidAt: string | null;
  cplAffiliate: boolean;
}

export interface LedgerReport {
  totalEarned: number;
  totalPaid: number;
  totalOwed: number;
  totalOverpaid: number;
  affiliatesSettled: number;
  affiliatesOwed: number;
  affiliatesWithUnknownAmount: number;
  affiliatesEstimated: number;
  rows: LedgerReportRow[];
}

export interface EarnedRow {
  publisherName: string;
  totalAmount: number;
  cplAffiliate?: boolean;
}

/**
 * Join live revenue against the ledger.
 *
 * "earned" keeps moving as Ringba finalizes and the scrub agent voids;
 * "paid" does not, because it is a record rather than a recomputation. The
 * gap between them answers "who still needs to be paid" — including top-ups
 * owed to affiliates already marked settled, which a paid flag can never show.
 *
 * An affiliate settled with an unrecoverable amount (a backfilled legacy
 * flag) is never reported as owing: the gap is our missing record, not their
 * missing money.
 */
export function buildLedgerReport(
  earnedRows: EarnedRow[],
  ledgerRows: LedgerPeriodSummaryRow[]
): LedgerReport {
  const ledgerByName = new Map(ledgerRows.map((row) => [row.publisherName, row]));
  const rows: LedgerReportRow[] = [];
  const seen = new Set<string>();

  for (const earnedRow of earnedRows) {
    const ledger = ledgerByName.get(earnedRow.publisherName);
    const earned = roundMoney(earnedRow.totalAmount || 0);
    if (earned <= 0 && !ledger) {
      continue;
    }
    seen.add(earnedRow.publisherName);

    const paid = roundMoney(ledger?.paidAmount ?? 0);
    const amountUnknown = Boolean(ledger && ledger.knownPayments === 0);
    rows.push({
      publisherName: earnedRow.publisherName,
      earned,
      paid,
      owed: amountUnknown ? 0 : Math.max(0, roundMoney(earned - paid)),
      overpaid: Math.max(0, roundMoney(paid - earned)),
      settled: Boolean(ledger),
      amountUnknown,
      estimated: Boolean(ledger?.estimated),
      methods: ledger?.methods ?? [],
      references: ledger?.references ?? [],
      lastPaidAt: ledger?.lastPaidAt ?? null,
      cplAffiliate: earnedRow.cplAffiliate === true,
    });
  }

  // Affiliates we paid who no longer appear in the period's revenue — a
  // rename, or revenue revised away after payment. They belong in the report
  // precisely because they are invisible everywhere else.
  for (const ledger of ledgerRows) {
    if (seen.has(ledger.publisherName)) {
      continue;
    }
    rows.push({
      publisherName: ledger.publisherName,
      earned: 0,
      paid: ledger.paidAmount,
      owed: 0,
      overpaid: ledger.paidAmount,
      settled: true,
      amountUnknown: ledger.knownPayments === 0,
      estimated: ledger.estimated,
      methods: ledger.methods,
      references: ledger.references,
      lastPaidAt: ledger.lastPaidAt,
      cplAffiliate: false,
    });
  }

  rows.sort((a, b) => b.owed - a.owed || b.earned - a.earned);

  const sum = (pick: (row: LedgerReportRow) => number): number =>
    roundMoney(rows.reduce((total, row) => total + pick(row), 0));

  return {
    totalEarned: sum((row) => row.earned),
    totalPaid: sum((row) => row.paid),
    totalOwed: sum((row) => row.owed),
    totalOverpaid: sum((row) => row.overpaid),
    affiliatesSettled: rows.filter((row) => row.settled).length,
    affiliatesOwed: rows.filter((row) => row.owed > 0).length,
    affiliatesWithUnknownAmount: rows.filter((row) => row.amountUnknown).length,
    affiliatesEstimated: rows.filter((row) => row.estimated).length,
    rows,
  };
}

export interface LedgerTotals {
  periodType: PaymentPeriodType;
  periodKey: string;
  affiliatesSettled: number;
  paidAmount: number;
  /** Settled affiliates whose amount is not recoverable (legacy backfill). */
  affiliatesWithUnknownAmount: number;
  /** Settled affiliates whose counted amount is assumed or apportioned. */
  affiliatesEstimated: number;
}

export function getLedgerTotalsForPeriod(
  periodType: PaymentPeriodType,
  periodKey: string
): LedgerTotals {
  const rows = getLedgerSummaryForPeriod(periodType, periodKey);
  return {
    periodType,
    periodKey,
    affiliatesSettled: rows.length,
    paidAmount: roundMoney(rows.reduce((sum, row) => sum + row.paidAmount, 0)),
    affiliatesWithUnknownAmount: rows.filter(
      (row) => row.knownPayments === 0 && row.unknownPayments > 0
    ).length,
    affiliatesEstimated: rows.filter((row) => row.estimated).length,
  };
}
