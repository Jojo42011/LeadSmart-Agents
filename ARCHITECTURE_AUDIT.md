# LeadSmart — Full System Architecture Audit

_Read-only audit. No system behavior was changed to produce this document._
_Scope: the entire `LeadSmart-Agents` monolith — scrub, payments, fraud, CPL updater, and the Jarvis "hull" (brain + memory + voice), plus deployment, data, LLMs, external services, routes, schedulers, and a consolidated risk register._

---

## 1. Executive Summary

LeadSmart is a **single Node.js/TypeScript + Express monolith** deployed on **Fly.io** (`leadsmart-ringba-scrub`, region `iad`, one always-on `512MB`/shared-CPU machine, one persistent volume `scrub_data` → `/app/data`). One process (`start.ts`) runs the HTTP dashboard, the scrub poll loop, the fraud scheduler, and three memory schedulers together.

It is really **five subsystems** sharing one process and one disk, each with its **own isolated SQLite database**:

| # | Subsystem | What it does | DB file | Moves money? | LLM? |
|---|-----------|--------------|---------|--------------|------|
| 1 | **Scrub agent** | Auto-voids Ringba conversions/payouts from buyer dispute jobs | `scrub_log.db` | ✅ voids (reduces payout/revenue) | No |
| 2 | **Payments** | Reconciles Ringba + Polyares earnings, pays affiliates via Wise / Bill.com | `scrub_log.db` (shared) | ✅ sends ACH/Wise payouts | No |
| 3 | **Fraud (System 3)** | Flags VOIP/spoof/shared-caller/fake-script fraud on converted calls | `fraud.db` | ⚠️ advisory; manual Ringba block only | Yes (Whisper + gpt-4o-mini) |
| 4 | **CPL Updater** | Reconciles 33 Miles / Inquirly weekly CSV to Ringba, sets revenue/payout | `cpl.db` | ✅ Ringba revenue/payout overrides | No |
| 5 | **Jarvis ("hull")** | Digital-twin AI: chat, voice, neural-map memory, read-only ops access | `aethon-memory.db` | ❌ read-only into money systems | Yes (gpt-4o / gpt-4o-mini / embeddings) |

**The single most important finding:** there is **no server-side authentication on any money-moving endpoint.** Payouts, Ringba overrides, publisher blocks, and live-void triggers are all reachable by anyone who can hit the URL; the only protection is a **client-side hardcoded password** (`leadsmart2026`) in the HTML pages, plus `CORS: *`. Calling the JSON API directly bypasses it entirely. This is the top priority to fix.

---

## 2. Deployment & Runtime Architecture

- **Runtime:** TypeScript → CommonJS, **Node 20** (`node:20-bookworm-slim`). `tsconfig` target ES2020, `strict: true`, build `tsc` → `dist/`.
- **Entry point:** `start.ts` → loads dotenv, `initHull()` (memory bootstrap + schedulers), `warnMissingPaymentEnvVars()`, then imports `./server` (dashboard) and `./index` (scrub loop). **All concerns run in one process.**
- **HTTP + WS:** one `express()` app wrapped in `http.createServer` (`server.ts:3128`) so WebSocket upgrades share the port.
- **Fly.io (`fly.toml`):** app `leadsmart-ringba-scrub`, `iad`, VM `512mb` / shared / 1 cpu. `internal_port 8080`, `force_https=true`, `auto_stop_machines='off'`, `auto_start_machines=true`, `min_machines_running=1`. Volume `scrub_data` → `/app/data`. Env: `NODE_ENV=production`, `DATA_DIR=/app/data`, **`DRY_RUN=false`**, `POLL_INTERVAL_MS=28800000` (8h), `CALL_DELAY_MS=500`, `PORT=8080`.
- **Docker:** `npm ci` → copy → `npm run build && npm prune --omit=dev` → `CMD ["node","dist/start.js"]`.
- **Local dev:** `npm run dashboard` (ts-node + dotenv) or `npm start`; PORT defaults 3000.
- **Crash behavior:** `index.ts` installs **empty** `uncaughtException`/`unhandledRejection` handlers to keep the process alive (can mask failures). Scrub health-check failure at boot calls `process.exit(1)` → kills the whole server; Fly restarts it.

---

## 3. Data Layer

