import * as XLSX from "xlsx";
import { last10, type CplCall } from "./ringbaCplClient";
import type { CplRowInput } from "./cplDb";

/**
 * Parse a 33 Miles RTT / Inquirly CPL xlsx and match its rows to Ringba calls.
 * Columns: Service Type, Duration, Date, Time (EST), Caller ID, Cost Per Lead.
 * The "EST" time column is parsed as America/New_York, so July files correctly
 * resolve as EDT (UTC-4), not literal EST.
 */

const MATCH_TOLERANCE_MS = 5 * 60 * 1000; // ±5 minutes

export interface ParsedFileRow {
  serviceType: string;
  duration: string;
  callerId: string;
  callerLast10: string;
  costPerLead: number | null;
  etLabel: string; // human "07/06/2025 3:45 PM ET"
  utcMs: number; // matching key
  ymd: string; // YYYY-MM-DD (ET calendar day)
}

// ---------- Eastern wall-clock → UTC ----------

function nyOffsetMs(atUtcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atUtcMs));
  const read = (t: string) =>
    parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  let hour = read("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );
  return asUtc - atUtcMs;
}

function etWallClockToUtcMs(
  y: number,
  m: number,
  d: number,
  H: number,
  M: number,
): number {
  let utc = Date.UTC(y, m - 1, d, H, M, 0, 0);
  for (let i = 0; i < 3; i++) {
    const off = nyOffsetMs(utc);
    utc = Date.UTC(y, m - 1, d, H, M, 0, 0) - off;
  }
  return utc;
}

// ---------- cell parsing (Date objects, Excel serials, or strings) ----------

interface Ymd { y: number; m: number; d: number; }
interface Hm { H: number; M: number; }

function parseDateCell(v: unknown): Ymd | null {
  if (v instanceof Date) {
    return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
  }
  if (typeof v === "number") {
    const dc = XLSX.SSF.parse_date_code(v);
    if (dc && dc.y) return { y: dc.y, m: dc.m, d: dc.d };
    return null;
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  let mth = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (mth) {
    let year = parseInt(mth[3], 10);
    if (year < 100) year += 2000;
    return { y: year, m: parseInt(mth[1], 10), d: parseInt(mth[2], 10) };
  }
  mth = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); // ISO-ish
  if (mth) {
    return { y: parseInt(mth[1], 10), m: parseInt(mth[2], 10), d: parseInt(mth[3], 10) };
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return { y: parsed.getFullYear(), m: parsed.getMonth() + 1, d: parsed.getDate() };
  }
  return null;
}

function parseTimeCell(v: unknown): Hm | null {
  if (v instanceof Date) {
    return { H: v.getUTCHours(), M: v.getUTCMinutes() };
  }
  if (typeof v === "number") {
    const dc = XLSX.SSF.parse_date_code(v);
    if (dc) return { H: dc.H, M: dc.M };
    return null;
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap][Mm])?/);
  if (!m) return null;
  let H = parseInt(m[1], 10);
  const M = parseInt(m[2], 10);
  const ap = (m[4] || "").toLowerCase();
  if (ap === "pm" && H < 12) H += 12;
  if (ap === "am" && H === 12) H = 0;
  return { H, M };
}

function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/[$,\s]/g, "").trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

// ---------- header resolution ----------

function findKey(keys: string[], ...needles: string[]): string | null {
  for (const key of keys) {
    const norm = key.trim().toLowerCase();
    if (needles.some((n) => norm.includes(n))) return key;
  }
  return null;
}

export interface ParseResult {
  rows: ParsedFileRow[];
  skipped: number;
  weekStartIso: string;
  weekEndIso: string;
}

export function parseCplWorkbook(buffer: Buffer): ParseResult {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Workbook has no sheets");

  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: true,
    defval: null,
  });
  if (json.length === 0) throw new Error("No rows found in the file");

  const keys = Object.keys(json[0]);
  const kCaller = findKey(keys, "caller");
  const kCpl = findKey(keys, "cost per lead", "cpl", "cost");
  const kDate = findKey(keys, "date");
  const kTime = findKey(keys, "time");
  const kService = findKey(keys, "service");
  const kDuration = findKey(keys, "duration");

  if (!kCaller) throw new Error('Missing a "Caller ID" column');
  if (!kDate || !kTime) throw new Error('Missing "Date" and/or "Time" columns');

  const rows: ParsedFileRow[] = [];
  let skipped = 0;
  let minMs = Infinity;
  let maxMs = -Infinity;

  for (const raw of json) {
    const callerId = String(raw[kCaller] ?? "").trim();
    const ymd = parseDateCell(raw[kDate]);
    const hm = parseTimeCell(raw[kTime]);
    if (!callerId || !ymd || !hm) {
      skipped += 1;
      continue;
    }
    const utcMs = etWallClockToUtcMs(ymd.y, ymd.m, ymd.d, hm.H, hm.M);
    minMs = Math.min(minMs, utcMs);
    maxMs = Math.max(maxMs, utcMs);

    const dateLabel =
      `${String(ymd.m).padStart(2, "0")}/${String(ymd.d).padStart(2, "0")}/${ymd.y}`;
    const hour12 = ((hm.H + 11) % 12) + 1;
    const timeLabel =
      `${hour12}:${String(hm.M).padStart(2, "0")} ${hm.H < 12 ? "AM" : "PM"}`;

    rows.push({
      serviceType: kService ? String(raw[kService] ?? "").trim() : "",
      duration: kDuration ? String(raw[kDuration] ?? "").trim() : "",
      callerId,
      callerLast10: last10(callerId),
      costPerLead: kCpl ? parseMoney(raw[kCpl]) : null,
      etLabel: `${dateLabel} ${timeLabel} ET`,
      utcMs,
      ymd: `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`,
    });
  }

  if (rows.length === 0) {
    throw new Error("No usable rows (need Caller ID, Date, and Time)");
  }

  // Week window = min ET day 00:00 to max ET day 23:59, +/- a small buffer,
  // expressed as UTC for the Ringba fetch.
  const startBuffer = minMs - MATCH_TOLERANCE_MS - 2 * 60 * 60 * 1000;
  const endBuffer = maxMs + MATCH_TOLERANCE_MS + 2 * 60 * 60 * 1000;

  return {
    rows,
    skipped,
    weekStartIso: new Date(startBuffer).toISOString(),
    weekEndIso: new Date(endBuffer).toISOString(),
  };
}

