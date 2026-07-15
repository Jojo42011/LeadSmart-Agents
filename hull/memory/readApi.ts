import { getHullDb } from "./store";

export interface MemoryOverview {
  factCount: number;
  episodeCount: number;
  nodeCount: number;
  edgeCount: number;
  ruleCount: number;
  synthesisCount: number;
}

export function getMemoryOverview(): MemoryOverview {
  const db = getHullDb();
  const count = (sql: string) =>
    (db.prepare(sql).get() as { c: number }).c;

  return {
    factCount: count("SELECT COUNT(*) as c FROM facts WHERE superseded_by IS NULL"),
    episodeCount: count("SELECT COUNT(*) as c FROM episodes"),
    nodeCount: count("SELECT COUNT(*) as c FROM nodes"),
    edgeCount: count("SELECT COUNT(*) as c FROM edges"),
    ruleCount: count("SELECT COUNT(*) as c FROM rules"),
    synthesisCount: count("SELECT COUNT(*) as c FROM syntheses"),
  };
}

export function listFacts(limit = 100, query?: string) {
  const db = getHullDb();
  const capped = Math.min(Math.max(limit, 1), 500);
  if (query?.trim()) {
    const q = `%${query.trim().toLowerCase()}%`;
    return db
      .prepare(
        `SELECT id, content, category, keywords, strength, access_count, last_accessed, created_at
         FROM facts
         WHERE superseded_by IS NULL
           AND (LOWER(content) LIKE ? OR LOWER(keywords) LIKE ? OR LOWER(category) LIKE ?)
         ORDER BY strength DESC, access_count DESC
         LIMIT ?`
      )
      .all(q, q, q, capped);
  }
  return db
    .prepare(
      `SELECT id, content, category, keywords, strength, access_count, last_accessed, created_at
       FROM facts
       WHERE superseded_by IS NULL
       ORDER BY strength DESC, access_count DESC
       LIMIT ?`
    )
    .all(capped);
}

export function listEpisodes(limit = 50) {
  const db = getHullDb();
  return db
    .prepare(
      `SELECT id, session_id, summary, tone, decisions, entities, timestamp
       FROM episodes
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 200));
}

export function listRules(limit = 100) {
  const db = getHullDb();
  return db
    .prepare(
      `SELECT id, trigger_condition, action, category, confidence, use_count, created_at, last_reinforced
       FROM rules
       ORDER BY confidence DESC, use_count DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 200));
}

export function getMemoryIdentity() {
  const db = getHullDb();
  const profile = db
    .prepare(
      "SELECT dimension, confidence FROM identity_dimensions ORDER BY dimension"
    )
    .all();
  const recentQuestions = db
    .prepare(
      `SELECT dimension, question, asked_at, answered
       FROM identity_questions
       ORDER BY asked_at DESC
       LIMIT 10`
    )
    .all();
  return { profile, recentQuestions };
}

export function listSyntheses(limit = 20) {
  const db = getHullDb();
  return db
    .prepare(
      `SELECT id, content, week_start, created_at
       FROM syntheses
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), 50));
}

/**
 * The complete knowledge graph for the neural map: every node with its degree
 * plus every edge. Capped by degree so a huge graph still renders.
 */
export function getFullGraph(maxNodes = 1500) {
  const db = getHullDb();

  const nodes = db
    .prepare(
      `SELECT n.id, n.name, n.type,
              (SELECT COUNT(*) FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id) AS degree
       FROM nodes n
       ORDER BY degree DESC
       LIMIT ?`
    )
    .all(Math.min(Math.max(maxNodes, 10), 5000)) as Array<{
    id: string;
    name: string;
    type: string;
    degree: number;
  }>;

  const kept = new Set(nodes.map((n) => n.id));
  const edges = (
    db
      .prepare(
        `SELECT source_id AS source, target_id AS target, relationship, strength FROM edges`
      )
      .all() as Array<{
      source: string;
      target: string;
      relationship: string;
      strength: number;
    }>
  ).filter((e) => kept.has(e.source) && kept.has(e.target));

  const factCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM facts WHERE superseded_by IS NULL"
      )
      .get() as { c: number }
  ).c;

  return { nodes, edges, factCount };
}

export function getGraphForEntity(entity: string) {
  const db = getHullDb();
  const node = db
    .prepare("SELECT id, name, type FROM nodes WHERE LOWER(name) LIKE ? LIMIT 1")
    .get(`%${entity.trim().toLowerCase()}%`) as
    | { id: string; name: string; type: string }
    | undefined;

  if (!node) {
    return { entity, node: null, connections: [] };
  }

  const connections = db
    .prepare(
      `SELECT e.relationship, n.name, n.type, e.strength
       FROM edges e JOIN nodes n ON e.target_id = n.id WHERE e.source_id = ?
       UNION ALL
       SELECT e.relationship, n.name, n.type, e.strength
       FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ?`
    )
    .all(node.id, node.id);

  return { entity: node.name, node, connections };
}
