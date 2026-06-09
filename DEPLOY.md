# Deploy to Fly.io

Runs the scrub agent (8h poll) and dashboard on one machine with persistent SQLite at `/app/data`.

## Prerequisites

- [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/)
- `fly auth login`
- Ringba API token and account ID

## First-time setup

From `LeadSmart/RINGBA`:

```bash
# Create app (skip if fly.toml already linked)
fly apps create leadsmart-ringba-scrub

# Persistent volume for scrub_log.db (once per app)
fly volumes create scrub_data --region iad --size 1

# Secrets (not committed)
fly secrets set \
  RINGBA_API_TOKEN="your_token" \
  RINGBA_ACCOUNT_ID="your_account_id"

# Optional overrides
fly secrets set DRY_RUN=false
```

`fly.toml` already sets `POLL_INTERVAL_MS=28800000` (8 hours).

## Deploy

```bash
fly deploy
```

Open the dashboard: `fly open` (or `https://leadsmart-ringba-scrub.fly.dev`).

## Verify

```bash
fly logs
fly ssh console -C "ls -la /app/data"
```

You should see `scrub_log.db` after the first poll.

## Local production smoke test

```bash
npm run build
npm run start:prod
```

Dashboard: http://localhost:3000 (set `PORT=3000` locally).

## Notes

- **DRY_RUN**: Set `false` in Fly `[env]` or via `fly secrets set DRY_RUN=false` for live voids.
- **Database path**: Fly uses volume `/app/data/scrub_log.db` (`DATA_DIR=/app/data`). Local dev uses `./data/scrub_log.db` unless you set `DATA_DIR`.
- **Sync local → Fly** (recommended):

```powershell
npm run db:push-fly
```

Or manually: set `DB_IMPORT_SECRET` on Fly, deploy, then `POST /api/import-db` with `Authorization: Bearer <secret>` and raw SQLite body.

- **Sync via SFTP** (alternative): `fly ssh sftp put data/scrub_log.db /app/data/scrub_log.db -a leadsmart-ringba-scrub`
- **Next run timer**: `lastSuccessfulPollAt + POLL_INTERVAL_MS` from the API. **RUN NOW** on the dashboard triggers `POST /api/run-now`.
- Restarting the machine runs one poll immediately, then every 8h.
