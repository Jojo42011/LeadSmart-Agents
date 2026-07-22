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

/**
 * Digital-twin seed (v2) — the business knowledge Jarvis should hold as
 * durable memory, not just prompt text. Idempotent via a system_state marker,
 * runs on top of any existing memory.
 */
function seedDigitalTwinV2(db: ReturnType<typeof getHullDb>): void {
  const marker = db
    .prepare("SELECT value FROM system_state WHERE key = 'seed_v2'")
    .get() as { value: string } | undefined;
  if (marker) return;

  const now = new Date().toISOString();
  const insertFact = db.prepare(
    `INSERT INTO facts (id, content, category, keywords, strength, importance, access_count, last_accessed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );

  const facts: Array<{ content: string; category: string; keywords: string; importance: number }> = [
    { content: "Seth is LeadSmart's client/owner and sets payment and fraud policy", category: "people", keywords: "seth,owner,client,policy", importance: 9 },
    { content: "Mijanur Rahman (Missioner) runs affiliate payments and fraud investigation day to day", category: "people", keywords: "mijanur,missioner,payments,fraud,operator", importance: 9 },
    { content: "Jahan builds and operates the LeadSmart platform", category: "people", keywords: "jahan,builder,admin,platform", importance: 8 },
    { content: "Weekly affiliates are paid Monday–Sunday weeks after the week closes (net-7)", category: "payments", keywords: "weekly,net7,monday,sunday,payout", importance: 9 },
    { content: "CPL affiliates have calls to 33 Miles RTT or Inquirly targets in the last 7 days of a month; Ringba finalizes those amounts late", category: "payments", keywords: "cpl,33 miles,inquirly,last week", importance: 9 },
    { content: "$0 CPL affiliates are held until the second Monday of the following month (Central Time), then payable", category: "payments", keywords: "cpl,hold,second monday,zero", importance: 9 },
    { content: "Wise payouts route by stored numeric recipient ID assigned via the LINK WISE tool; Bill.com routes by 009 vendor ID", category: "payments", keywords: "wise,recipient id,billcom,vendor id,link wise", importance: 9 },
    { content: "Bill.com payments can require an MFA code from Seth's phone", category: "payments", keywords: "billcom,mfa,seth,phone", importance: 7 },
    { content: "The All Unpaid view compiles unpaid earnings across past months, excludes the current month, with a $20 minimum", category: "payments", keywords: "unpaid,all months,20 minimum", importance: 8 },
    { content: "Fraud detection scans converted calls every 15 minutes: IPQS VOIP checks, cross-publisher caller-ID reuse, AI transcript analysis", category: "fraud", keywords: "fraud,ipqs,voip,shared caller,ai analysis,15 minutes", importance: 9 },
    { content: "Publisher blocking is always manual from the fraud dashboard — it pauses the affiliate in Ringba; nothing blocks automatically", category: "fraud", keywords: "block,manual,ringba,pause,publisher", importance: 9 },
    { content: "Publisher fraud risk score is 60% flag rate plus 40% worst severity", category: "fraud", keywords: "risk score,formula,flag rate,severity", importance: 7 },
    { content: "All money-facing dates and cutoffs use America/Chicago time", category: "system", keywords: "chicago,timezone,central", importance: 8 },
  ];

  const relations: Array<[string, string, string, string, string]> = [
    ["Seth", "person", "owns", "LeadSmart", "system"],
    ["Mijanur Rahman", "person", "operates", "Payment Portal", "system"],
    ["Mijanur Rahman", "person", "operates", "Fraud Station", "system"],
    ["Jahan", "person", "builds", "LeadSmart", "system"],
    ["LeadSmart", "system", "has_component", "Fraud Station", "system"],
    ["Fraud Station", "system", "uses", "IPQS", "system"],
    ["Payment Portal", "system", "pays_via", "Wise", "system"],
    ["Payment Portal", "system", "pays_via", "Bill.com", "system"],
  ];

  const tx = db.transaction(() => {
    for (const f of facts) {
      insertFact.run(randomUUID(), f.content, f.category, f.keywords, 1.3, f.importance, now, now);
    }
    for (const [aName, aType, rel, bName, bType] of relations) {
      const aId = upsertNode(aName, aType);
      const bId = upsertNode(bName, bType);
      db.prepare(
        `INSERT INTO edges (id, source_id, target_id, relationship, strength, created_at, last_reinforced)
         VALUES (?, ?, ?, ?, 1.0, ?, ?)`,
      ).run(randomUUID(), aId, bId, rel, now, now);
    }
    db.prepare(
      "INSERT INTO system_state (key, value) VALUES ('seed_v2', ?)",
    ).run(now);
  });
  tx();
  console.log("[hull/memory] Digital-twin seed v2 applied (%d facts)", facts.length);
}

/**
 * Fraud risk-scoring knowledge (v3) — how the risk score is computed, what the
 * bands mean, and what each detector looks for, so Jarvis can explain a
 * publisher's score when Seth asks. Idempotent via a system_state marker.
 */
function seedFraudScoringV3(db: ReturnType<typeof getHullDb>): void {
  const marker = db
    .prepare("SELECT value FROM system_state WHERE key = 'seed_v3'")
    .get() as { value: string } | undefined;
  if (marker) return;

  const now = new Date().toISOString();
  const insertFact = db.prepare(
    `INSERT INTO facts (id, content, category, keywords, strength, importance, access_count, last_accessed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );

  const facts: Array<{ content: string; keywords: string; importance: number }> = [
    { content: "A publisher's fraud risk score (0-100) is 60% their flag rate (flagged calls divided by total scanned calls) plus 40% the worst severity of any single flag on their calls", keywords: "risk score,formula,flag rate,severity,explain,how computed", importance: 9 },
    { content: "Fraud risk score bands: 0-40 is clean, 40-70 is watch, 70-85 is suspicious, 85 and above is high risk — the Fraud Station legend and colors follow these bands", keywords: "risk score,bands,ranges,clean,watch,suspicious,high risk,legend", importance: 9 },
    { content: "Fraud flags come from three detectors: VOIP or virtual-carrier caller numbers via IPQS phone intel, the same caller ID appearing under multiple publishers, and AI analysis of call recordings for fake or scripted callers", keywords: "detectors,voip,ipqs,shared caller,ai analysis,three checks", importance: 8 },
    { content: "Shared-caller flag severity is 50 plus 15 per publisher sharing the number, capped at 100; AI analysis flags calls scoring 70 or higher, and identical transcripts across multiple calls floor the AI score at 85", keywords: "severity,shared caller,ai threshold,duplicate script,scripted", importance: 8 },
    { content: "The fraud scan covers connected calls with recordings (duration over 0 seconds), not just converted calls; blocking a publisher is always a manual action from the Fraud Station", keywords: "scan scope,connected calls,recordings,duration,manual block", importance: 8 },
  ];

  const tx = db.transaction(() => {
    for (const f of facts) {
      insertFact.run(randomUUID(), f.content, "fraud", f.keywords, 1.3, f.importance, now, now);
    }
    db.prepare(
      "INSERT INTO system_state (key, value) VALUES ('seed_v3', ?)",
    ).run(now);
  });
  tx();
  console.log("[hull/memory] Fraud risk-scoring seed v3 applied (%d facts)", facts.length);
}

export function bootstrapHullMemory(): void {
  const db = getHullDb();

  const factCount = (db.prepare("SELECT COUNT(*) as c FROM facts").get() as { c: number }).c;
  if (factCount > 0) {
    console.log("[hull/memory] Already bootstrapped with", factCount, "facts");
    seedDigitalTwinV2(db);
    seedFraudScoringV3(db);
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
  seedDigitalTwinV2(db);
  seedFraudScoringV3(db);
  console.log("[hull/memory] Bootstrap complete");
}