// ---------- matching + scenario classification ----------

export interface MatchResult {
  rows: CplRowInput[];
  matched: number;
  stripped: number;
  noMatch: number;
  leftUntouched: number;
}

/**
 * Match file rows to CPL calls, then classify:
 *  set     — file row matched a call → revenue = CPL, payout = 50% (scenarios 1,2; Inquirly override).
 *  strip   — CPL call NOT in file that is $0, or has revenue but no payout → set 0/0 (scenarios 3,4).
 *  no_match— file row with no Ringba call found.
 * CPL calls not in the file that already have both revenue and payout are left untouched.
 */
export function matchAndClassify(
  fileRows: ParsedFileRow[],
  calls: CplCall[],
): MatchResult {
  // index calls by caller last-10
  const byCaller = new Map<string, CplCall[]>();
  for (const call of calls) {
    if (!call.callerLast10 || Number.isNaN(call.callDtMs)) continue;
    if (!byCaller.has(call.callerLast10)) byCaller.set(call.callerLast10, []);
    byCaller.get(call.callerLast10)!.push(call);
  }

  const usedCallIds = new Set<string>();
  const out: CplRowInput[] = [];
  let matched = 0;
  let noMatch = 0;

  for (const fr of fileRows) {
    const candidates = (byCaller.get(fr.callerLast10) || []).filter(
      (c) => !usedCallIds.has(c.inboundCallId) &&
        Math.abs(c.callDtMs - fr.utcMs) <= MATCH_TOLERANCE_MS,
    );
    candidates.sort(
      (a, b) => Math.abs(a.callDtMs - fr.utcMs) - Math.abs(b.callDtMs - fr.utcMs),
    );
    const best = candidates[0];

    if (!best) {
      noMatch += 1;
      out.push({
        action: "no_match",
        publisherName: null,
        callerId: fr.callerId,
        fileCallerId: fr.callerId,
        callDt: null,
        fileTimeEt: fr.etLabel,
        target: null,
        inboundCallId: null,
        costPerLead: fr.costPerLead,
        currentRevenue: null,
        currentPayout: null,
        newRevenue: null,
        newPayout: null,
      });
      continue;
    }

    usedCallIds.add(best.inboundCallId);
    const cpl = fr.costPerLead ?? 0;
    matched += 1;
    out.push({
      action: "set",
      publisherName: best.publisherName,
      callerId: best.callerNumber,
      fileCallerId: fr.callerId,
      callDt: best.callDt,
      fileTimeEt: fr.etLabel,
      target: best.target,
      inboundCallId: best.inboundCallId,
      costPerLead: fr.costPerLead,
      currentRevenue: best.conversionAmount,
      currentPayout: best.payoutAmount,
      newRevenue: Math.round(cpl * 100) / 100,
      newPayout: Math.round(cpl * 50) / 100, // 50% of CPL
    });
  }

  // CPL calls not claimed by any file row
  let stripped = 0;
  let leftUntouched = 0;
  for (const call of calls) {
    if (usedCallIds.has(call.inboundCallId)) continue;
    const zeroConversion = call.conversionAmount <= 0;
    const revenueNoPayout = call.conversionAmount > 0 && call.payoutAmount <= 0;
    if (zeroConversion || revenueNoPayout) {
      stripped += 1;
      out.push({
        action: "strip",
        publisherName: call.publisherName,
        callerId: call.callerNumber,
        fileCallerId: null,
        callDt: call.callDt,
        fileTimeEt: null,
        target: call.target,
        inboundCallId: call.inboundCallId,
        costPerLead: null,
        currentRevenue: call.conversionAmount,
        currentPayout: call.payoutAmount,
        newRevenue: 0,
        newPayout: 0,
      });
    } else {
      leftUntouched += 1;
    }
  }

  return { rows: out, matched, stripped, noMatch, leftUntouched };
}
