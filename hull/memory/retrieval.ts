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

export async function searchFacts(query: string, limit = 8): Promise<RetrievedFact[]> {
  const db = getHullDb();
  const rows = db
    .prepare(
      "SELECT id, content, category, strength, access_count, last_accessed, keywords, embedding FROM facts WHERE superseded_by IS NULL",
    )
    .all() as {
    id: string;
    content: string;
    category: string;
    strength: number;
    access_count: number;
    last_accessed: string | null;
    keywords: string;
    embedding: Buffer | null;
  }[];

  const qVec = await embedText(query);
  const qLower = query.toLowerCase();

  const scored = rows.map((row) => {
    let semantic = 0;
    if (qVec && row.embedding) {
      const vec = blobToFloat32(row.embedding);
      if (vec) semantic = cosineSimilarity(qVec, vec);
    }
    const keyword =
      wordOverlapScore(qLower, row.content.toLowerCase()) +
      wordOverlapScore(qLower, (row.keywords || "").toLowerCase());
    const strength = row.strength ?? 1;
    const recency = 1 / (daysSince(row.last_accessed) + 1);
    const score =
      semantic * 0.5 + Math.min(keyword, 1) * 0.25 + strength * 0.15 + recency * 0.1;
    return { ...row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  const bump = db.prepare(
    "UPDATE facts SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
  );
  const now = new Date().toISOString();
  for (const f of top) bump.run(now, f.id);

  return top.map((f) => ({
    id: f.id,
    content: f.content,
    category: f.category,
    strength: f.strength,
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