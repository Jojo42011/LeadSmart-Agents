import { randomUUID } from "crypto";
import { getHullDb } from "./store";
import { embedText, float32ToBlob } from "./embeddings";
import { broadcastHullEvent } from "../ws";
import { getFastModel, getOpenAIClient } from "../openaiConfig";

/**
 * Reflection engine (generative-agents pattern): every ~12h Jarvis re-reads
 * recent raw memory and writes back a few higher-level insights as facts with
 * category 'reflection' and above-baseline strength, so synthesized knowledge
 * competes in retrieval rather than sitting in a report nobody reads.
 * Prior reflections are excluded from the input so it never loops on itself.
 */

const REFLECTION_INTERVAL_MS = 12 * 60 * 60 * 1000;
const REFLECTION_STRENGTH = 1.2;

export async function runReflection(): Promise<number> {
  const client = getOpenAIClient();
  if (!client) return 0;

  const db = getHullDb();
  const facts = db
    .prepare(
      `SELECT content, category, importance FROM facts
       WHERE superseded_by IS NULL AND category != 'reflection'
       ORDER BY created_at DESC LIMIT 40`,
    )
    .all() as Array<{ content: string; category: string; importance: number | null }>;
  const episodes = db
    .prepare("SELECT summary, tone FROM episodes ORDER BY timestamp DESC LIMIT 10")
    .all() as Array<{ summary: string; tone: string | null }>;

  if (facts.length < 5) return 0;

  const prompt = `You are the reflection process of JARVIS, LeadSmart's operations AI. Read the recent memory below and produce 2-4 HIGHER-LEVEL insights — patterns, risks, or operating principles that are not stated verbatim in any single fact. Return ONLY a JSON array of {content, keywords, importance} where importance is 1-10.

RECENT FACTS:
${facts.map((f) => `- [${f.category}] ${f.content}`).join("\n").slice(0, 6000)}

RECENT EPISODES:
${episodes.map((e) => `- ${e.summary}${e.tone ? ` [${e.tone}]` : ""}`).join("\n").slice(0, 2000)}`;

  try {
    const res = await client.chat.completions.create({
      model: getFastModel(),
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.choices[0]?.message?.content?.trim() || "";
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end <= start) return 0;

    const insights = JSON.parse(text.slice(start, end + 1)) as Array<{
      content?: unknown;
      keywords?: unknown;
      importance?: unknown;
    }>;

    const now = new Date().toISOString();
    let written = 0;
    for (const insight of insights.slice(0, 5)) {
      const content = String(insight.content ?? "").trim();
      if (!content) continue;
      const importance = Math.max(
        1,
        Math.min(10, parseInt(String(insight.importance ?? 6), 10) || 6),
      );
      const vec = await embedText(content);
      db.prepare(
        `INSERT INTO facts (id, content, category, keywords, strength, importance, access_count, last_accessed, created_at, embedding)
         VALUES (?, ?, 'reflection', ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        randomUUID(),
        content,
        String(insight.keywords ?? ""),
        REFLECTION_STRENGTH,
        importance,
        now,
        now,
        vec ? float32ToBlob(vec) : null,
      );
      written += 1;
    }

    if (written > 0) {
      broadcastHullEvent({ type: "memory_updated" });
      console.log("[hull/reflection] wrote %d insights", written);
    }
    return written;
  } catch (err) {
    console.error(
      "[hull/reflection]",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

export function scheduleReflection(): void {
  setInterval(() => {
    void runReflection();
  }, REFLECTION_INTERVAL_MS);
  console.log("[hull/reflection] scheduled every 12h");
}
