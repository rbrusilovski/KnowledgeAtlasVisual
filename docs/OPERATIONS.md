# Operations

How to deploy, back up, restore, monitor and recover Atlas. Development setup lives in the README.

## 1. Environments

| File | Purpose |
|---|---|
| `docker-compose.yml` | **Development only.** Postgres + Redis bound to `127.0.0.1`, fixed `atlas/atlas` credentials for the local container. |
| `docker-compose.prod.yml` | **Production.** `web` + `worker` + Postgres + Redis. Postgres/Redis publish no host ports and live on an internal-only network (`data`); Redis requires a password; every secret is a required variable (`${VAR:?}`) — compose refuses to start without it. Only `web` publishes a port, bound to `127.0.0.1` by default (put a TLS reverse proxy in front). |

Production secrets go in `.env.production` (gitignored, excluded from the Docker build context):

```env
POSTGRES_USER=atlas
POSTGRES_PASSWORD=<openssl rand -base64 32>
REDIS_PASSWORD=<openssl rand -base64 32>
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=https://atlas.example.com
ENCRYPTION_KEY=<openssl rand -base64 32>
YOUTUBE_MODE=live
YOUTUBE_API_KEY=...
# Policy gates stay false until a decision is recorded in docs/COMPLIANCE_DECISIONS.md §12.
YOUTUBE_LIVE_COLLECTION_ENABLED=false
```

`DATABASE_URL`/`REDIS_URL` are composed from these variables inside the compose file; do not hard-code them.

## 2. Deploy

```bash
git fetch && git checkout <release-tag>
pnpm db:preflight                         # prisma migrate status + an encrypted backup (needs BACKUP_ENCRYPTION_KEY)
ATLAS_TAG=<release-tag> docker compose -f docker-compose.prod.yml --env-file .env.production build
ATLAS_TAG=<release-tag> docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

The `web` container runs `prisma migrate deploy` before `next start`. The worker shuts down gracefully on SIGTERM
(active jobs finish; approvals and checkpoints are persisted, so interrupted backfills resume).

Post-deploy checks: `GET /api/health` is green; `/admin` → Alerts is empty or expected; `pnpm graph:verify`.

## 3. Rollback

1. Re-deploy the previous image tag: `ATLAS_TAG=<previous> docker compose -f docker-compose.prod.yml --env-file .env.production up -d`.
2. Migrations are forward-only. If the new release added only additive migrations (new columns/tables — the norm
   here), the previous release runs against the newer schema unchanged.
3. If a migration was destructive or the data is damaged, restore the pre-deploy backup taken by `db:preflight`
   (§5) and then start the previous tag.

## 4. Backups

`pnpm db:backup` — `pg_dump -Fc` → AES-256-GCM → `BACKUP_DIR/atlas-<db>-<ts>.dump.enc` + `.sha256`.

| Variable | Meaning |
|---|---|
| `BACKUP_ENCRYPTION_KEY` | **Required.** 32 bytes base64. Store it in your secret manager, **not** on the database host. Plaintext dumps are refused. |
| `BACKUP_ENCRYPTION_KEY_ID` | Written into the file header (default `b1`) for key rotation. |
| `BACKUP_DIR` | Local staging directory (default `./backups`, gitignored). |
| `BACKUP_UPLOAD_CMD` | Off-host copy, `{file}` is substituted, e.g. `rclone copy {file} remote:atlas-backups` or `aws s3 cp {file} s3://bucket/atlas/`. Without it /admin raises "backups are not off-host". |
| `BACKUP_RETENTION_DAYS` | Local retention (default 14). Off-host retention is configured on the bucket (recommended: 30 daily + 12 monthly). |
| `PG_CONTAINER` / `PG_COMPOSE_FILE` | When the host has no `pg_dump`, the script runs it inside the Postgres container (auto-detected). |

Schedule it daily (cron/systemd timer on the host, e.g. `15 2 * * * cd /srv/atlas && pnpm -s db:backup`). Status is
recorded in Redis; /admin alerts when the last backup failed, is older than 26 h, or never happened.