**Engine:** `better-sqlite3` v11 (synchronous), WAL mode. **Four separate DB files**, deliberately isolated per subsystem:

| DB file | Path resolver | Owner | Notes |
|---|---|---|---|
| `scrub_log.db` | `getDataDir()/scrub_log.db` (`lib/paths.ts:42`) | Scrub **+ Payments** | Highest-value data; wholesale-replaced by `/api/import-db` |
| `fraud.db` | `getDataDir()/fraud.db` (`lib/fraudDb.ts:14`) | Fraud | "Never touches scrub_log.db" |
| `cpl.db` | `getDataDir()/cpl.db` (`lib/cplDb.ts:16`) | CPL updater | Batch audit trail |
| `aethon-memory.db` | **`/data/...` if exists else `<cwd>/data/...`** (`hull/memory/store.ts:5`) | Jarvis memory | ⚠️ different resolver — ignores `DATA_DIR`/`/app/data` |

- **`getDataDir()`** (`lib/paths.ts:31`): `DATA_DIR` env → else `/app/data` if `NODE_ENV=production` → else `<appRoot>/data`.
- **⚠️ Path divergence:** the memory DB does **not** use `getDataDir()` — it checks `/data` existence and falls back to `process.cwd()/data`. Inconsistent and brittle; a bootstrap fact (`hull/memory/bootstrap.ts:110`) even hardcodes a stale/incorrect DB-path string.
- **Import/export:** only `scrub_log.db` has a sync mechanism — `POST /api/import-db` (raw SQLite, Bearer `DB_IMPORT_SECRET`, validates magic bytes + `scrub_log` table, backs up to `scrub_log.backup.db`, atomic rename). Helper `scripts/push-db-to-fly.ps1`. **Fraud/CPL/memory DBs have no export path — volume loss = total loss for those.**

---

## 4. System 1 — Scrub Agent (Ringba payout void)

**Files:** `agents/scrubAgent.ts`, `lib/ringbaClient.ts`, `lib/pollScheduler.ts`, `lib/logger.ts`, `index.ts`, `start.ts`. **No LLM.**

**Purpose:** When a buyer disputes a converted call, Ringba creates a `CallVoid_Conversion` job in its job queue. The agent polls that queue and, for each open job: **voids** the call's conversion/payout (`POST /{acct}/calls/void`) then **approves** the adjustment task to zero (`POST /{acct}/jobQueue/{jobId}/action`). Net effect: claws back publisher payout + recorded revenue. The **job queue is the sole trigger** — the agent does no independent evaluation of the call.

**Data flow:**
1. `GET /{acct}/jobQueue?status=open` → keep `type === "CallVoid_Conversion"`; **`inboundCallId` is derived by stripping the `JQI_` prefix from the job id** (`ringbaClient.ts:462`); amounts read from `publicState` keys (`"call Conversion"`, `"call Payout"`, `"publisher Name"`).
2. Per job: dedup (skip if a `scrub_log` `status='success'` row exists), skip if both amounts ≤ 0.
3. **`DRY_RUN` (default true)** → log `dry_run`, no write. Only `DRY_RUN=false` performs live voids (**Fly sets it false**).
4. Void → on success, approve with `{amountConversion:0, amountPayout:0}`. `CALL_DELAY_MS` (500ms) between calls.
5. Special case: if void returns "Conversion would be brought below zero" (`CONVERSION_ALREADY_ZERO_VOID_MARKER`), treat as already-voided and still approve.

**Ringba API:** base `https://api.ringba.com/v2`, auth `Authorization: Token ${RINGBA_API_TOKEN}`, acct `RINGBA_ACCOUNT_ID`. Endpoints: `jobQueue` (GET), `calls/void` (POST), `jobQueue/{id}/action` (POST), `ringbaaccounts` (health). Void retries on 429 (up to 3×, 60/120/240s backoff, inline/blocking).

**DB `scrub_log.db`:** `scrub_log` (id, taskId, inboundCallId, publisherName, amountVoided, status, errorMessage, createdAt, + `voidPayoutAmount`, `voidConversionAmount`); `poll_state` (lastSuccessfulPollAt). The table mixes terminal-outcome rows and step-trace rows in the same `status` column.

