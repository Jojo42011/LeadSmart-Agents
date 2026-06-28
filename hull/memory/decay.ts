import { getHullDb } from "./store.js";

export function runDailyMemoryDecay(): void {
  const db = getHullDb();
  db.prepare(
    "UPDATE facts SET strength = strength * 0.995 WHERE last_accessed < datetime('now', '-1 day') OR last_accessed IS NULL",
  ).run();
  db.prepare(
    "UPDATE rules SET confidence = confidence * 0.999 WHERE last_reinforced < datetime('now', '-7 days') OR last_reinforced IS NULL",
  ).run();
  console.log("[hull/decay] daily memory decay applied");
}

export function scheduleDailyDecay(): void {
  const MS_DAY = 24 * 60 * 60 * 1000;
  setInterval(() => runDailyMemoryDecay(), MS_DAY);
  console.log("[hull/decay] daily decay scheduled");
}