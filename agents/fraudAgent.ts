import { createHash } from "crypto";
import OpenAI from "openai";
import {
  fetchConvertedCallsForFraud,
  fetchNoConnectCallsForFraud,
  downloadRecording,
  type FraudCallRecord,
} from "../lib/ringbaFraudClient";
import { deriveServiceCategory } from "../lib/fraudCategories";
import {
  lookupPhone,
  evaluatePhoneIntel,
  getLastIpqsFailure,
  isIpqsConfigured,
  normalizePhoneNumber,
  type IpqsFailureInfo,
} from "../lib/ipqsClient";
import {
  bumpPublisherTotals,
  callerServiceBreakdownSince,
  distinctPublisherCountForCallerSince,
  flagCall,
  getCallAnalysis,
  getFraudPollState,
  listFlaggedCalls,
  markCallProcessed,
  pruneCallerEvents,
  pruneNoConnectIndex,
  pruneOverBroadSharedCallerFlags,
  pruneStaleSharedCallerFlags,
  publishersForCallerBetween,
  publishersForCallerSince,
  recomputePublisherRisk,
  recordCallerEvent,
  recordCallerServiceSighting,
  recordCallerSighting,
  recordNoConnectSighting,
  saveCallAnalysis,
  setFraudPollState,
  transcriptHashCount,
  wasCallProcessed,
} from "../lib/fraudDb";
import { notifyFraudAlert } from "../lib/fraudNotify";

/**
 * System 3 fraud scan over CONVERTED calls only (cheaper on IPQS; fraud on
 * converted calls is what costs money). Detection flags + alerts — blocking is
 * always a manual action from the fraud dashboard.
 *
 * Step 1: IPQS VOIP / spoof / virtual-carrier detection on caller numbers.
 * Step 2: caller-ID cross reference — same number under multiple publishers.
 * Step 3: transcription + AI tone analysis on flagged calls with recordings.
 */

export interface FraudScanResult {
  windowStart: string;
  windowEnd: string;
  callsSeen: number;
  callsProcessed: number;
  voipFlags: number;
  sharedCallerFlags: number;
  crossVerticalFlags: number;
  coordinatedFlags: number;
  robocallReclassified: number;
  aiFlags: number;
  /** Calls with a usable caller number that reached lookupPhone. */
  ipqsAttempted: number;
  /** Lookups served from the 30-day phone_intel cache (no API call, no cost). */
  ipqsCacheHits: number;
  /** Fresh paid IPQS API lookups. */
  ipqsLookups: number;
  /** Lookups that returned no intel while IPQS is configured (API failure/unsuccessful). */
  ipqsFailures: number;
  /** Why the most recent lookup failed — pinpoints outages without log access. */
  ipqsLastFailure: IpqsFailureInfo | null;
  transcriptionsRun: number;
  errors: number;
  noConnectSeen: number;
  noConnectNew: number;
  publishersAlerted: string[];
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/** Default lookback when no scan has run yet; also caps catch-up windows. */
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_WINDOW_HOURS = 72;

function scanWindow(): { start: string; end: string } {
  const state = getFraudPollState();
  const now = Date.now();
  const maxStart = now - MAX_WINDOW_HOURS * 60 * 60 * 1000;
  const defaultStart = now - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000;

  let startMs = defaultStart;
  if (state.lastWindowEnd) {
    const last = new Date(state.lastWindowEnd).getTime();
    if (Number.isFinite(last)) {
      // Small overlap so boundary calls are never missed (dedup absorbs repeats).
      startMs = last - 10 * 60 * 1000;
    }
  }
  startMs = Math.max(startMs, maxStart);

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(now).toISOString(),
  };
}

interface PublisherAlertDraft {
  reason: string;
  severity: number;
  callerNumber: string | null;
  signals: string[];
}

// ---------- step 3: transcription + tone analysis ----------