**Scheduling:** `pollScheduler` — one cycle at boot, then `setInterval(POLL_INTERVAL_MS)` (8h). Health-check at startup → `process.exit(1)` if unhealthy. Auth failure latches `authStopped` and halts the loop until restart. Single-flight guard.

**HTTP:** `GET /api/overview`, `POST /api/run-now` (💰 triggers live voids when `DRY_RUN=false`), `GET /api/scrubs`, `GET /api/stats`, `GET /api/debug/failed-scrubs`.

**Risks:**
- Irreversible money writes with the only guardrail being `DRY_RUN`; trusts Ringba's queue completely.
- **Partial idempotency:** dedup only checks for a prior `success` row. A void-succeeded/approve-failed call has no `success` row → re-voided next cycle; protected only by Ringba's exact "below zero" error string (fragile substring match).
- Void↔approve non-atomic; `inboundCallId` derived by string-stripping the job id; the void field is sent as the misspelled key `voidConverionAmount` (works only because Ringba accepts that literal spelling).

---

## 5. System 2 — Payments (Bill.com + Wise)

**Files:** `agents/paymentAgent.ts`, `lib/billcomClient.ts`, `lib/billcomPendingPay.ts`, `lib/wiseClient.ts`, `lib/paymentEmail.ts`, `lib/paymentEnv.ts`, `lib/chicagoTime.ts`, `public/payment.html`. **No LLM. No scheduler — operator-driven.**

**Purpose:** Reconcile affiliate earnings from **two sources** — Ringba (pay-per-call) and Polyares (affiliate network) — merge per affiliate, and pay via **Wise** or **Bill.com ACH**. Manual dashboard at `/payment`.

**Data sources & merge (`mergeAffiliates`):**
- **Ringba:** `POST /{acct}/insights` grouped by `publisherName` (callCount, converted/completed, payoutAmount), timezone `America/Chicago`; a 2nd insights call over a 7-day window flags CPL affiliates.
- **Polyares:** screen-scrape login to `https://affiliates.polyares.com` (Yii2 CSRF form), export income CSV. **⚠️ Hardcoded credentials in source** (`paymentAgent.ts:9-10`).
- **Name matching priority:** exact (trim+lowercase) → `FORCE_BOTH_MERGE` hardcoded dict (2 pairs) → suffix-tag (`"Name - TAG"`) → else separate `POLYERAS` row + a fuzzy "similar" **outlier flag for manual review only**. (Enum value is misspelled `"POLYERAS"` throughout — load-bearing.)
- **CPL hold markers:** `["inquirly", "33 miles rtt -"]`.

**Payment rails:**
- **Bill.com:** legacy v2 session login (`devKey`/user/pass/orgId) + MFA (code to registered phone; 30-day trust persisted in `billcom_mfa`). Creates Vendors (+ `VendorBankAccount` ACH), Bills (`LS-{Date.now()}`), Payments; bulk via `gateway.bill.com/connect/v3/payments/bulk` (batches of 50). `processDate` = next Chicago business day (+2 for new banks). Vendor IDs must match `/^009.../`.
- **Wise:** Bearer token. Resolve target: stored recipient ID → email match → create ACH (ABA) recipient → Wise contact. Send = quote → transfer → fund from balance. Recipient IDs auto-saved after payout.

**DB (`scrub_log.db`, shared):**
- `affiliate_metadata` (PK publisherName): method/terms/paid flags, `billcomVendorId`, **full Bill.com + Wise ACH account/routing numbers in plaintext**, `wiseEmail/wiseTag/wiseRecipientId`, `paymentEmail`.
- `billcom_mfa` (1 row): 30-day device/mfa trust.
- `affiliate_paid_months` (publisherName+`YYYY-MM`), `affiliate_paid_weeks` (publisherName+Monday `YYYY-MM-DD`) — settlement ledgers.
- Bill.com pending-MFA payouts held **in-memory only** (`billcomPendingPay.ts`, 15-min TTL Map).

**Holds & cadence:** All `America/Chicago`. Manual month/week toggle. **Second-Monday CPL hold** (`secondMondayHoldForMonth`): $0-CPL affiliates held until the second Monday of the following month (month periods only; weeks never hold).

**HTTP:** stats/`stats/all`/profit/unpaid-all (reads); `admin/wise-recipients`; metadata read/write; mark-paid (month/week); 💰 `pay/wise/:name`, `pay/billcom/:name`, `billcom/mfa/verify`, `pay/bulk/wise`, `pay/bulk/billcom`.

