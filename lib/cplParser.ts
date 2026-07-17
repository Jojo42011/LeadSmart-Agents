import * as XLSX from "xlsx";
import { last10, type CplCall } from "./ringbaCplClient";
import type { CplRowInput } from "./cplDb";

/**
 * Parse a 33 Miles RTT / Inquirly CPL file (xlsx OR csv) and match its rows to
 * Ringba calls. XLSX.read auto-detects the format from the buffer, so both work
 * with no branching. Columns are resolved by name (findKey substring match) in
 * any order, and any extra columns are ignored, so both the original layout
 *   Service Type, Duration, Date, Time (EST), Caller ID, Cost Per Lead
 * and the newer CSV layout
 *   Account Name, Service Type, Date, Time (EST), Tracking Number,
 *   Caller ID, Duration, Cost Per Lead, Zip Code
 * parse identically.
 *
 * A second source mode, "inquirly", handles the Inquirly export instead:
 *   Date Posted (one cell, "26-07-04 7:37:27" = 2026-07-04 07:37:27),
 *   Origin Phone (the caller ID), Revenue (the amount), Billable (Yes/No)
 * Only rows with Billable = Yes are processed; everything downstream
 * (matching, payout %, preview, apply) is identical to 33 Miles mode.
 *
 * Caller IDs may be dash-formatted (954-487-0148); last10()
 * strips non-digits before matching. The "Time (EST)" label has proven
 * unreliable (EST vs EDT), so matchAndClassify auto-detects the real offset by
 * scoring candidate offsets and keeping whichever matches the most calls,
 * rather than trusting the header.
 */

const MATCH_TOLERANCE_MS = 15 * 60 * 1000; // ±15 minutes (absorbs clock skew)

/**
 * The file's "Time (EST)" label has proven unreliable (EST vs EDT), so instead
 * of hardcoding one offset we try each of these whole-hour UTC offsets at match
 * time and keep whichever yields the most caller+time hits. 4 = EDT, 5 = EST;
 * 6/7 cover a Central-time mislabel just in case.
 */
const CANDIDATE_OFFSET_HOURS = [4, 5, 6, 7] as const;
const DEFAULT_OFFSET_HOURS = 4; // EDT — correct for summer Eastern

export interface ParsedFileRow {
  serviceType: string;
  duration: string;
  callerId: string;
  callerLast10: string;
  trackingNumber: string;
  trackingLast10: string;
  costPerLead: number | null;
  etLabel: string; // human "07/06/2025 3:45 PM ET"
  utcMs: number; // display/window key (fixed UTC-5)
  naiveUtcMs: number; // wall clock as UTC; real UTC = naiveUtcMs + offsetHours*3600000
  ymd: string; // YYYY-MM-DD (ET calendar day)
}

// ---------- EST wall-clock → UTC ----------

/**
 * 33 Miles confirmed their file timestamps are always literal EST — a fixed
 * UTC-5 offset with NO daylight-saving adjustment (so a July time is still
 * UTC-5, not EDT/UTC-4). Using America/New_York would shift summer rows by an
 * hour and miss the ±5 min match. UTC = EST wall clock + 5 hours.
 */
const EST_OFFSET_MS = 5 * 60 * 60 * 1000;