**Redis** is not backed up by design: everything in it is reconstructible (response cache, rate limits, SSE replay
buffer, BullMQ queues — pending work is re-proposed by the schedulers; approvals live in Postgres) **except today's
quota counters**. After a Redis loss, set `QUOTA_BACKGROUND_RATIO` low for the rest of the Pacific day or wait for the
reset to avoid exceeding the real YouTube quota.

## 5. Restore

**Test restores weekly:** `pnpm db:restore-test [--file …]` decrypts (GCM tag verified first), restores into a
throwaway `atlas_restore_test_<ts>` database on the same server, checks migrations and core tables, and drops it.
/admin alerts when no restore test succeeded in 8 days.

**Disaster recovery:**

```bash
docker compose -f docker-compose.prod.yml stop web worker
# decrypt (same code path as the restore test) — writes a plain custom-format dump
pnpm -s tsx -e 'import("./scripts/lib/pg-tools.ts").then(async (m) => { const fs = await import("node:fs"); const { pipeline } = await import("node:stream/promises"); await pipeline(fs.createReadStream(process.argv[1]), m.decryptStream(m.backupKey().key), fs.createWriteStream("restore.dump", { mode: 0o600 })); })' backups/atlas-atlas-<ts>.dump.enc
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "${POSTGRES_DB:-atlas}" < restore.dump
shred -u restore.dump
docker compose -f docker-compose.prod.yml start web worker
pnpm graph:verify --repair && pnpm embeddings:reindex   # both are no-ops when consistent
```

Then run the compliance job once (`/admin` queue dashboard → `compliance` → promote, or wait for 03:00 PT): restored
API data older than its retention deadline is deleted.

## 6. Monitoring & alerts

`/admin` → Alerts evaluates every 15 s; the worker's `alerts` scheduler logs a structured `alert` event (pino,
`msg: "alert"`, `severity`, `alert`, `action`) every time an alert appears, changes severity or resolves — route
those log lines to your pager. Checks: worker heartbeat, failed-job backlog, queue lag, repeated upstream errors,
quota exhaustion, OAuth refresh failures, embedding failures and vector-space consistency, API-data retention
deadlines (expiring without a refresh proposal / overdue), stale graph materialization, backup failure / staleness /
on-host only, restore test age. In non-production environments backup checks are informational.

## 7. Recovery tools

| Command | Use |
|---|---|
| `pnpm jobs:recover [--apply] [--retry-failed]` | Closes IngestionRuns left "running" by a dead worker, finalizes proposals whose jobs vanished from Redis, re-enqueues a stuck graph build, optionally retries failed jobs (workers re-validate their approval). Dry run by default. |
| `pnpm graph:verify [--repair]` | Compares GraphNode/GraphEdge with canonical rows: missing/orphan nodes, dangling/non-canonical/malformed edges, dirty-set age, version drift. Exit 2 when inconsistent. |
| `pnpm graph:rebuild [--topics]` | Full rebuild. |
| `pnpm embeddings:reindex [--all]` | Re-embeds rows whose vector came from another model (resumable; refuses on a column-dimension mismatch). Semantic search, SIMILAR edges and embedding-based classification stay off while vectors from different models coexist. |
| `pnpm db:reset --yes` | **Development only**: refuses `NODE_ENV/ATLAS_ENV=production`, `YOUTUBE_MODE=live`, and non-local hosts unless `ATLAS_ALLOW_REMOTE_RESET=1` (never in production). |

## 8. Claude / MCP

Users create agent tokens in Settings → Agent access. Run the local adapter where Claude runs:

```bash
ATLAS_URL=https://atlas.example.com ATLAS_AGENT_TOKEN=atl_… pnpm -s mcp
```

Tokens can inspect and propose; approvals happen only in the Atlas UI by the signed-in user. Revoke tokens in
Settings; revocation is effective on the next call.
