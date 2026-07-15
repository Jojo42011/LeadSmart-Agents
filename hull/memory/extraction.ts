import { randomUUID } from "crypto";
import { embedText, float32ToBlob } from "./embeddings.js";
import { getHullDb } from "./store.js";
import { upsertNode } from "./nodes.js";
import { broadcastHullEvent } from "../ws.js";
import { getFastModel, getOpenAIClient } from "../openaiConfig.js";

export interface TranscriptTurn {
  role: string;
  text: string;
}

export function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    /* continue */
  }
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch {
      /* continue */
    }
  }
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(text.slice(arrStart, arrEnd + 1));
    } catch {
      /* continue */
    }
  }
  return null;
}

const EXTRACTION_SCHEMA = `Return ONLY valid JSON with keys:
facts (array of {content, category, keywords, importance}) — importance is 1-10 (10 = critical durable business fact, 5 = normal, 1 = trivia),
nodes (array of {name, type}),
edges (array of {source, relationship, target}),
rules_reinforced (array of {trigger, action}),
episode ({summary, tone, decisions, entities}).`;

export async function runPostConversationExtraction(
  sessionId: string,
  transcript: TranscriptTurn[],
): Promise<void> {
  if (transcript.length < 2) return;
  const client = getOpenAIClient();
  if (!client) return;
  const lines = transcript.map((t) => `${t.role}: ${t.text}`).join("\n");

  const prompt = `Extract structured memory from this conversation transcript. ${EXTRACTION_SCHEMA}

Transcript:
${lines.slice(0, 12000)}`;

  try {
    const res = await client.chat.completions.create({
      model: getFastModel(),
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.choices[0]?.message?.content?.trim() || "";
    const parsed = safeJsonParse(text) as Record<string, unknown> | null;
    if (!parsed) {
      console.warn("[hull/extraction] JSON parse failed");
      return;
    }
    await applyExtraction(sessionId, parsed);
    broadcastHullEvent({ type: "memory_updated" });
  } catch (err) {
    console.error("[hull/extraction]", err instanceof Error ? err.message : err);
  }
}

/**
 * Extract memory from arbitrary long-form content (documents, pasted notes,
 * reports) rather than a conversation. Facts are tagged with the source
 * document id so they can be traced and bulk-retracted.
 * Returns the number of facts written, or null when extraction is unavailable.
 */
export async function runContentExtraction(
  sourceDocumentId: string,
  sourceTitle: string,
  content: string,
): Promise<number | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  const prompt = `Extract structured, durable memory from this document for LeadSmart's operations assistant. Capture concrete facts, people, relationships, and operating rules — skip filler. ${EXTRACTION_SCHEMA}

Document title: ${sourceTitle}

Content:
${content.slice(0, 12000)}`;

  const res = await client.chat.completions.create({
    model: getFastModel(),
    max_tokens: 1800,
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.choices[0]?.message?.content?.trim() || "";
  const parsed = safeJsonParse(text) as Record<string, unknown> | null;
  if (!parsed) {
    console.warn("[hull/extraction] document JSON parse failed for %s", sourceDocumentId);
    return 0;
  }
  const written = await applyExtraction(
    `doc-${sourceDocumentId}`,
    parsed,
    sourceDocumentId,
  );
  broadcastHullEvent({ type: "memory_updated" });
  return written;
}

/** SQLite bind values must be scalars — better-sqlite3 expands arrays into extra parameters. */
function sqlText(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function sqlNullableText(value: unknown): string | null {
  if (value == null) return null;
  return sqlText(value);
}

function clampImportance(value: unknown): number {
  const num = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (Number.isNaN(num)) return 5;
  return Math.max(1, Math.min(10, Math.round(num)));
}

async function applyExtraction(
  sessionId: string,
  data: Record<string, unknown>,
  sourceDocumentId: string | null = null,
): Promise<number> {
  const db = getHullDb();
  const now = new Date().toISOString();
  let factsWritten = 0;

  const facts =
    (data.facts as {
      content: unknown;
      category?: unknown;
      keywords?: unknown;
      importance?: unknown;
    }[]) || [];
  for (const f of facts) {
    const content = sqlText(f.content).trim();
    if (!content) continue;
    const id = randomUUID();
    const vec = await embedText(content);
    const category = sqlText(f.category, "general");
    db.prepare(
      `INSERT INTO facts (id, content, category, keywords, strength, importance, source_document, access_count, last_accessed, created_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      id,
      content,
      category,
      sqlText(f.keywords, ""),
      category === "identity" ? 1.5 : 1.0,
      clampImportance(f.importance),
      sourceDocumentId,
      now,
      now,
      vec ? float32ToBlob(vec) : null,
    );
    factsWritten += 1;
  }

  const nodes = (data.nodes as { name: unknown; type?: unknown }[]) || [];
  const nodeIdMap: Record<string, string> = {};
  for (const n of nodes) {
    const name = sqlText(n.name).trim();
    if (!name) continue;
    const id = upsertNode(name, sqlText(n.type, "unknown"));
    nodeIdMap[name.toLowerCase()] = id;
  }

  const edges =
    (data.edges as { source: unknown; relationship: unknown; target: unknown }[]) || [];
  for (const e of edges) {
    const source = sqlText(e.source).trim();
    const target = sqlText(e.target).trim();
    const relationship = sqlText(e.relationship).trim();
    if (!source || !target || !relationship) continue;
    const srcId = nodeIdMap[source.toLowerCase()] || upsertNode(source);
    const tgtId = nodeIdMap[target.toLowerCase()] || upsertNode(target);
    db.prepare(
      `INSERT INTO edges (id, source_id, target_id, relationship, strength, created_at, last_reinforced)
       VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
    ).run(randomUUID(), srcId, tgtId, relationship, now, now);
  }

  const rules =
    (data.rules_reinforced as { trigger: unknown; action: unknown }[]) || [];
  for (const r of rules) {
    const trigger = sqlText(r.trigger).trim();
    const action = sqlText(r.action).trim();
    if (!trigger || !action) continue;
    const existing = db
      .prepare("SELECT id, confidence FROM rules WHERE trigger_condition = ? AND action = ?")
      .get(trigger, action) as { id: string; confidence: number } | undefined;
    if (existing) {
      db.prepare(
        "UPDATE rules SET confidence = MIN(1.0, confidence + 0.1), last_reinforced = ?, use_count = use_count + 1 WHERE id = ?",
      ).run(now, existing.id);
    } else {
      db.prepare(
        `INSERT INTO rules (id, trigger_condition, action, category, confidence, use_count, created_at, last_reinforced)
         VALUES (?, ?, ?, 'learned', 0.7, 1, ?, ?)`,
      ).run(randomUUID(), trigger, action, now, now);
    }
  }

  const ep = data.episode as {
    summary?: unknown;
    tone?: unknown;
    decisions?: unknown;
    entities?: unknown;
  } | undefined;
  const summary = sqlText(ep?.summary).trim();
  if (summary) {
    db.prepare(
      `INSERT INTO episodes (id, session_id, summary, tone, decisions, entities, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      sessionId,
      summary,
      sqlNullableText(ep?.tone),
      sqlNullableText(ep?.decisions),
      sqlNullableText(ep?.entities),
      now,
    );
  }

  return factsWritten;
}