**Risks:**
- **Double-pay window:** the paid-ledger pre-check runs before payout but is written after; two concurrent requests for the same affiliate/period can both pay (no lock, no real idempotency key — invoice/reference use `Date.now()`).
- Bill.com bulk optimistically marks success if the API returns no per-item results; MFA pending state lost on restart leaves an orphan created bill.
- Name-merge false positives directly change **who gets paid / how much**; substring vendor/recipient fallback can match the wrong payee.
- **Hardcoded Polyares creds; plaintext ACH numbers in DB;** money routes have no server-side auth (see §11).

---

## 6. System 3 — Fraud Detection

**Files:** `agents/fraudAgent.ts`, `lib/fraudDb.ts`, `lib/fraudNotify.ts`, `lib/fraudScheduler.ts`, `lib/ipqsClient.ts`, `lib/ringbaFraudClient.ts`, `public/fraud.html`.

**Purpose:** Scan **converted calls only** for three fraud signatures and alert (email + WhatsApp). **Advisory** — blocking a publisher is always a manual click.

**Detection (`processCall`):**
1. **VOIP/spoof** via IPQS phone intel (VOIP line, virtual-carrier markers — google voice/textnow/twilio/bandwidth/etc., recent abuse, spammer, `fraud_score ≥ 85`). Severity = floored IPQS score.
2. **Shared caller-ID** across publishers (`caller_index`): >1 publisher → severity `50 + 15×count`.
3. **Transcription + AI tone analysis** (per scan, capped): download recording → Whisper (`whisper-1`) → SHA-256 dedup for reused scripts → LLM verdict (`gpt-4o-mini`, "call-fraud analyst" prompt, JSON `{ai_score, verdict, reasons}`). Duplicate script → force score ≥85. Flag if `ai_score ≥ 70`.
- **Publisher risk** = `min(100, 60×min(flagRate×2,1) + 0.4×maxSeverity)`.

**External APIs:** IPQS (`GET .../phone/{KEY}/{number}`, key in URL path, 30-day cache in `phone_intel`); Ringba (`calllogs` filter `hasConverted=true`; `GET/PATCH Affiliates/{id}` — the **only Ringba write-back**, enable/disable); Twilio WhatsApp (HTTP Basic); SMTP; OpenAI (Whisper + gpt-4o-mini).

**DB `fraud.db`:** `processed_calls`, `phone_intel`, `caller_index`, `flagged_calls` (UNIQUE(inboundCallId,reason)), `publisher_fraud`, `call_analysis` (full transcripts persisted), `fraud_poll_state`.

**Scheduling:** `fraudScheduler` — first scan 15s after boot, then `FRAUD_POLL_INTERVAL_MS` (15 min). Disabled if `FRAUD_ENABLED=false` or no Ringba creds. Ringba fetch capped at 1000 calls/scan; transcription capped at `FRAUD_MAX_TRANSCRIPTIONS_PER_SCAN` (5). Alert throttle 6h/publisher.

**HTTP:** summary/feed/publishers/`call/:id` (reads); `POST /api/fraud/scan`; 💰 `POST /api/fraud/block/:name` / `unblock/:name` (Ringba affiliate enable/disable — gated by echoing the exact publisher name, but **no server-side auth**).

**Risks:** broad virtual-carrier substring matching → false positives on legit ported/VOIP numbers; naive JSON parsing + hash-collision "script reuse" on short transcripts; block/unblock unauthenticated; recording download attaches the Ringba token to any URL containing `"ringba.com"`.

---

## 7. CPL Updater (33 Miles RTT / Inquirly)

**Files:** `lib/cplParser.ts`, `lib/ringbaCplClient.ts`, `lib/cplDb.ts`, `public/cpl.html`, routes in `server.ts`. **No LLM.**

**Purpose:** A buyer (33 Miles RTT / Inquirly) sends a **weekly CSV/xlsx** of billable calls with a Cost-Per-Lead. The tool matches those rows to Ringba calls and **writes revenue + payout back to Ringba** via `POST /{acct}/calls/payments/override`, so the buyer's CPL revenue shows in Ringba. Two-phase **preview → confirm**.

