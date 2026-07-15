import { embedText, blobToFloat32, cosineSimilarity } from "./embeddings.js";
import { getHullDb } from "./store.js";

export interface RetrievedFact {
  id: string;
  content: string;
  category: string;
  strength: number;
  score: number;
}

function daysSince(iso: string | null): number {
  if (!iso) return 999;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 999;
  return (Date.now() - t) / (86400 * 1000);
}

interface FactRow {
  id: string;
  content: string;
  category: string;
  strength: number;
  importance: number | null;
  access_count: number;
  last_accessed: string | null;
  keywords: string;
  embedding: Buffer | null;
}

/** Keyword recall is trusted (embedding skipped) above this top-score. */
const KEYWORD_CONFIDENT_SCORE = 0.32;
const KEYWORD_CONFIDENT_HITS = 4;

/**
 * Latency-aware hybrid retrieval: score by keywords first (pure in-memory,
 * free), and only pay the embedding round-trip when keyword recall looks thin.
 * Retrieved facts are reinforced — recall strengthens memory.
 */
export async function searchFacts(query: string, limit = 8): Promise<RetrievedFact[]> {
  const db = getHullDb();
  const rows = db
    .prepare(
      "SELECT id, content, category, strength, importance, access_count, last_accessed, keywords, embedding FROM facts WHERE superseded_by IS NULL",
    )
    .all() as FactRow[];

  const qLower = query.toLowerCase();

  const keywordScored = rows.map((row) => {
    const keyword = Math.min(
      wordOverlapScore(qLower, row.content.toLowerCase()) +
        wordOverlapScore(qLower, (row.keywords || "").toLowerCase()),
      1,
    );
    const strength = row.strength ?? 1;
    const recency = 1 / (daysSince(row.last_accessed) + 1);
    const importance = (row.importance ?? 5) / 10;
    const score =
      keyword * 0.5 + strength * 0.15 + recency * 0.1 + importance * 0.25;
    return { row, keyword, score };
  });

  keywordScored.sort((a, b) => b.score - a.score);
  const strongHits = keywordScored.filter((s) => s.keyword > 0).length;
  const keywordConfident =
    query.length < 12 ||
    (strongHits >= KEYWORD_CONFIDENT_HITS &&
      (keywordScored[0]?.keyword ?? 0) >= KEYWORD_CONFIDENT_SCORE);

  let top: Array<{ row: FactRow; score: number }>;

  if (keywordConfident) {
    top = keywordScored.slice(0, limit).map((s) => ({ row: s.row, score: s.score }));
  } else {
    const qVec = await embedText(query);
    const scored = keywordScored.map(({ row, keyword }) => {
      let semantic = 0;
      if (qVec && row.embedding) {
        const vec = blobToFloat32(row.embedding);
        if (vec) semantic = cosineSimilarity(qVec, vec);
      }
      const strength = row.strength ?? 1;
      const recency = 1 / (daysSince(row.last_accessed) + 1);
      const importance = (row.importance ?? 5) / 10;
      const score =
        semantic * 0.45 +
        keyword * 0.2 +
        strength * 0.1 +
        recency * 0.05 +
        importance * 0.2;
      return { row, score };
    });
    scored.sort((a, b) => b.score - a.score);
    top = scored.slice(0, limit);
  }

  // Reinforce on recall: recency + access count + a small strength bump (cap 1.5).
  const bump = db.prepare(
    "UPDATE facts SET access_count = access_count + 1, last_accessed = ?, strength = MIN(1.5, strength + 0.02) WHERE id = ?",
  );
  const now = new Date().toISOString();
  for (const f of top) bump.run(now, f.row.id);

  return top.map((f) => ({
    id: f.row.id,
    content: f.row.content,
    category: f.row.category,
    strength: f.row.strength,
    score: f.score,
  }));
}

function wordOverlapScore(a: string, b: string): number {
  const wa = new Set(a.split(/\s+/).filter((w) => w.length > 2));
  const wb = new Set(b.split(/\s+/).filter((w) => w.length > 2));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}

export function getMemoryPacket(query: string, facts: RetrievedFact[]): string {
  const db = getHullDb();
  const parts: string[] = [];
  let charCount = 0;
  const cap = 2500;

  const add = (line: string) => {
    if (charCount + line.length + 1 > cap) return false;
    parts.push(line);
    charCount += line.length + 1;
    return true;
  };

  if (facts.length) {
    add("FACTS:");
    for (const f of facts) {
      if (!add(`- ${f.content}`)) break;
    }
  }

  const rules = db
    .prepare("SELECT trigger_condition, action, confidence FROM rules ORDER BY confidence DESC LIMIT 5")
    .all() as { trigger_condition: string; action: string; confidence: number }[];
  if (rules.length) {
    add("RULES:");
    for (const r of rules) {
      if (!add(`- IF ${r.trigger_condition} THEN ${r.action} (${Math.round(r.confidence * 100)}%)`)) break;
    }
  }

  const episodes = db
    .prepare("SELECT summary, tone FROM episodes ORDER BY timestamp DESC LIMIT 3")
    .all() as { summary: string; tone: string | null }[];
  if (episodes.length) {
    add("RECENT EPISODES:");
    for (const e of episodes) {
      const line = e.tone ? `${e.summary} [${e.tone}]` : e.summary;
      if (!add(`- ${line}`)) break;
    }
  }

  const synth = db
    .prepare("SELECT content FROM syntheses ORDER BY created_at DESC LIMIT 1")
    .get() as { content: string } | undefined;
  if (synth?.content) add(`SYNTHESIS: ${synth.content}`);

  const identity = db
    .prepare("SELECT dimension, confidence FROM identity_dimensions ORDER BY dimension")
    .all() as { dimension: string; confidence: number }[];
  if (identity.length) {
    add("IDENTITY PROFILE:");
    for (const d of identity) {
      if (!add(`- ${d.dimension}: ${Math.round(d.confidence * 100)}%`)) break;
    }
  }

  const entities = extractEntityHints(query);
  if (entities.length) {
    for (const ent of entities.slice(0, 3)) {
      const node = db
        .prepare("SELECT id, name FROM nodes WHERE LOWER(name) LIKE ? LIMIT 1")
        .get(`%${ent.toLowerCase()}%`) as { id: string; name: string } | undefined;
      if (!node) continue;
      const edges = db
        .prepare(
          `SELECT e.relationship, n.name as target_name
           FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?
           UNION
           SELECT e.relationship, n.name as target_name
           FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`,
        )
        .all(node.id, node.id) as { relationship: string; target_name: string }[];
      if (edges.length) {
        add(`GRAPH (${node.name}):`);
        for (const edge of edges.slice(0, 5)) {
          if (!add(`- ${node.name} ${edge.relationship} ${edge.target_name}`)) break;
        }
      }
    }
  }

  return parts.join("\n");
}

function extractEntityHints(query: string): string[] {
  const words = query.split(/\s+/).filter((w) => w.length > 3);
  return words.slice(0, 5);
}

export async function getRetrievalConfidence(query: string): Promise<{ confidence: number; count: number }> {
  const facts = await searchFacts(query, 8);
  const topScore = facts[0]?.score ?? 0;
  return { confidence: topScore, count: facts.length };
}