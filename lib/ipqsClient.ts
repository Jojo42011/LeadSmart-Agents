import axios from "axios";
import { getPhoneIntel, savePhoneIntel, type PhoneIntelRow } from "./fraudDb";

/**
 * IPQualityScore Phone Validation API.
 * Docs: https://www.ipqualityscore.com/documentation/phone-number-validation-api/overview
 * GET https://www.ipqualityscore.com/api/json/phone/{API_KEY}/{number}
 *
 * Key response fields: valid, active, fraud_score (0-100; >=85 suspicious,
 * >=90 high risk), VOIP, risky, recent_abuse, spammer, prepaid,
 * line_type (Toll-Free | Wireless | Landline | Satellite | VOIP | Premium Rate | Pager | N/A),
 * carrier, country, city, region.
 */

const IPQS_BASE_URL = "https://www.ipqualityscore.com/api/json/phone";
/** Cached lookups stay fresh this long — phone intel changes slowly. */
const INTEL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Numbers whose lookup came back success:false (invalid input, rate limit,
 * insufficient credits) are not retried for this long. Without this, every
 * 15-minute scan re-attempts the same doomed numbers and burns quota the
 * moment credits refill.
 */
const NEGATIVE_CACHE_TTL_MS = 60 * 60 * 1000;
const negativeCache = new Map<string, number>();

function isNegativelyCached(phoneNumber: string): boolean {
  const until = negativeCache.get(phoneNumber);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    negativeCache.delete(phoneNumber);
    return false;
  }
  return true;
}

export interface PhoneIntel {
  phoneNumber: string;
  fraudScore: number;
  lineType: string;
  voip: boolean;
  risky: boolean;
  recentAbuse: boolean;
  spammer: boolean;
  valid: boolean;
  carrier: string;
  country: string;
  city: string;
  region: string;
  fromCache: boolean;
}

export function isIpqsConfigured(): boolean {
  return Boolean(process.env.IPQS_API_KEY?.trim());
}

/** Normalize to digits with country code (US default when 10 digits). */
export function normalizePhoneNumber(raw: string): string | null {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return `1${digits}`;
  }
  if (digits.length >= 11 && digits.length <= 15) {
    return digits;
  }
  return null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function intelFromCacheRow(row: PhoneIntelRow): PhoneIntel {
  return {
    phoneNumber: row.phoneNumber,
    fraudScore: row.fraudScore ?? 0,
    lineType: row.lineType ?? "N/A",
    voip: row.voip === 1,
    risky: row.risky === 1,
    recentAbuse: row.recentAbuse === 1,
    spammer: row.spammer === 1,
    valid: row.valid === 1,
    carrier: row.carrier ?? "N/A",
    country: row.country ?? "N/A",
    city: row.city ?? "N/A",
    region: row.region ?? "N/A",
    fromCache: true,
  };
}

/**
 * Look up a phone number, serving from the fraud.db cache when fresh.
 * Returns null when IPQS is not configured, the number is unusable, or the
 * lookup fails — callers treat null as "no intel", never as "clean".
 */
