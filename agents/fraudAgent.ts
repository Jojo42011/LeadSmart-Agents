import { createHash } from "crypto";
import OpenAI from "openai";
import {
  fetchConvertedCallsForFraud,
  downloadRecording,
  type FraudCallRecord,
} from "../lib/ringbaFraudClient";
import {
  lookupPhone,
  evaluatePhoneIntel,
  isIpqsConfigured,
  normalizePhoneNumber,
} from "../lib/ipqsClient";
import {
  bumpPublisherTotals,
  flagCall,
  getCallAnalysis,
  getFraudPollState,
  listFlaggedCalls,
  markCallProcessed,
  pruneStaleSharedCallerFlags,
  publishersForCallerSince,
  recomputePublisherRisk,
  recordCallerSighting,
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
  aiFlags: number;
  ipqsLookups: number;
  transcriptionsRun: number;
  errors: number;
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
    aiFlags: 0,
    ipqsLookups: 0,
    transcriptionsRun: 0,
    errors: 0,
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
  } catch (err) {
    console.warn(
      "[Fraud] shared-caller prune failed: %s",
      err instanceof Error ? err.message : err
    );
  }

  const { calls, truncated } = await fetchConvertedCallsForFraud(
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

  // Only advance the window when the fetch was complete; a truncated window
  // re-scans from the same point next cycle (dedup makes that cheap).
  setFraudPollState(
    new Date().toISOString(),
    truncated ? window.start : window.end
  );

  console.log(
    "[Fraud] Scan complete: %d seen, %d new, %d voip flags, %d shared-caller flags, %d ai flags, %d IPQS lookups, %d transcriptions, %d errors",
    result.callsSeen,
    result.callsProcessed,
    result.voipFlags,
    result.sharedCallerFlags,
    result.aiFlags,
    result.ipqsLookups,
    result.transcriptionsRun,
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

  // Step 2 bookkeeping — record the sighting before evaluating cross-publisher.
  if (callerNumber) {
    recordCallerSighting(
      callerNumber,
      call.publisherName,
      call.callDt ?? new Date().toISOString()
    );
  }

  // Step 1 — IPQS VOIP / spoof detection.
  if (callerNumber) {
    const intel = await lookupPhone(callerNumber);
    if (intel && !intel.fromCache) {
      result.ipqsLookups += 1;
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
}
