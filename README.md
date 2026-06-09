# LeadSmart RINGBA — Scrub Agent (System 1)

Automates zeroing affiliate payouts on Ringba calls where a buyer has disputed the conversion (conversion adjusted, payout still outstanding).

## Prerequisites

- Node.js 18+
- Ringba API token with access to call logs and void endpoints

## Setup

1. Install dependencies:

   ```bash
   cd LeadSmart/RINGBA
   npm install
   ```

2. Copy environment file and fill in credentials:

   ```bash
   cp .env.example .env
   ```

3. Set `DRY_RUN=true` for first runs. The agent will log actions without calling the void endpoint.

## Environment variables

| Variable | Description |
|----------|-------------|
| `RINGBA_API_TOKEN` | Bearer token for `Authorization: Token …` |
| `RINGBA_ACCOUNT_ID` | Ringba account ID used in API paths |
| `DRY_RUN` | `true` = no void writes; `false` = live voids |
| `POLL_INTERVAL_MS` | Polling interval (default `600000` = 10 min) |
| `CALL_DELAY_MS` | Delay after void + approve (default `500`) |
| `RINGBA_DEBUG` | `true` = verbose Ringba request/response logs |

## Run

**One-shot (testing):**

```bash
npm run scrub:once
```

**Continuous polling:**

```bash
npm start
```

On startup the agent runs a health check (`GET /v2/ringbaaccounts`), executes one scrub cycle immediately, then polls every `POLL_INTERVAL_MS`.

Ringba JSON bodies are read via Axios as `response.data.report.records` (call logs) and `response.data.result` (void).

## Detection flow (end-to-end)

1. **List** — `GET /jobQueue?status=open`, filter `type === CallVoid_Conversion`.
2. **Parse** — `inboundCallId` from `JQI_` job `id`; amounts from `publicState['call Conversion']` and `publicState['call Payout']`.
3. **Void** — existing void logic (payout + conversion when both > 0).
4. **Approve** — `POST .../jobQueue/{jobId}/action` with `amountPayout: 0`, `amountConversion: -conversionAmount`.

SQLite dedup by `inboundCallId`. Skipped when `DRY_RUN=true`.

Poll every **10 minutes** (`POLL_INTERVAL_MS=600000`).

## Data

SQLite database: `./data/scrub_log.db`

- `scrub_log` — per-call scrub attempts (success, error, dry_run)
- `poll_state` — `lastSuccessfulPollAt` for catch-up after downtime

## Architecture

- `lib/ringbaClient.ts` — Ringba HTTP only (no business logic)
- `agents/scrubAgent.ts` — orchestration, dedup, DRY_RUN
- `lib/logger.ts` — SQLite logging
- `index.ts` — startup, health check, polling loop