export async function lookupPhone(rawNumber: string): Promise<PhoneIntel | null> {
  const apiKey = process.env.IPQS_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const phoneNumber = normalizePhoneNumber(rawNumber);
  if (!phoneNumber) {
    return null;
  }

  const cached = getPhoneIntel(phoneNumber);
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < INTEL_TTL_MS) {
    return intelFromCacheRow(cached);
  }

  if (isNegativelyCached(phoneNumber)) {
    return cached ? intelFromCacheRow(cached) : null;
  }

  const strictness = parseInt(process.env.IPQS_STRICTNESS ?? "1", 10);

  try {
    const res = await axios.get<Record<string, unknown>>(
      `${IPQS_BASE_URL}/${encodeURIComponent(apiKey)}/${encodeURIComponent(phoneNumber)}`,
      {
        params: {
          strictness: Number.isNaN(strictness) ? 1 : strictness,
          country: "US",
        },
        timeout: 30_000,
      }
    );

    const data = res.data ?? {};
    if (data.success === false) {
      console.warn(
        "[Fraud/IPQS] lookup unsuccessful for %s: %s",
        phoneNumber,
        String(data.message ?? "(no message)")
      );
      negativeCache.set(phoneNumber, Date.now() + NEGATIVE_CACHE_TTL_MS);
      return null;
    }

    const intel: PhoneIntel = {
      phoneNumber,
      fraudScore:
        typeof data.fraud_score === "number" ? data.fraud_score : 0,
      lineType: typeof data.line_type === "string" ? data.line_type : "N/A",
      voip: asBool(data.VOIP),
      risky: asBool(data.risky),
      recentAbuse: asBool(data.recent_abuse),
      spammer: asBool(data.spammer),
      valid: asBool(data.valid),
      carrier: typeof data.carrier === "string" ? data.carrier : "N/A",
      country: typeof data.country === "string" ? data.country : "N/A",
      city: typeof data.city === "string" ? data.city : "N/A",
      region: typeof data.region === "string" ? data.region : "N/A",
      fromCache: false,
    };

    // A cache-write failure must never discard a PAID lookup result — flag
    // evaluation still runs on the returned intel; only caching is lost.
    try {
      savePhoneIntel({
        phoneNumber,
        fraudScore: intel.fraudScore,
        lineType: intel.lineType,
        voip: intel.voip ? 1 : 0,
        risky: intel.risky ? 1 : 0,
        recentAbuse: intel.recentAbuse ? 1 : 0,
        spammer: intel.spammer ? 1 : 0,
        valid: intel.valid ? 1 : 0,
        carrier: intel.carrier,
        country: intel.country,
        city: intel.city,
        region: intel.region,
        raw: JSON.stringify(data),
      });
    } catch (saveErr) {
      console.error(
        "[Fraud/IPQS] cache write FAILED for %s (paid result still used): %s",
        phoneNumber,
        saveErr instanceof Error ? saveErr.message : String(saveErr)
      );
    }

    return intel;
  } catch (err) {
    console.warn(
      "[Fraud/IPQS] lookup failed for %s: %s",
      phoneNumber,
      err instanceof Error ? err.message : String(err)
    );
    // Serve a stale cache entry over nothing.
    return cached ? intelFromCacheRow(cached) : null;
  }
}

/** Marker services Missioner specifically cares about (Google Voice, TextNow, etc). */
const VIRTUAL_CARRIER_MARKERS = [
  "google voice",
  "google",
  "textnow",
  "text now",
  "bandwidth",
  "twilio",
  "onvoy",
  "level 3",
  "pinger",
];

export function isVirtualCarrier(carrier: string): boolean {
  const lower = carrier.trim().toLowerCase();
  if (!lower || lower === "n/a") {
    return false;
  }
  return VIRTUAL_CARRIER_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Decide whether phone intel warrants a VOIP/spoof flag, and how severe.
 * Severity is the IPQS fraud score floored to meaningful minimums per signal.
 */
export function evaluatePhoneIntel(intel: PhoneIntel): {
  flagged: boolean;
  severity: number;
  signals: string[];
} {
  const signals: string[] = [];

  if (intel.voip || intel.lineType.toLowerCase() === "voip") {
    signals.push("VOIP line");
  }
  if (isVirtualCarrier(intel.carrier)) {
    signals.push(`virtual carrier: ${intel.carrier}`);
  }
  if (intel.recentAbuse) {
    signals.push("recent abuse");
  }
  if (intel.spammer) {
    signals.push("reported spammer");
  }
  if (intel.risky) {
    signals.push("risky number");
  }
  if (!intel.valid) {
    signals.push("invalid number");
  }
  if (intel.fraudScore >= 85) {
    signals.push(`IPQS fraud score ${intel.fraudScore}`);
  }

  if (signals.length === 0) {
    return { flagged: false, severity: 0, signals };
  }

  let severity = intel.fraudScore;
  if (intel.voip || isVirtualCarrier(intel.carrier)) {
    severity = Math.max(severity, 60);
  }
  if (intel.recentAbuse || intel.spammer || !intel.valid) {
    severity = Math.max(severity, 75);
  }

  return { flagged: true, severity: Math.min(100, severity), signals };
}
