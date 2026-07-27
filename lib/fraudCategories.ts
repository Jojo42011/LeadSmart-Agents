/**
 * Service-category derivation for the fraud department (System 3).
 *
 * Seth's rule: the same caller hitting multiple publishers WITHIN one service
 * vertical (e.g. two plumbing affiliates) is normal consumer shopping. The
 * fraud signal is the same caller recycled ACROSS verticals — plumbing, HVAC,
 * roofing, pest control, electrician… — which marks a fake lead being resold.
 *
 * Category comes from the Ringba campaign name (campaigns are per-vertical),
 * falling back to the target name. Known verticals map to canonical labels via
 * the keyword rules below; anything unrecognized falls back to its own
 * normalized name, so two distinct unknown campaigns still count as two
 * distinct services. Only a call with no usable name at all returns null, and
 * null is excluded from cross-vertical counting (never guess a fraud signal).
 */

interface CategoryRule {
  category: string;
  pattern: RegExp;
}

/** Order matters — first match wins, so more specific rules sit above broad ones. */
const CATEGORY_RULES: CategoryRule[] = [
  { category: "water damage", pattern: /water[\s-]?damage|restoration|flood|mold/i },
  { category: "auto glass", pattern: /auto[\s-]?glass|windshield/i },
  { category: "garage door", pattern: /garage/i },
  { category: "pest control", pattern: /pest|exterminat|termite|rodent|bed[\s-]?bug/i },
  { category: "plumbing", pattern: /plumb|drain|sewer|water[\s-]?heater/i },
  { category: "hvac", pattern: /hvac|heating|cooling|furnace|air[\s-]?condition|\ba\/?c\b/i },
  { category: "roofing", pattern: /roof/i },
  { category: "electrician", pattern: /electric/i },
  { category: "locksmith", pattern: /locksmith|lock[\s-]?out/i },
  { category: "appliance repair", pattern: /appliance/i },
  { category: "solar", pattern: /solar/i },
  { category: "windows", pattern: /window/i },
  { category: "siding", pattern: /siding/i },
  { category: "tree service", pattern: /tree[\s-]?(service|removal|trim)|\btree\b/i },
  { category: "landscaping", pattern: /landscap|lawn/i },
  { category: "cleaning", pattern: /cleaning|maid|janitorial/i },
  { category: "moving", pattern: /moving|mover/i },
  { category: "pool service", pattern: /\bpool\b/i },
  { category: "fencing", pattern: /fenc(e|ing)/i },
  { category: "flooring", pattern: /floor|carpet/i },
  { category: "handyman", pattern: /handyman/i },
  { category: "medicare", pattern: /medicare|medicaid/i },
  { category: "health insurance", pattern: /health[\s-]?insurance|\baca\b|obamacare/i },
  { category: "life insurance", pattern: /life[\s-]?insurance|final[\s-]?expense/i },
  { category: "auto insurance", pattern: /auto[\s-]?insurance|car[\s-]?insurance/i },
  { category: "legal", pattern: /legal|attorney|lawyer|\blaw\b|tort|injury|\brtt\b/i },
  { category: "tax relief", pattern: /tax[\s-]?(relief|debt|help)|\btax\b/i },
  { category: "debt relief", pattern: /debt|credit[\s-]?repair/i },
  { category: "travel", pattern: /flight|airline|travel|vacation/i },
];

/**
 * Fallback identity for campaigns no rule recognizes: lowercase, letters-only,
 * collapsed whitespace. Distinct unknown campaigns stay distinct categories.
 */
function normalizeCampaignName(name: string): string | null {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/**
 * Derive the service category for a call. Campaign name is the primary signal
 * (Ringba campaigns are per-vertical); target name is the fallback. Returns
 * null only when neither yields anything usable — callers must treat null as
 * "unknown, do not count toward cross-vertical detection."
 */
export function deriveServiceCategory(
  campaignName: string | null | undefined,
  targetName: string | null | undefined
): string | null {
  for (const source of [campaignName, targetName]) {
    if (!source) continue;
    for (const rule of CATEGORY_RULES) {
      if (rule.pattern.test(source)) {
        return rule.category;
      }
    }
  }
  for (const source of [campaignName, targetName]) {
    if (!source) continue;
    const normalized = normalizeCampaignName(source);
    if (normalized) return normalized;
  }
  return null;
}
