import { randomUUID } from "crypto";
import { getHullDb } from "./store.js";
import { upsertNode } from "./nodes.js";

const DIMENSIONS = [
  "DECISIONS",
  "VALUES",
  "FEARS",
  "MOTIVATION",
  "EMOTIONS",
  "RELATIONSHIPS",
  "MONEY",
  "IDENTITY",
  "VISION",
  "CONFLICT",
  "LEARNING",
  "ENERGY",
];

export function bootstrapHullMemory(): void {
  const db = getHullDb();

  const factCount = (db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number }).c;
  if (factCount > 0) {
    console.log("[hull/memory] Already bootstrapped with", factCount, "facts");
    return;
  }

  console.log("[hull/memory] Bootstrapping LeadSmart JARVIS memory...");

  const now = new Date().toISOString();
  const insertFact = db.prepare(
    `INSERT INTO facts (id, content, category, keywords, strength, access_count, last_accessed, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  );

  const semanticFacts = [
    { content: "LeadSmart is an automated Ringba payout scrub agent", category: "system", keywords: "leadsmart,ringba,scrub", strength: 2.0 },
    { content: "System 1 scrubs invalid calls from Ringba to recover affiliate payout and buyer revenue", category: "system", keywords: "system1,scrub,void", strength: 2.0 },
    { content: "Scrub agent polls Ringba every 8 hours by default", category: "system", keywords: "poll,interval,8hours", strength: 1.5 },
    { content: "Dashboard serves at port 3000 with overview, scrubs, and payment views", category: "system", keywords: "dashboard,port,3000", strength: 1.5 },
    { content: "JARVIS is the voice/chat interface for LeadSmart", category: "system", keywords: "jarvis,voice,chat", strength: 1.8 },
    { content: "JARVIS uses Three.js particle orb and Web Speech API for voice interaction", category: "system", keywords: "jarvis,threejs,speech", strength: 1.5 },
    { content: "Payment portal shows affiliate payouts from Ringba and Polyares", category: "system", keywords: "payment,affiliate,payout", strength: 1.5 },
    { content: "Scrub log stored in SQLite database at /data/aethon-memory.db or ./data/aethon-memory.db", category: "system", keywords: "sqlite,database,path", strength: 1.5 },
    { content: "Ringba client handles authentication, call logs, void, job queue, approve, and health check", category: "system", keywords: "ringba,client,auth", strength: 1.8 },
    { content: "Polyares payout data fetched via CSV with cookie-based login", category: "system", keywords: "polyares,csv,login", strength: 1.5 },
    { content: "Scrub agent supports dry-run mode for testing", category: "system", keywords: "dryrun,test,mode", strength: 1.2 },
    { content: "Database import endpoint allows replacing SQLite file via upload", category: "system", keywords: "import,database,upload", strength: 1.2 },
    { content: "Failed scrubs are tracked with error messages and can be debugged via /api/debug/failed-scrubs", category: "system", keywords: "failed,debug,api", strength: 1.2 },
    { content: "JARVIS TTS endpoint generates PCM audio from text", category: "system", keywords: "jarvis,tts,pcm", strength: 1.2 },
    { content: "Deepgram WebSocket proxy for real-time voice streaming", category: "system", keywords: "deepgram,websocket,voice", strength: 1.5 },
  ];

  const relations: [string, string, string, string, string][] = [
    ["LeadSmart", "system", "has_component", "Scrub Agent", "system"],
    ["LeadSmart", "system", "has_component", "Dashboard", "system"],
    ["LeadSmart", "system", "has_component", "JARVIS", "system"],
    ["LeadSmart", "system", "has_component", "Payment Portal", "system"],
    ["Scrub Agent", "system", "uses", "Ringba API", "system"],
    ["Scrub Agent", "system", "uses", "Polyares CSV", "system"],
    ["Scrub Agent", "system", "stores_in", "SQLite Database", "system"],
    ["JARVIS", "system", "uses", "Three.js", "system"],
    ["JARVIS", "system", "uses", "Web Speech API", "system"],
    ["JARVIS", "system", "uses", "Deepgram", "system"],
    ["Dashboard", "system", "serves", "Overview Page", "system"],
    ["Dashboard", "system", "serves", "Scrubs Page", "system"],
    ["Dashboard", "system", "serves", "Payment Page", "system"],
    ["Payment Portal", "system", "fetches_from", "Ringba Insights", "system"],
    ["Payment Portal", "system", "fetches_from", "Polyares", "system"],
  ];

  const procedures = [
    { trigger: "poll interval elapsed or manual run-now triggered", action: "Fetch Ringba jobs, void invalid calls, approve tasks, log results", category: "system" },
    { trigger: "Ringba returns 401", action: "Abort poll, set auth_stopped status, require re-authentication", category: "system" },
    { trigger: "Ringba returns 429", action: "Retry void with exponential backoff up to 3 attempts", category: "system" },
    { trigger: "user opens dashboard", action: "Fetch overview stats and recent scrubs from SQLite", category: "system" },
    { trigger: "user clicks RUN NOW", action: "Trigger immediate poll cycle if not already running", category: "system" },
    { trigger: "user navigates to payment page", action: "Fetch affiliate payout data from Ringba and Polyares for selected month", category: "system" },
    { trigger: "user speaks to JARVIS", action: "Capture speech via Web Speech API, send to agent loop, respond with TTS", category: "system" },
    { trigger: "database import requested", action: "Validate SQLite header, backup existing DB, rename new file", category: "system" },
  ];

  const insertRule = db.prepare(
    `INSERT INTO rules (id, trigger_condition, action, category, confidence, use_count, created_at, last_reinforced)
     VALUES (?, ?, ?, ?, 0.85, 0, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const s of semanticFacts) {
      insertFact.run(randomUUID(), s.content, s.category, s.keywords, s.strength, now, now);
    }
    for (const [aName, aType, rel, bName, bType] of relations) {
      const aId = upsertNode(aName, aType);
      const bId = upsertNode(bName, bType);
      db.prepare(
        `INSERT INTO edges (id, source_id, target_id, relationship, strength, created_at, last_reinforced)
         VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
      ).run(randomUUID(), aId, bId, rel, now, now);
    }
    for (const p of procedures) {
      insertRule.run(randomUUID(), p.trigger, p.action, p.category, now, now);
    }
    for (const dim of DIMENSIONS) {
      db.prepare(
        "INSERT OR IGNORE INTO identity_dimensions (dimension, confidence, updated_at) VALUES (?, 0.0, ?)",
      ).run(dim, now);
    }
  });

  tx();
  console.log("[hull/memory] Bootstrap complete");
}