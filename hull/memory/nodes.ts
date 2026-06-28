import { randomUUID } from "crypto";
import { getHullDb } from "./store.js";

function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}

export function findSimilarNode(name: string): { id: string; name: string } | null {
  const db = getHullDb();
  const trimmed = name.trim();
  if (!trimmed) return null;

  const exact = db
    .prepare("SELECT id, name FROM nodes WHERE LOWER(name) = LOWER(?)")
    .get(trimmed) as { id: string; name: string } | undefined;
  if (exact) return exact;

  const all = db.prepare("SELECT id, name FROM nodes").all() as { id: string; name: string }[];
  for (const n of all) {
    const lowerA = trimmed.toLowerCase();
    const lowerB = n.name.toLowerCase();
    if (lowerA.includes(lowerB) || lowerB.includes(lowerA)) return n;
    if (wordOverlap(trimmed, n.name) >= 0.6) return n;
  }
  return null;
}

export function upsertNode(
  name: string,
  type = "unknown",
  properties: Record<string, unknown> = {},
): string {
  const existing = findSimilarNode(name);
  if (existing) return existing.id;

  const id = randomUUID();
  const now = new Date().toISOString();
  getHullDb()
    .prepare("INSERT INTO nodes (id, name, type, properties, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name.trim(), type, JSON.stringify(properties), now);
  return id;
}