function etWallClockToUtcMs(
  y: number,
  m: number,
  d: number,
  H: number,
  M: number,
): number {
  return Date.UTC(y, m - 1, d, H, M, 0, 0) + EST_OFFSET_MS;
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

/**
 * Inquirly's "Date Posted" holds date AND time in one cell with a two-digit
 * year FIRST ("26-07-04 7:37:27" = 2026-07-04 07:37:27). The generic M/D/Y
 * parsers above would misread that as month 26, so this column gets its own
 * parser. Date objects and Excel serials (xlsx exports) are handled too.
 */
function parseDateTimeCell(v: unknown): { ymd: Ymd; hm: Hm } | null {
  if (v instanceof Date) {
    return {
      ymd: { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() },
      hm: { H: v.getUTCHours(), M: v.getUTCMinutes() },
    };
  }
  if (typeof v === "number") {
    const dc = XLSX.SSF.parse_date_code(v);
    if (dc && dc.y) return { ymd: { y: dc.y, m: dc.m, d: dc.d }, hm: { H: dc.H, M: dc.M } };
    return null;
  }
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{2,4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  let y = parseInt(m[1], 10);
  if (y < 100) y += 2000;
  return {
    ymd: { y, m: parseInt(m[2], 10), d: parseInt(m[3], 10) },
    hm: { H: parseInt(m[4], 10), M: parseInt(m[5], 10) },
  };
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

export type CplSource = "33miles" | "inquirly";

export function parseCplWorkbook(
  buffer: Buffer,
  source: CplSource = "33miles",
): ParseResult {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Workbook has no sheets");

  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: true,
    defval: null,
  });
  if (json.length === 0) throw new Error("No rows found in the file");

  const keys = Object.keys(json[0]);
  let kCaller: string | null;
  let kCpl: string | null;
  let kDate: string | null;
  let kTime: string | null = null;
  let kService: string | null = null;
  let kDuration: string | null = null;
  let kTracking: string | null = null;
  let kBillable: string | null = null;

  if (source === "inquirly") {
    kCaller = findKey(keys, "origin phone", "origin");
    kCpl = findKey(keys, "revenue");
    kDate = findKey(keys, "date posted", "date");
    kBillable = findKey(keys, "billable");
    if (!kCaller) throw new Error('Missing an "Origin Phone" column');
    if (!kDate) throw new Error('Missing a "Date Posted" column');
    if (!kCpl) throw new Error('Missing a "Revenue" column');
    if (!kBillable) throw new Error('Missing a "Billable" column');
  } else {
    kCaller = findKey(keys, "caller");
    kCpl = findKey(keys, "cost per lead", "cpl", "cost");
    kDate = findKey(keys, "date");
    kTime = findKey(keys, "time");
    kService = findKey(keys, "service");
    kDuration = findKey(keys, "duration");
    kTracking = findKey(keys, "tracking");
    if (!kCaller) throw new Error('Missing a "Caller ID" column');
    if (!kDate || !kTime) throw new Error('Missing "Date" and/or "Time" columns');
  }

  const rows: ParsedFileRow[] = [];
  let skipped = 0;
  let minMs = Infinity;
  let maxMs = -Infinity;

  for (const raw of json) {
    // Inquirly: only Billable = Yes rows exist as far as this tool is
    // concerned — No/blank rows are neither matched nor used for strip scoping.
    if (kBillable) {
      const flag = String(raw[kBillable] ?? "").trim().toLowerCase();
      if (flag !== "yes") {
        skipped += 1;
        continue;
      }
    }
    const callerId = String(raw[kCaller] ?? "").trim();
    let ymd: Ymd | null;
    let hm: Hm | null;
    if (source === "inquirly") {
      const dt = parseDateTimeCell(raw[kDate]);
      ymd = dt ? dt.ymd : null;
      hm = dt ? dt.hm : null;
    } else {
      ymd = parseDateCell(raw[kDate]);
      hm = parseTimeCell(raw[kTime!]);
    }
    if (!callerId || !ymd || !hm) {
      skipped += 1;
      continue;
    }
    const utcMs = etWallClockToUtcMs(ymd.y, ymd.m, ymd.d, hm.H, hm.M);
    const naiveUtcMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hm.H, hm.M, 0, 0);
    minMs = Math.min(minMs, utcMs);
    maxMs = Math.max(maxMs, utcMs);

    const dateLabel =
      `${String(ymd.m).padStart(2, "0")}/${String(ymd.d).padStart(2, "0")}/${ymd.y}`;
    const hour12 = ((hm.H + 11) % 12) + 1;
    const timeLabel =
      `${hour12}:${String(hm.M).padStart(2, "0")} ${hm.H < 12 ? "AM" : "PM"}`;

    const trackingNumber = kTracking ? String(raw[kTracking] ?? "").trim() : "";
    rows.push({
      serviceType: kService ? String(raw[kService] ?? "").trim() : "",
      duration: kDuration ? String(raw[kDuration] ?? "").trim() : "",
      callerId,
      callerLast10: last10(callerId),
      trackingNumber,
      trackingLast10: last10(trackingNumber),
      costPerLead: kCpl ? parseMoney(raw[kCpl]) : null,
      etLabel: `${dateLabel} ${timeLabel} ET`,
      utcMs,
      naiveUtcMs,
      ymd: `${ymd.y}-${String(ymd.m).padStart(2, "0")}-${String(ymd.d).padStart(2, "0")}`,
    });
  }

  if (rows.length === 0) {
    throw new Error("No usable rows (need Caller ID, Date, and Time)");
  }

  // Week window, expressed as UTC for the Ringba fetch. The buffer is wide
  // (±6h) so the true call time falls inside the window no matter which of the
  // candidate EST/EDT/Central offsets turns out to be correct.
  const startBuffer = minMs - 6 * 60 * 60 * 1000;
  const endBuffer = maxMs + 6 * 60 * 60 * 1000;

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
  offsetHours: number; // the EST/EDT offset auto-detected for this file
  callerOverlap: number; // file billable rows whose caller exists in Ringba (any time)
  trackingOverlap: number; // file billable rows whose tracking # exists in Ringba (diagnostic)
}

