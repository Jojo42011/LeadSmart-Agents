import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getDbPath, getDataDir } from "../../lib/paths";

/**
 * Jarvis's live view into the three departments. Everything here opens the
 * department databases READ-ONLY on its own connections — Jarvis can observe
 * scrub, payments, and fraud but structurally cannot modify them.
 */

function openReadonly(dbPath: string): Database.Database | null {
  try {
    if (!fs.existsSync(dbPath)) return null;
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function currentMonthKey(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}`;
}

// ---------- Scrub agent (System 1) ----------

export function getScrubStatus(): Record<string, unknown> {
  const db = openReadonly(getDbPath());
  if (!db) {
    return { available: false, reason: "scrub database not found" };
  }
  try {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS scrubs,
                COALESCE(SUM(COALESCE(voidPayoutAmount, amountVoided, 0)), 0) AS payoutVoided,
                COALESCE(SUM(COALESCE(voidConversionAmount, 0)), 0) AS revenueVoided
         FROM scrub_log WHERE status = 'success'`,
      )
      .get() as { scrubs: number; payoutVoided: number; revenueVoided: number };

    const last24h = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS voided,
           SUM(CASE WHEN status IN ('error', 'void_success_approve_failed') THEN 1 ELSE 0 END) AS errors
         FROM scrub_log WHERE createdAt >= datetime('now', '-1 day')`,
      )
      .get() as { voided: number | null; errors: number | null };

    const poll = db
      .prepare("SELECT lastSuccessfulPollAt FROM poll_state WHERE id = 1")
      .get() as { lastSuccessfulPollAt: string | null } | undefined;

    const recentErrors = db
      .prepare(
        `SELECT publisherName, status, errorMessage, createdAt FROM scrub_log
         WHERE status NOT IN ('success', 'dry_run') ORDER BY id DESC LIMIT 5`,
      )
      .all();

    return {
      available: true,
      totalSuccessfulScrubs: totals.scrubs,
      totalPayoutVoided: Math.round(totals.payoutVoided * 100) / 100,
      totalRevenueVoided: Math.round(totals.revenueVoided * 100) / 100,
      last24h: { voided: last24h.voided ?? 0, errors: last24h.errors ?? 0 },
      lastSuccessfulPollAt: poll?.lastSuccessfulPollAt ?? null,
      pollIntervalHours: 8,
      recentProblems: recentErrors,
    };
  } finally {
    db.close();
  }
}

// ---------- Payment department ----------

export function getPaymentSummary(): Record<string, unknown> {
  const db = openReadonly(getDbPath());
  if (!db) {
    return { available: false, reason: "payment database not found" };
  }
  try {
    const byMethod = db
      .prepare(
        `SELECT COALESCE(paymentMethod, 'Untagged') AS method, COUNT(*) AS count
         FROM affiliate_metadata GROUP BY COALESCE(paymentMethod, 'Untagged')
         ORDER BY count DESC`,
      )
      .all() as Array<{ method: string; count: number }>;

    const month = currentMonthKey();
    const paidThisMonth = db
      .prepare(
        "SELECT COUNT(*) AS c FROM affiliate_paid_months WHERE month = ?",
      )
      .get(month) as { c: number };

    const lastPaid = db
      .prepare(
        `SELECT publisherName, month, paidAt FROM affiliate_paid_months
         ORDER BY paidAt DESC LIMIT 5`,
      )
      .all();

    let paidThisWeek = 0;
    let lastWeekPaid: unknown[] = [];
    try {
      const weekRow = db
        .prepare(
          "SELECT COUNT(*) AS c FROM affiliate_paid_weeks WHERE paidAt >= datetime('now', '-7 day')",
        )
        .get() as { c: number };
      paidThisWeek = weekRow.c;
      lastWeekPaid = db
        .prepare(
          "SELECT publisherName, week, paidAt FROM affiliate_paid_weeks ORDER BY paidAt DESC LIMIT 5",
        )
        .all();
    } catch {
      // affiliate_paid_weeks may not exist on an older database
    }

    const wiseLinked = db
      .prepare(
        `SELECT COUNT(*) AS c FROM affiliate_metadata
         WHERE paymentMethod = 'Wise' AND wiseRecipientId IS NOT NULL AND TRIM(wiseRecipientId) != ''`,
      )
      .get() as { c: number };

    return {
      available: true,
      currentMonth: month,
      affiliatesByPaymentMethod: byMethod,
      affiliatesPaidThisMonth: paidThisMonth.c,
      weeklyPaymentsLast7Days: paidThisWeek,
      wiseAffiliatesWithLinkedRecipientId: wiseLinked.c,
      recentMonthlyPayments: lastPaid,
      recentWeeklyPayments: lastWeekPaid,
      note: "Counts come from local payment records; live payout dollar amounts require the payment dashboard (pulls Ringba + Polyares).",
    };
  } finally {
    db.close();
  }
}

// ---------- Fraud department (System 3) ----------

export function getFraudStatus(): Record<string, unknown> {
  const db = openReadonly(path.join(getDataDir(), "fraud.db"));
  if (!db) {
    return {
      available: false,
      reason: "fraud database not found (no scans have run yet)",
    };
  }
  try {
    const totals = db
      .prepare(
        `SELECT COUNT(DISTINCT inboundCallId) AS total,
                COUNT(DISTINCT CASE WHEN createdAt >= datetime('now', '-1 day') THEN inboundCallId END) AS last24h
         FROM flagged_calls`,
      )
      .get() as { total: number; last24h: number | null };

    const statuses = db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM publisher_fraud GROUP BY status`,
      )
      .all() as Array<{ status: string; count: number }>;

    const topRisk = db
      .prepare(
        `SELECT publisherName, status, riskScore, flaggedCalls, totalCalls
         FROM publisher_fraud WHERE riskScore > 0
         ORDER BY riskScore DESC LIMIT 5`,
      )
      .all();

    const recentFlags = db
      .prepare(
        `SELECT publisherName, callerNumber, reason, severity, createdAt
         FROM flagged_calls ORDER BY id DESC LIMIT 5`,
      )
      .all();

    const state = db
      .prepare("SELECT lastScanAt FROM fraud_poll_state WHERE id = 1")
      .get() as { lastScanAt: string | null } | undefined;

    return {
      available: true,
      flaggedCallsTotal: totals.total,
      flaggedCallsLast24h: totals.last24h ?? 0,
      publishersByStatus: statuses,
      topRiskPublishers: topRisk,
      recentFlags,
      lastScanAt: state?.lastScanAt ?? null,
    };
  } finally {
    db.close();
  }
}

/** Compact one-paragraph ops snapshot for the daily activation brief. */
export function buildOpsBriefText(): string {
  const parts: string[] = [];
  try {
    const scrub = getScrubStatus();
    if (scrub.available) {
      parts.push(
        `Scrub: ${scrub.totalSuccessfulScrubs} lifetime voids ($${scrub.totalPayoutVoided} payout recovered), last 24h ${(scrub.last24h as { voided: number; errors: number }).voided} voided / ${(scrub.last24h as { voided: number; errors: number }).errors} errors.`,
      );
    }
  } catch { /* omit section */ }
  try {
    const pay = getPaymentSummary();
    if (pay.available) {
      parts.push(
        `Payments: ${pay.affiliatesPaidThisMonth} affiliates paid this month, ${pay.weeklyPaymentsLast7Days} weekly payments in the last 7 days.`,
      );
    }
  } catch { /* omit section */ }
  try {
    const fraud = getFraudStatus();
    if (fraud.available) {
      parts.push(
        `Fraud: ${fraud.flaggedCallsLast24h} calls flagged in 24h (${fraud.flaggedCallsTotal} total).`,
      );
    }
  } catch { /* omit section */ }
  return parts.join(" ");
}