**Parse (`cplParser.ts`):** `XLSX.read` auto-detects CSV or xlsx; columns resolved by name (any order, extras ignored). Caller IDs normalized to last-10. Time labeled "EST" but the offset is **auto-detected** (EDT vs EST vs Central) by scoring which offset yields the most matches (the header proved unreliable).

**Fetch (`ringbaCplClient.ts`):** **fetches server-side by the file's billable caller numbers** (`inboundPhoneNumber` OR-filtered, chunks of 100) — this defeats **Ringba's 10,000-row report cap** that otherwise returned only the earliest ~day of a busy account. Adaptive time-slice fallback (bisect a window that returns at the cap) if the caller filter is ever unsupported. The file's "Tracking Number" is 33 Miles' own DID (unrelated to this account's DIDs) — caller ID is the only reliable key.

**Match/classify (`matchAndClassify`):** billable rows matched by caller last-10 + time (±15 min) at the auto-detected offset; tracking-# then CPL-target-name as tiebreakers so another buyer's call for the same caller is never claimed. **SET** = revenue = CPL, payout = 50%. **STRIP** = revenue-but-no-payout calls that are provably 33 Miles (marker name or a tracking # in the file) → 0/0; `$0` calls and fully-paid calls untouched.

**DB `cpl.db`:** `cpl_batches`, `cpl_rows` (per-row audit of what was written).

**HTTP:** `POST /api/cpl/preview` (25mb JSON; parse + match + store batch, no writes), 💰 `POST /api/cpl/apply` (writes overrides per row), `GET /api/cpl/batches`, `GET /api/cpl/batch/:id`.

**Risks:** apply is sequential (~hundreds of overrides); unfiltered-fallback path fetches the firehose (slow); no server-side auth on apply.

---

## 8. Jarvis ("hull") — Digital Twin: Brain + Memory + Voice

**Files:** `hull/index.ts`, `hull/ws.ts`, `hull/openaiConfig.ts`, `hull/briefing.ts`, `hull/brain/*`, `hull/memory/*`, `hull/voice/*`, `public/jarvis*.html/js`, `public/memory-map.html`.

**Purpose:** "LeadSmart's digital twin / chief of staff" — chat, voice Q&A, a neural-map memory graph, document ingestion, and **read-only** live access to the scrub/payment/fraud departments.

**Brain (`agent-loop.ts`):** OpenAI only. `runAgentLoop`, max 8 tool rounds, streaming or completion. Model pick: fast (`gpt-4o-mini`) for voice/whatsapp/short; full (`gpt-4o`) for long or "analyze/compare/strategy/explain". Tools: `memory_store/recall/graph`, **read-only ops** `get_scrub_status/get_payment_summary/get_fraud_status`, and `web_search` (Brave, only if key set). System prompt hardcodes business rules and an assertive "you can, live data wins" tone. Low-confidence business queries return a clarifying question instead of answering.

**Memory / neural map (`hull/memory/*`, `aethon-memory.db`):**
- Tables: `facts` (with `embedding` BLOB), `episodes`, `nodes`, `edges`, `rules`, `syntheses`, `identity_dimensions/questions`, `system_state`, `documents`, `conversations`.
- **Embeddings:** OpenAI `text-embedding-3-small`, 1536-dim, stored as raw Float32 blobs.
- **Retrieval:** hybrid keyword-first, embeddings only when keyword recall is thin; recall reinforces strength.
- **Extraction** (fast model, post-conversation + per document chunk) writes facts/nodes/edges/**rules**. **Reflection** every 12h; **synthesis** weekly (Sun 3am); **decay** daily.
- **Ingestion:** up to 8MB / 2M chars, chunked, background-extracted; retraction marks facts `superseded_by`.
- Served to a force-graph UI at `/memory`.

**Voice (`hull/voice/*`):** **TTS = ElevenLabs** (`eleven_flash_v2_5`, voice `21m00Tcm4TlvDq8ikWAM`, PCM 24kHz, 50-entry cache). **STT = ElevenLabs Scribe v2 Realtime** — ⚠️ the code/route is named "deepgram" for client compatibility but **no Deepgram is used**. `sanitizeSpeech` strips markdown/JSON before speaking. WebSockets: `/api/jarvis/deepgram/listen` (STT) and `/api/hull/events` (memory broadcast).

**Integration:** **read-only by construction** — `opsData.ts` opens `scrub_log.db` and `fraud.db` with `{readonly: true}` and runs only SELECTs. Jarvis has **no tool** to void, pay, block, or trigger a poll. Only writes are into its own memory DB. Live payout dollar amounts are deliberately not exposed.

**Risks:** **no auth** on any Jarvis/memory/voice route; **prompt-injection via ingestion** (an 8MB document from anyone can plant durable "facts"/"rules" that then steer answers — impact bounded because Jarvis can't write to money systems); open cost/DoS (gpt-4o tool rounds, ingestion fan-out) with no rate limiting; STT WS upgrade check is `() => true`.

---

## 9. External Services & LLM/Model Inventory

**Every external service the app integrates:**

| Service | Host | Auth | Used by |
|---|---|---|---|
| Ringba API v2 | `api.ringba.com` | `Token` header | Scrub, Payments (insights), Fraud, CPL |
| Wise | `api.wise.com` | Bearer | Payments |
| Bill.com | `api.bill.com`, `gateway.bill.com` | session + devKey + MFA | Payments |
| Polyares | `affiliates.polyares.com` | scraped login (hardcoded creds) | Payments |
| IPQualityScore | `ipqualityscore.com` | key in URL | Fraud |
| OpenAI | `api.openai.com` | Bearer | Fraud (Whisper, gpt-4o-mini), Jarvis (gpt-4o, gpt-4o-mini, embeddings) |
| ElevenLabs | `api.elevenlabs.io` (+ wss) | key | Jarvis TTS + STT |
| Twilio | `api.twilio.com` | Basic | Fraud WhatsApp alerts |
| Brave Search | `api.search.brave.com` | key | Jarvis web_search (optional) |
| SMTP/nodemailer | configurable | user/pass | Payment + fraud emails |

**Every LLM/model:**

| Model | Provider | Purpose | Config |
|---|---|---|---|
| `gpt-4o` | OpenAI | Jarvis full chat/agent loop | `OPENAI_MODEL` |
| `gpt-4o-mini` | OpenAI | Jarvis fast mode, memory extraction/reflection/synthesis, briefing, **fraud transcript classification** | `OPENAI_FAST_MODEL` |
| `text-embedding-3-small` (1536d) | OpenAI | Memory embeddings | hardcoded |
| `whisper-1` | OpenAI | Fraud call transcription | hardcoded |
| `eleven_flash_v2_5` (voice `21m00Tcm4TlvDq8ikWAM`) | ElevenLabs | Jarvis TTS | `ELEVENLABS_MODEL_ID`/`_VOICE_ID` |
| `scribe_v2_realtime` | ElevenLabs | Jarvis STT | `ELEVENLABS_STT_MODEL` |

_(No Anthropic/Claude models are used anywhere in the app.)_

---

## 10. Complete Route Inventory

Body parsers: global `express.json()` (~100kb) except `/api/cpl/preview`; `express.static`. CORS `*` on `/api`. 💰 = writes to a money/Ringba-payment system.

**Static / health:** `GET /jarvis`, `/payment`, `/payments`, `/fraud`, `/cpl`, `/jarvis-chat`, `/memory` (+ `/memory-map` redirect), `/health`, `GET *` SPA fallback.

**Scrub:** `GET /api/overview`, 💰`POST /api/run-now`, `GET /api/scrubs`, `GET /api/stats`, `GET /api/debug/failed-scrubs`.

**Payments:** `GET /api/payment/stats`, `/stats/all`, `/profit`, `/unpaid-all`, `POST /api/payment/numbers-csv`, `GET /api/admin/wise-recipients`, `GET/POST /api/payment/metadata[/:name]`, `POST /api/payment/mark-paid/:name`, `/mark-paid-week/:name`, 💰`POST /api/payment/pay/wise/:name`, 💰`/pay/billcom/:name`, 💰`/billcom/mfa/verify`, 💰`/pay/bulk/wise`, 💰`/pay/bulk/billcom`.

**Fraud:** `GET /api/fraud/summary`, `/feed`, `/publishers`, `/call/:id`, `POST /api/fraud/scan`, 💰`POST /api/fraud/block/:name`, 💰`/unblock/:name`.

**CPL:** `POST /api/cpl/preview`, 💰`POST /api/cpl/apply`, `GET /api/cpl/batches`, `/batch/:id`.

**Jarvis/Memory:** `POST /jarvis/tts`, `/api/jarvis/voice`, `/api/jarvis/voice/command`, `GET /api/jarvis/activation`, `POST /v1/chat/completions`, `/api/jarvis/extract`, `/api/jarvis/chat`, `/api/memory/extract-voice`, `/api/memory/ingest`, `GET/DELETE /api/memory/documents[/:id]`, `GET /api/memory/graph/full`, `/graph`, `/overview`, `/facts`, `/episodes`, `/rules`, `/syntheses`, `/identity`.

**Admin:** `POST /api/import-db` (Bearer `DB_IMPORT_SECRET` — the **only** server-authed route).

**WebSocket:** `/api/jarvis/deepgram/listen` (STT → ElevenLabs Scribe), `/api/hull/events` (memory broadcast).

---

## 11. Schedulers

All in one process:
- **Scrub poll** — boot + every `POLL_INTERVAL_MS` (8h). Health-check gate; auth-failure latch.
- **Fraud scan** — 15s after boot + every `FRAUD_POLL_INTERVAL_MS` (15 min).
- **Memory decay** — every 24h. **Memory reflection** — every 12h. **Weekly synthesis** — Sun 3am (self-rescheduling).
- One-shot at boot: `bootstrapHullMemory()` + `backfillEmbeddings(100)`.

---

## 12. Consolidated Risk Register (prioritized)

**P0 — Critical**
1. **No server-side auth on money endpoints.** All payout, CPL-override, fraud-block, and run-now routes are reachable with no token/session; only a client-side password (`leadsmart2026`) + `CORS:*` "protect" them. A leaked URL = ability to move funds and alter Ringba. **Fix first** (server-side auth middleware on all write routes; move the password server-side or add real sessions).
2. **Payout double-pay window.** Paid-ledger check is pre-write, not atomic; no real idempotency key. Concurrent requests can double-pay.
3. **Plaintext secrets/PII at rest & in source.** Hardcoded Polyares creds (`paymentAgent.ts:9-10`); full ACH account/routing numbers in `affiliate_metadata` plaintext.

**P1 — High**
4. **Single machine / single volume / no backups** for `fraud.db`/`cpl.db`/`aethon-memory.db` (no export path). Volume loss = data loss. 512MB shared with LLM work + 5 schedulers.
5. **`DRY_RUN=false` in production** — live Ringba voids run automatically every 8h with no human gate; scrub idempotency is partial (re-void risk if approve fails).
6. **Prompt-injection via Jarvis ingestion** — unauthenticated 8MB uploads plant durable memory "facts/rules." Bounded only because Jarvis has no money-write tools.
7. **STT WebSocket open to all** (`tokenOk = () => true`) — anyone can burn the ElevenLabs key.

**P2 — Medium**
8. **`/api/import-db` wholesale-replaces `scrub_log.db`** (payments + scrub) on a valid-but-stale upload; one backup copy only.
9. **Name-merge false positives** in payments change who/how-much is paid; substring vendor/recipient fallback.
10. **Memory DB path divergence** (`/data` vs `/app/data`, ignores `DATA_DIR`).
11. **Fraud false positives** (broad VOIP/carrier markers, hash-collision "script reuse").
12. **No input validation / rate limiting / helmet**; large-limit JSON parsers (8–25MB) on unauthenticated routes = DoS vector on 512MB.
13. **Fragile Ringba coupling:** misspelled `voidConverionAmount` key, `JQI_`-prefix id derivation, error-string matching for "already zero."
14. **Misleading "deepgram" naming** for an ElevenLabs STT path (operational/debug hazard).

---

## 13. Dependencies

`express` (HTTP), `better-sqlite3` (all 4 DBs), `axios` + `axios-cookiejar-support` + `tough-cookie` (external APIs, session logins), `openai` (LLM/embeddings + `/v1/chat/completions` shape), `ws` (WebSockets), `nodemailer` (email), `xlsx` (CPL workbooks), `csv-parse` (rental-number CSV), `dotenv`. Dev: `typescript`, `ts-node`, `@types/*`.

**Notably absent:** no test framework, no auth/session library, no validation library (zod), no rate limiter, no `helmet`.

---

_End of audit._
