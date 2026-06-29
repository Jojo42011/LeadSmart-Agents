import { randomUUID } from "crypto";
import { getHullDb } from "./store.js";
import { broadcastHullEvent } from "../ws.js";
import { getFastModel, getOpenAIClient } from "../openaiConfig.js";

function msUntilNextSunday3am(): number {
  const now = new Date();
  const target = new Date(now);
  const day = now.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  target.setDate(now.getDate() + daysUntilSunday);
  target.setHours(3, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 7);
  return target.getTime() - now.getTime();
}

export async function runWeeklySynthesis(): Promise<void> {
  const client = getOpenAIClient();
  if (!client) return;

  const db = getHullDb();
  const episodes = db
    .prepare("SELECT summary, tone FROM episodes WHERE timestamp >= datetime('now', '-7 days')")
    .all() as { summary: string; tone: string | null }[];
  const facts = db
    .prepare(
      "SELECT content, strength FROM facts WHERE superseded_by IS NULL ORDER BY access_count DESC LIMIT 20",
    )
    .all() as { content: string; strength: number }[];
  const rules = db
    .prepare("SELECT trigger_condition, action, confidence FROM rules WHERE confidence >= 0.6")
    .all() as { trigger_condition: string; action: string; confidence: number }[];

  const prompt = `Write a weekly pattern synthesis for LeadSmart operations (Ringba scrub agent, affiliate payouts, payment portal). Episodes: ${JSON.stringify(episodes).slice(0, 4000)}. Top facts: ${JSON.stringify(facts).slice(0, 3000)}. Rules: ${JSON.stringify(rules).slice(0, 2000)}. 3-5 paragraphs: patterns, risks, recommendations.`;

  try {
    const res = await client.chat.completions.create({
      model: getFastModel(),
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.choices[0]?.message?.content?.trim() || "";
    if (!text) return;

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO syntheses (id, content, week_start, created_at) VALUES (?, ?, datetime('now', '-7 days'), ?)",
    ).run(randomUUID(), text, now);
    broadcastHullEvent({ type: "memory_updated" });
    console.log("[hull/synthesis] weekly synthesis stored");
  } catch (err) {
    console.error("[hull/synthesis]", err instanceof Error ? err.message : err);
  }
}

export function scheduleWeeklySynthesis(): void {
  const schedule = () => {
    const delay = msUntilNextSunday3am();
    setTimeout(async () => {
      await runWeeklySynthesis();
      schedule();
    }, delay);
  };
  schedule();
  console.log("[hull/synthesis] weekly synthesis scheduled");
}