function normalizeTranscript(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function transcriptHash(transcript: string): string {
  return createHash("sha256").update(normalizeTranscript(transcript)).digest("hex");
}

async function transcribeRecording(
  apiKey: string,
  audio: Buffer
): Promise<string | null> {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([new Uint8Array(audio)]), "call.mp3");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    console.warn(
      "[Fraud/AI] transcription failed %d: %s",
      res.status,
      (await res.text().catch(() => "")).slice(0, 300)
    );
    return null;
  }
  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim();
  return text || null;
}

interface AiVerdict {
  aiScore: number;
  verdict: string;
  reasons: string[];
}

async function analyzeTranscript(
  client: OpenAI,
  transcript: string,
  duplicateCount: number
): Promise<AiVerdict | null> {
  const model = process.env.OPENAI_FAST_MODEL?.trim() || "gpt-4o-mini";
  const prompt =
    `You are a call-fraud analyst for a pay-per-call network. Analyze this call transcript ` +
    `for signs of FAKE traffic: robotic/synthesized voices, callers reading a word-for-word script, ` +
    `incentivized or coached callers, calls with no genuine intent, or repeated filler to hit duration minimums.` +
    (duplicateCount > 1
      ? ` NOTE: this exact transcript (normalized) has now appeared ${duplicateCount} times across calls — strong script-reuse signal.`
      : "") +
    `\n\nReturn ONLY JSON: {"ai_score": 0-100 (likelihood the call is fake), "verdict": "clean" | "suspicious" | "likely_fake", "reasons": [short strings]}` +
    `\n\nTranscript:\n${transcript.slice(0, 6000)}`;

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.choices[0]?.message?.content?.trim() ?? "";
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd <= jsonStart) {
      return null;
    }
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      ai_score?: unknown;
      verdict?: unknown;
      reasons?: unknown;
    };
    const aiScore =
      typeof parsed.ai_score === "number"
        ? Math.max(0, Math.min(100, Math.round(parsed.ai_score)))
        : 0;
    return {
      aiScore,
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : "unknown",
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.map((r) => String(r)).slice(0, 8)
        : [],
    };
  } catch (err) {
    console.warn(
      "[Fraud/AI] transcript analysis failed: %s",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** AI verdicts at or above this score raise an ai_analysis flag. */
const AI_FLAG_THRESHOLD = 70;

/**
 * Shared-caller thresholds. A caller ID appearing under 2 publishers is normal
 * consumer behavior at this call volume and must NOT flag. It only flags when
 * the SAME number is seen under enough DISTINCT publishers inside a window:
 *   - 3+ distinct publishers within 24 hours, or
 *   - 4+ distinct publishers within 7 days.
 * Repeat calls from one caller under the same publisher never count twice — the
 * caller_index primary key collapses them (see publishersForCallerSince).
 */
const SHARED_CALLER_24H_MIN = 3;
const SHARED_CALLER_7D_MIN = 4;
const SHARED_CALLER_24H_MS = 24 * 60 * 60 * 1000;
const SHARED_CALLER_7D_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cross-vertical rule (Seth): the same caller inside ONE service vertical is
 * normal shopping no matter how it splits across publishers — but the same
 * caller across 3+ DIFFERENT service categories within 7 days is a recycled
 * fake lead. Two categories stays silent (plumber + electrician in the same
 * week is a real homeowner). Tunable without a redeploy via env.
 */
function crossVerticalMinCategories(): number {
  return Math.max(2, envInt("FRAUD_CROSS_VERTICAL_MIN", 3));
}

/**
 * Robocall cap (Seth): a caller ID seen under MORE than this many distinct
 * publishers in 7 days (connected or not) is a robocaller, not a fraud ring —
 * real rings target 2-5 specific publishers. Such numbers are reclassified
 * onto the no-connect/robocall watchlist and excluded from shared-caller,
 * cross-vertical, and coordinated-attack fraud signals.
 */
function sharedCallerMaxPublishers(): number {
  return Math.max(3, envInt("FRAUD_SHARED_CALLER_MAX_PUBS", 8));
}

/**
 * Coordinated attack (Seth's strongest signal): the same caller ID under 3+
 * publishers within a 5-minute window — e.g. seven publishers at 8:41 AM.
 * Applies regardless of call duration. HIGH-RISK severity by construction.
 */
function coordinatedMinPublishers(): number {
  return Math.max(2, envInt("FRAUD_COORDINATED_MIN_PUBS", 3));
}
function coordinatedWindowMinutes(): number {
  return Math.max(1, envInt("FRAUD_COORDINATED_WINDOW_MIN", 5));
}

function sevenDaysAgoIso(): string {
  return new Date(Date.now() - SHARED_CALLER_7D_MS).toISOString();
}

interface CoordinatedCheckInput {
  result: FraudScanResult;
  callerNumber: string;
  inboundCallId: string;
  publisherName: string;
  callDt: string | null;
  connected: boolean;
  proposeAlert: (publisherName: string, draft: PublisherAlertDraft) => void;
}

/**
 * Flag when this caller hit `coordinatedMinPublishers()`+ distinct publishers
 * within ±window of this call. Both connected and no-connect events count —
 * the burst pattern is the signal, not the durations. Callers must apply the
 * robocall cap BEFORE invoking this.
 */
function evaluateCoordinatedAttack(input: CoordinatedCheckInput): void {
  const callMs = input.callDt ? new Date(input.callDt).getTime() : NaN;
  const centerMs = Number.isFinite(callMs) ? callMs : Date.now();
  const windowMin = coordinatedWindowMinutes();
  const windowMs = windowMin * 60 * 1000;
  const publishers = publishersForCallerBetween(
    input.callerNumber,
    new Date(centerMs - windowMs).toISOString(),
    new Date(centerMs + windowMs).toISOString()
  );
  const count = publishers.length;
  if (count < coordinatedMinPublishers()) {
    return;
  }

  // 3 publishers → 95, 4+ → 100. Always clears the HIGH-RISK line.
  const severity = Math.min(100, 80 + count * 5);

  const isNew = flagCall({
    inboundCallId: input.inboundCallId,
    publisherName: input.publisherName,
    callerNumber: input.callerNumber,
    callDt: input.callDt,
    reason: "coordinated_attack",
    severity,
    detail: {
      publishers,
      publisherCount: count,
      windowMinutes: windowMin,
      connectedCall: input.connected,
    },
  });
  if (isNew) {
    input.result.coordinatedFlags += 1;
    recomputePublisherRisk(input.publisherName);
    input.proposeAlert(input.publisherName, {
      reason: `Coordinated attack: same caller hit ${count} publishers within ${windowMin} minutes`,
      severity,
      callerNumber: input.callerNumber,
      signals: publishers.map((p) => `hit: ${p}`),
    });
  }
}

async function runTranscriptionPass(
  result: FraudScanResult,
  recordingUrlByCallId: Map<string, string>,
  publisherByCallId: Map<string, string>
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    console.log("[Fraud/AI] OPENAI_API_KEY not set — skipping transcription pass");
    return;
  }
  const maxPerScan = envInt("FRAUD_MAX_TRANSCRIPTIONS_PER_SCAN", 5);
  if (maxPerScan <= 0) {
    return;
  }

  // Worst offenders first: recent flagged calls that have a recording and no analysis yet.
  const candidates = listFlaggedCalls(200)
    .filter(
      (flag) =>
        recordingUrlByCallId.has(flag.inboundCallId) &&
        !getCallAnalysis(flag.inboundCallId)
    )
    .sort((a, b) => b.severity - a.severity);

  const seen = new Set<string>();
  const client = new OpenAI({ apiKey });
  let ran = 0;

  for (const flag of candidates) {
    if (ran >= maxPerScan) {
      break;
    }
    if (seen.has(flag.inboundCallId)) {
      continue;
    }
    seen.add(flag.inboundCallId);

    const recordingUrl = recordingUrlByCallId.get(flag.inboundCallId)!;
    const publisherName =
      publisherByCallId.get(flag.inboundCallId) ?? flag.publisherName;

    try {
      const audio = await downloadRecording(recordingUrl);
      const transcript = await transcribeRecording(apiKey, audio);
      ran += 1;
      result.transcriptionsRun += 1;

      if (!transcript) {
        saveCallAnalysis({
          inboundCallId: flag.inboundCallId,
          publisherName,
          transcript: null,
          transcriptHash: null,
          aiScore: null,
          verdict: "transcription_failed",
          reasons: null,
        });
        continue;
      }

      const hash = transcriptHash(transcript);
      // Save first so the duplicate count includes this call.
      saveCallAnalysis({
        inboundCallId: flag.inboundCallId,
        publisherName,
        transcript,
        transcriptHash: hash,
        aiScore: null,
        verdict: "pending",
        reasons: null,
      });
      const duplicates = transcriptHashCount(hash);

      const verdict = await analyzeTranscript(client, transcript, duplicates);
      if (!verdict) {
        continue;
      }

      const reasons = [...verdict.reasons];
      let aiScore = verdict.aiScore;
      if (duplicates > 1) {
        reasons.unshift(`identical script across ${duplicates} calls`);
        aiScore = Math.max(aiScore, 85);
      }

      saveCallAnalysis({
        inboundCallId: flag.inboundCallId,
        publisherName,
        transcript,
        transcriptHash: hash,
        aiScore,
        verdict: verdict.verdict,
        reasons: JSON.stringify(reasons),
      });

      if (aiScore >= AI_FLAG_THRESHOLD) {
        const isNew = flagCall({
          inboundCallId: flag.inboundCallId,
          publisherName,
          callerNumber: flag.callerNumber,
          callDt: flag.callDt,
          reason: "ai_analysis",
          severity: aiScore,
          detail: { verdict: verdict.verdict, reasons, duplicates },
        });
        if (isNew) {
          result.aiFlags += 1;
          recomputePublisherRisk(publisherName);
        }
      }
    } catch (err) {
      result.errors += 1;
      console.warn(
        "[Fraud/AI] recording analysis failed for %s: %s",
        flag.inboundCallId,
        err instanceof Error ? err.message : err
      );
    }
  }
}

// ---------- main scan ----------

let scanInFlight: Promise<FraudScanResult> | null = null;

export function isFraudScanRunning(): boolean {
  return scanInFlight !== null;
}

export async function runFraudScan(): Promise<FraudScanResult> {
  if (scanInFlight) {
    return scanInFlight;
  }
  scanInFlight = executeFraudScan().finally(() => {
    scanInFlight = null;
  });
  return scanInFlight;
}

async function executeFraudScan(): Promise<FraudScanResult> {
  const window = scanWindow();
  const result: FraudScanResult = {
    windowStart: window.start,
    windowEnd: window.end,
    callsSeen: 0,
    callsProcessed: 0,
    voipFlags: 0,
    sharedCallerFlags: 0,
    crossVerticalFlags: 0,
    coordinatedFlags: 0,
    robocallReclassified: 0,
    aiFlags: 0,
    ipqsAttempted: 0,
    ipqsCacheHits: 0,
    ipqsLookups: 0,
    ipqsFailures: 0,
    ipqsLastFailure: null,
    transcriptionsRun: 0,
    errors: 0,
    noConnectSeen: 0,
    noConnectNew: 0,
    publishersAlerted: [],
  };

  console.log(
    "[Fraud] Scan started window %s → %s (IPQS %s)",
    window.start,
    window.end,
    isIpqsConfigured() ? "configured" : "NOT configured"
  );

  // Retire shared-caller flags raised under the old 2-publisher rule so the
  // HIGH-RISK list reflects only the current threshold. Idempotent after the
  // first scan. Never touches VOIP or AI flags.
  try {
    const pruned = pruneStaleSharedCallerFlags(SHARED_CALLER_24H_MIN);
    if (pruned > 0) {
      console.log(
        "[Fraud] Pruned %d stale shared-caller flag(s) below the %d-publisher threshold",
        pruned,
        SHARED_CALLER_24H_MIN
      );
    }
    // Robocall cap, retroactively: shared-caller flags spanning more
    // publishers than the cap were robocallers, not fraud rings.
    const prunedBroad = pruneOverBroadSharedCallerFlags(sharedCallerMaxPublishers());
    if (prunedBroad > 0) {
      console.log(
        "[Fraud] Reclassified %d shared-caller flag(s) above the %d-publisher robocall cap",
        prunedBroad,
        sharedCallerMaxPublishers()
      );
    }
  } catch (err) {
    console.warn(
      "[Fraud] shared-caller prune failed: %s",
      err instanceof Error ? err.message : err
    );
  }

  const { calls, truncated, lastCallDt } = await fetchConvertedCallsForFraud(
    window.start,
    window.end
  );
  result.callsSeen = calls.length;

  const recordingUrlByCallId = new Map<string, string>();
  const publisherByCallId = new Map<string, string>();
  const newCallsByPublisher = new Map<string, number>();
  const alertDrafts = new Map<string, PublisherAlertDraft>();
  const touchedPublishers = new Set<string>();

  const proposeAlert = (publisherName: string, draft: PublisherAlertDraft) => {
    const existing = alertDrafts.get(publisherName);
    if (!existing || draft.severity > existing.severity) {
      alertDrafts.set(publisherName, draft);
    }
  };

  for (const call of calls) {
    if (call.recordingUrl) {
      recordingUrlByCallId.set(call.inboundCallId, call.recordingUrl);
    }
    publisherByCallId.set(call.inboundCallId, call.publisherName);

    if (wasCallProcessed(call.inboundCallId)) {
      continue;
    }

    try {
      await processCall(call, result, proposeAlert, touchedPublishers);
      markCallProcessed(call.inboundCallId);
      result.callsProcessed += 1;
      newCallsByPublisher.set(
        call.publisherName,
        (newCallsByPublisher.get(call.publisherName) ?? 0) + 1
      );
    } catch (err) {
      result.errors += 1;
      console.warn(
        "[Fraud] call processing failed for %s: %s",
        call.inboundCallId,
        err instanceof Error ? err.message : err
      );
    }
  }

  for (const [publisherName, count] of newCallsByPublisher) {
    bumpPublisherTotals(publisherName, count);
  }
  for (const publisherName of touchedPublishers) {
    recomputePublisherRisk(publisherName);
  }

  // Step 3 — transcription + tone analysis on the worst flagged calls.
  try {
    await runTranscriptionPass(result, recordingUrlByCallId, publisherByCallId);
  } catch (err) {
    result.errors += 1;
    console.warn(
      "[Fraud/AI] transcription pass failed: %s",
      err instanceof Error ? err.message : err
    );
  }

  // No-connect pass — robocalls/solicitors (duration = 0). A completely
  // separate watchlist: nothing here flags calls, alerts publishers, or feeds
  // risk scores. Aggregate-only writes; failures never break the main scan.
  try {
    const { calls: noConnectCalls } = await fetchNoConnectCallsForFraud(
      window.start,
      window.end
    );
    result.noConnectSeen = noConnectCalls.length;
    for (const nc of noConnectCalls) {
      if (!nc.inboundPhoneNumber) {
        continue;
      }
      if (wasCallProcessed(nc.inboundCallId)) {
        continue;
      }
      const number = normalizePhoneNumber(nc.inboundPhoneNumber);
      if (!number) {
        continue;
      }
      const ncDt = nc.callDt ?? new Date().toISOString();
      recordNoConnectSighting(number, nc.publisherName, ncDt);
      recordCallerEvent(number, nc.publisherName, ncDt, false);
      markCallProcessed(nc.inboundCallId);
      result.noConnectNew += 1;

      // Coordinated attack counts no-connects too ("regardless of call
      // duration") — but the robocall cap still wins: a number spraying more
      // publishers than the cap stays a robocall, never a fraud flag.
      const allPublishers7d = distinctPublisherCountForCallerSince(
        number,
        sevenDaysAgoIso()
      );
      if (allPublishers7d <= sharedCallerMaxPublishers()) {
        evaluateCoordinatedAttack({
          result,
          callerNumber: number,
          inboundCallId: nc.inboundCallId,
          publisherName: nc.publisherName,
          callDt: nc.callDt,
          connected: false,
          proposeAlert,
        });
      }
    }
    pruneNoConnectIndex();
    pruneCallerEvents();
  } catch (err) {
    result.errors += 1;
    console.warn(
      "[Fraud] no-connect pass failed: %s",
      err instanceof Error ? err.message : err
    );
  }

  // Alerts — one per publisher per scan, throttled inside notifyFraudAlert.
  for (const [publisherName, draft] of alertDrafts) {
    const row = recomputePublisherRisk(publisherName);
    await notifyFraudAlert({
      publisherName,
      reason: draft.reason,
      severity: draft.severity,
      callerNumber: draft.callerNumber,
      signals: draft.signals,
      flaggedCalls: row.flaggedCalls,
      riskScore: row.riskScore,
    });
    result.publishersAlerted.push(publisherName);
  }

  // Advance the window cursor. Complete fetch → window end. Truncated fetch →
  // the newest callDt actually fetched, so the next scan resumes right behind
  // it and a backlog drains at ~1,000 rows per scan. NEVER stay at
  // window.start on truncation: that pins the window at the 72h cap forever
  // (each scan re-reads the same first 1,000 rows, everything dedups, and
  // IPQS lookups/flags flatline — the early-August outage).
  const nextWindowEnd = truncated ? (lastCallDt ?? window.end) : window.end;
  if (truncated) {
    console.warn(
      "[Fraud] window truncated — cursor advanced to last fetched call at %s (was start %s)",
      nextWindowEnd,
      window.start
    );
  }
  setFraudPollState(new Date().toISOString(), nextWindowEnd);

  // IPQS funnel — how many calls were sent to IPQS vs blocked before lookup.
  if (result.ipqsFailures > 0) {
    result.ipqsLastFailure = getLastIpqsFailure();
  }
  console.log(
    "[Fraud/IPQS] funnel: %d new calls, %d blocked by robocall cap before lookup, %d reached lookup → %d cache hits, %d fresh API lookups, %d failures (configured: %s)%s",
    result.callsProcessed,
    result.robocallReclassified,
    result.ipqsAttempted,
    result.ipqsCacheHits,
    result.ipqsLookups,
    result.ipqsFailures,
    isIpqsConfigured() ? "yes" : "NO — set IPQS_API_KEY",
    result.ipqsLastFailure
      ? ` — last failure [${result.ipqsLastFailure.kind}]: ${result.ipqsLastFailure.message}`
      : ""
  );

  console.log(
    "[Fraud] Scan complete: %d seen, %d new, %d voip flags, %d shared-caller flags, %d cross-vertical flags, %d coordinated flags, %d robocall-reclassified, %d ai flags, %d IPQS lookups, %d transcriptions, %d no-connect calls (%d new), %d errors",
    result.callsSeen,
    result.callsProcessed,
    result.voipFlags,
    result.sharedCallerFlags,
    result.crossVerticalFlags,
    result.coordinatedFlags,
    result.robocallReclassified,
    result.aiFlags,
    result.ipqsLookups,
    result.transcriptionsRun,
    result.noConnectSeen,
    result.noConnectNew,
    result.errors
  );

  return result;
}

async function processCall(
  call: FraudCallRecord,
  result: FraudScanResult,
  proposeAlert: (publisherName: string, draft: PublisherAlertDraft) => void,
  touchedPublishers: Set<string>
): Promise<void> {
  const callerNumber = call.inboundPhoneNumber
    ? normalizePhoneNumber(call.inboundPhoneNumber)
    : null;
  const callDt = call.callDt ?? new Date().toISOString();

  // Connected calls ONLY feed fraud detection (Seth). The fetch already
  // filters duration > 0 at the API and locally, but Ringba filters have been
  // unreliable — so enforce it here too. A zero-duration call that slips
  // through is routed to the robocall watchlist instead and never touches
  // caller_index or any fraud signal.
  if (call.durationSeconds <= 0) {
    if (callerNumber) {
      recordNoConnectSighting(callerNumber, call.publisherName, callDt);
      recordCallerEvent(callerNumber, call.publisherName, callDt, false);
    }
    return;
  }

  // Step 2 bookkeeping — record the sighting before evaluating cross-publisher.
  if (callerNumber) {
    recordCallerSighting(callerNumber, call.publisherName, callDt);
    recordCallerEvent(callerNumber, call.publisherName, callDt, true);
  }

  // Step 2b bookkeeping — the same sighting split by service vertical. An
  // unknown category (null) is never recorded: cross-vertical detection only
  // counts services we could actually identify from the campaign/target name.
  const serviceCategory = deriveServiceCategory(call.campaignName, call.targetName);
  if (callerNumber && serviceCategory) {
    recordCallerServiceSighting(
      callerNumber,
      serviceCategory,
      call.publisherName,
      call.callDt ?? new Date().toISOString()
    );
  }

  // Robocall cap gate (Seth) — checked BEFORE the paid IPQS lookup so
  // robocaller numbers never burn lookup credits. More than N distinct
  // publishers in 7 days (counting no-connect attempts too) = robocaller,
  // not a fraud ring: reclassify onto the robocall watchlist and skip every
  // detection signal for this call.
  if (callerNumber) {
    const allPublishers7d = distinctPublisherCountForCallerSince(
      callerNumber,
      sevenDaysAgoIso()
    );
    if (allPublishers7d > sharedCallerMaxPublishers()) {
      recordNoConnectSighting(callerNumber, call.publisherName, callDt);
      result.robocallReclassified += 1;
      return;
    }
  }

  // Step 1 — IPQS VOIP / spoof detection.
  if (callerNumber) {
    const intel = await lookupPhone(callerNumber);
    result.ipqsAttempted += 1;
    if (intel && intel.fromCache) {
      result.ipqsCacheHits += 1;
    } else if (intel) {
      result.ipqsLookups += 1;
    } else if (isIpqsConfigured()) {
      result.ipqsFailures += 1;
    }
    if (intel) {
      const evaluation = evaluatePhoneIntel(intel);
      if (evaluation.flagged) {
        const isNew = flagCall({
          inboundCallId: call.inboundCallId,
          publisherName: call.publisherName,
          callerNumber,
          callDt: call.callDt,
          reason: "voip",
          severity: evaluation.severity,
          detail: {
            signals: evaluation.signals,
            fraudScore: intel.fraudScore,
            lineType: intel.lineType,
            carrier: intel.carrier,
            location: `${intel.city}, ${intel.region} ${intel.country}`.trim(),
            payoutAmount: call.payoutAmount,
            target: call.targetName,
          },
        });
        if (isNew) {
          result.voipFlags += 1;
          touchedPublishers.add(call.publisherName);
          proposeAlert(call.publisherName, {
            reason: "VOIP / spoofed caller detected",
            severity: evaluation.severity,
            callerNumber,
            signals: evaluation.signals,
          });
        }
      }
    }
  }

  // Coordinated attack — strongest signal, checked before the slower-burn
  // rules. Same caller, 3+ publishers, minutes apart. (The robocall cap
  // above already excluded wide-spray numbers.)
  if (callerNumber) {
    evaluateCoordinatedAttack({
      result,
      callerNumber,
      inboundCallId: call.inboundCallId,
      publisherName: call.publisherName,
      callDt: call.callDt,
      connected: true,
      proposeAlert,
    });
  }

  // Step 2 — same caller ID under multiple DISTINCT publishers within a window.
  // 2 publishers is normal at this volume and never flags; only 3+ in 24h or
  // 4+ in 7 days does. Distinctness is guaranteed by the caller_index PK, so a
  // caller repeatedly hitting one publisher can never trip this.
  if (callerNumber) {
    const now = Date.now();
    const since24h = new Date(now - SHARED_CALLER_24H_MS).toISOString();
    const since7d = new Date(now - SHARED_CALLER_7D_MS).toISOString();
    const publishers24h = publishersForCallerSince(callerNumber, since24h);
    const publishers7d = publishersForCallerSince(callerNumber, since7d);

    const hit24h = publishers24h.length >= SHARED_CALLER_24H_MIN;
    const hit7d = publishers7d.length >= SHARED_CALLER_7D_MIN;

    if (hit24h || hit7d) {
      // Report against whichever window is the stronger signal.
      const windowLabel = hit24h ? "24h" : "7d";
      const publishers = hit24h ? publishers24h : publishers7d;
      const count = publishers.length;
      // 3 pubs/24h → 86, 4 → 98; 4 pubs/7d → 98. Clears the 85 HIGH-RISK line
      // only when the sharing is genuinely broad.
      const severity = Math.min(100, 50 + count * 12);

      for (const publisherName of publishers) {
        touchedPublishers.add(publisherName);
      }
      const isNew = flagCall({
        inboundCallId: call.inboundCallId,
        publisherName: call.publisherName,
        callerNumber,
        callDt: call.callDt,
        reason: "shared_caller",
        severity,
        detail: {
          publishers,
          publisherCount: count,
          window: windowLabel,
          payoutAmount: call.payoutAmount,
        },
      });
      if (isNew) {
        result.sharedCallerFlags += 1;
        proposeAlert(call.publisherName, {
          reason: `Same caller ID across ${count} publishers in ${windowLabel}`,
          severity,
          callerNumber,
          signals: publishers.map((p) => `seen under: ${p}`),
        });
      }
    }
  }

  // Step 2c — cross-vertical recycling: same caller ID across DIFFERENT
  // service categories within 7 days. Same-vertical shopping never trips this
  // (it stays one category regardless of publisher count); a lead recycled
  // through plumbing + HVAC + roofing does.
  if (callerNumber && serviceCategory) {
    const since7d = new Date(Date.now() - SHARED_CALLER_7D_MS).toISOString();
    const breakdown = callerServiceBreakdownSince(callerNumber, since7d);
    const categoryCount = breakdown.length;
    const minCategories = crossVerticalMinCategories();

    if (categoryCount >= minCategories) {
      // Same scale as shared_caller: 3 categories → 86, 4+ → 98+. Clears the
      // 85 HIGH-RISK line only when the recycling is genuinely cross-vertical.
      const severity = Math.min(100, 50 + categoryCount * 12);

      touchedPublishers.add(call.publisherName);
      const isNew = flagCall({
        inboundCallId: call.inboundCallId,
        publisherName: call.publisherName,
        callerNumber,
        callDt: call.callDt,
        reason: "cross_vertical",
        severity,
        detail: {
          categories: breakdown,
          categoryCount,
          window: "7d",
          thisCallCategory: serviceCategory,
          campaignName: call.campaignName,
          payoutAmount: call.payoutAmount,
        },
      });
      if (isNew) {
        result.crossVerticalFlags += 1;
        proposeAlert(call.publisherName, {
          reason: `Same caller across ${categoryCount} service verticals in 7 days`,
          severity,
          callerNumber,
          signals: breakdown.map(
            (b) =>
              `${b.serviceCategory}: ${b.publisherCount} pub${b.publisherCount === 1 ? "" : "s"} / ${b.callCount} call${b.callCount === 1 ? "" : "s"}`
          ),
        });
      }
    }
  }
}