/** Count file rows that find a same-caller Ringba call within tolerance at a given offset. */
function countMatchesAtOffset(
  billable: ParsedFileRow[],
  byCaller: Map<string, CplCall[]>,
  offsetHours: number,
): number {
  let count = 0;
  for (const fr of billable) {
    const fileUtc = fr.naiveUtcMs + offsetHours * 3_600_000;
    const cands = byCaller.get(fr.callerLast10);
    if (cands?.some((c) => Math.abs(c.callDtMs - fileUtc) <= MATCH_TOLERANCE_MS)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Match file rows to CPL calls, then classify:
 *  set     — a BILLABLE file row (Cost Per Lead > 0) matched a call → revenue = CPL, payout = 50%.
 *  strip   — a CPL call NOT in the file that carries revenue but no payout → set 0/0.
 *  no_match— a billable file row with no Ringba call found.
 *
 * Only billable rows drive writes: $0/non-billable file rows are ignored (nothing
 * to add), and $0 Ringba calls are ignored on the strip side too — that is the
 * "filter for calls with revenue, so old $0 DID calls are left alone" rule.
 *
 * The file's EST/EDT offset is auto-detected: we score each candidate offset by
 * how many billable rows it matches and use the winner, so a mislabeled timezone
 * can't silently zero out the matches.
 */
export function matchAndClassify(
  fileRows: ParsedFileRow[],
  calls: CplCall[],
): MatchResult {
  // index calls by caller last-10
  const byCaller = new Map<string, CplCall[]>();
  const ringbaTrackingLast10 = new Set<string>();
  for (const call of calls) {
    if (call.trackingLast10) ringbaTrackingLast10.add(call.trackingLast10);
    if (!call.callerLast10 || Number.isNaN(call.callDtMs)) continue;
    if (!byCaller.has(call.callerLast10)) byCaller.set(call.callerLast10, []);
    byCaller.get(call.callerLast10)!.push(call);
  }

  // Only billable rows produce SET writes; process highest CPL first so a
  // billable row always wins a shared caller over a cheaper one.
  const billable = fileRows
    .filter((r) => (r.costPerLead ?? 0) > 0)
    .sort((a, b) => (b.costPerLead ?? 0) - (a.costPerLead ?? 0));

  // Tracking numbers (DIDs) that appear anywhere in the file — the set of 33
  // Miles' own routing numbers. Used to scope the strip side so we never touch
  // a call that isn't 33 Miles' (the fetch now returns every buyer's calls).
  const fileTrackingSet = new Set<string>();
  for (const r of fileRows) {
    if (r.trackingLast10) fileTrackingSet.add(r.trackingLast10);
  }

  // Auto-detect the timezone offset that produces the most matches.
  let offsetHours = DEFAULT_OFFSET_HOURS;
  let bestCount = -1;
  for (const off of CANDIDATE_OFFSET_HOURS) {
    const c = countMatchesAtOffset(billable, byCaller, off);
    if (c > bestCount) {
      bestCount = c;
      offsetHours = off;
    }
  }
  const offsetMs = offsetHours * 3_600_000;

  // Diagnostics: raw overlap ignoring time (is the caller/tracking # even present?)
  let callerOverlap = 0;
  let trackingOverlap = 0;
  for (const fr of billable) {
    if (byCaller.has(fr.callerLast10)) callerOverlap += 1;
    if (fr.trackingLast10 && ringbaTrackingLast10.has(fr.trackingLast10)) {
      trackingOverlap += 1;
    }
  }

  const usedCallIds = new Set<string>();
  const out: CplRowInput[] = [];
  let matched = 0;
  let noMatch = 0;

  for (const fr of billable) {
    const fileUtc = fr.naiveUtcMs + offsetMs;
    const candidates = (byCaller.get(fr.callerLast10) || []).filter(
      (c) => !usedCallIds.has(c.inboundCallId) &&
        Math.abs(c.callDtMs - fileUtc) <= MATCH_TOLERANCE_MS,
    );
    // Rank candidates for the SAME caller+time: a call that came through this
    // file row's tracking # (the 33 Miles DID) wins first, then a CPL-target
    // named call, then nearest in time. This keeps us from claiming another
    // buyer's call when the same consumer called several buyers that week.
    const score = (c: CplCall): number => {
      let s = 0;
      if (fr.trackingLast10 && c.trackingLast10 === fr.trackingLast10) s += 1000;
      if (c.isCplTargetName) s += 100;
      return s;
    };
    candidates.sort((a, b) => {
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      return Math.abs(a.callDtMs - fileUtc) - Math.abs(b.callDtMs - fileUtc);
    });
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
    // Ramzan Ali is paid 60% of revenue; every other publisher gets 50%.
    const payoutPct = (best.publisherName || "")
      .toLowerCase()
      .includes("ramzan ali")
      ? 60
      : 50;
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
      newPayout: Math.round(cpl * payoutPct) / 100,
    });
  }

  // CPL calls not claimed by any billable file row. Only touch calls that are
  // confirmed 33 Miles (marker-named OR dialed a tracking # present in the file)
  // AND carry revenue but no payout. $0 calls (old DID noise), fully-paid calls,
  // and any call that isn't provably 33 Miles are all left untouched — the fetch
  // now returns every buyer, so this scope is what protects other buyers.
  let stripped = 0;
  let leftUntouched = 0;
  for (const call of calls) {
    if (usedCallIds.has(call.inboundCallId)) continue;
    const isThirtyThreeMiles =
      call.isCplTargetName ||
      (!!call.trackingLast10 && fileTrackingSet.has(call.trackingLast10));
    const revenueNoPayout = call.conversionAmount > 0 && call.payoutAmount <= 0;
    if (isThirtyThreeMiles && revenueNoPayout) {
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

  console.log(
    "[CPL] match: offset=UTC-%d, billable=%d, matched=%d, noMatch=%d, strip=%d, leftUntouched=%d | callerOverlap=%d, trackingOverlap=%d",
    offsetHours,
    billable.length,
    matched,
    noMatch,
    stripped,
    leftUntouched,
    callerOverlap,
    trackingOverlap,
  );

  return {
    rows: out,
    matched,
    stripped,
    noMatch,
    leftUntouched,
    offsetHours,
    callerOverlap,
    trackingOverlap,
  };
}
