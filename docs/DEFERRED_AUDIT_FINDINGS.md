# Deferred audit findings

Findings discovered during the YouTube-ingestion session (2026-11-09) that are **outside** that session's scope.
They are recorded here for a future coding window and were intentionally **not** implemented. The full gap table for
the YouTube subsystem lives in `docs/PROGRESS.md`.

Format: severity · finding · impact · affected files · recommendation.

| # | Sev | Finding | Impact | Files | Recommendation |
|---|---|---|---|---|---|
| D1 | High | Compose publishes Postgres (5432) and Redis (6379) on `0.0.0.0` with fixed `atlas/atlas` credentials; Redis has no auth; the `prod` profile reuses the same credentials via `DATABASE_URL` literals. | Anyone on the network can read/write the DB and queues on a host running the prod profile. | `docker-compose.yml` | Bind dev ports to `127.0.0.1`; add `docker-compose.prod.yml` with an internal network, no published DB/Redis ports, `${POSTGRES_PASSWORD:?}` required vars, Redis `requirepass`. Document deploy + rollback. |
| D2 | High | No backup/restore strategy (persistent volumes only). | Data loss on host failure; untested recovery. | — | Encrypted `pg_dump` (age/gpg) to off-host storage, retention policy, scheduled restore test, migration preflight (`prisma migrate diff` + dump before deploy), Redis rebuild notes (all Redis data is reconstructible except quota counters). |
| D3 | Medium | `pnpm db:reset` has no production guard (only `--yes`). | A mistyped `DATABASE_URL` wipes a remote DB. | `scripts/db-reset.ts` | Refuse when `NODE_ENV=production` or the DB host is not local unless `ATLAS_ALLOW_REMOTE_RESET=1`. |
| D4 | Medium | `pnpm embeddings:reindex` clears all hashes and re-embeds everything; not resumable; does not record model/dimension per row, so a provider/dimension change can silently mix vector spaces. | Long, all-or-nothing reindex; possible mixed-model KNN. | `scripts/embeddings-reindex.ts`, `services/embeddings` | Add `embeddingModel` per row, reindex only rows whose model ≠ current, refuse when `EMBEDDING_DIM` ≠ column dimension. |
| D5 | Medium | No graph consistency verification / recovery tooling (dangling edges, nodes without source rows, stuck dirty set). | Silent drift after crashes. | `services/graph`, `scripts/` | `pnpm graph:verify` comparing GraphNode/GraphEdge against canonical rows; `pnpm jobs:recover` to requeue failed jobs and close stale `IngestionRun`s. |
| D6 | Medium | Monitoring/alerting is limited to `/api/health` and the admin page; no alerts for failed-job backlog, worker downtime, repeated upstream errors, OAuth refresh failures, embedding failures, backup failures. | Problems found late. | `src/server/health.ts`, `admin/overview` | Alert registry surfaced in admin + structured `alert` log events; external pager integration optional. (Ingestion-specific signals added this session are listed in PROGRESS.md.) |
| D7 | Medium | Claude/agent integration: no agent tokens, tool endpoint or MCP adapter. Coverage + proposal services were built so tools can wrap them. | Claude cannot yet inspect Atlas or file proposals. | new `services/agent`, `scripts/mcp-server.ts` | Agent bearer tokens (hashed, revocable), `POST /api/agent/tools/:name` over the coverage/expansion services, local stdio MCP adapter calling that endpoint. Agents create proposals with `source=CLAUDE`; the approval service already rejects non-session actors. |
| D8 | Medium | Relationship quality (SIMILAR / CO_TOPIC) is not evaluated; thresholds were kept but never measured. | Unknown precision/recall of inferred edges. | `services/graph` | Use fixture ground truth (subniche labels in `fixtures/youtube/index.json`) to compute precision/recall/stability; expose explanations with a FACT vs INFERRED label per edge kind. |
| D9 | Low | Classification provenance (`ChannelNiche`) has method/rationale but no classifier/taxonomy version or score breakdown. | Hard to explain or re-audit niche assignments. | `services/classification` | Store score components + versions in a JSON evidence column. |
| D10 | Low | `next.config.ts` / CSP and general security headers were not re-reviewed in this session. | — | `next.config.ts` | Re-review alongside D1. |
| D11 | Low | Global search ranking/UX and graph visualization were not changed; private transcripts are now excluded from shared search (see PROGRESS.md) — a per-user "my transcripts" search scope could be surfaced in the UI. | UX gap only. | `services/search`, `components/pages/Search.tsx` | Add a "My transcripts" filter. |
| D12 | Medium | Operational alerts not yet covered by D6: quota exhaustion, API data approaching its retention deadline (data exists in `/api/coverage` → `retention`), stale graph materialization (dirty-set age). | Owner may miss the compliance-refresh approval window. | `src/server/health.ts`, `services/coverage`, `services/graph` | Surface as admin alerts alongside D6. |
| D13 | Low | Prompt §16.3 Claude E2E ("Claude identifies a gap and proposes") cannot be written until D7 exists. Proposal-review and approval E2E for user/system proposals is covered. | Claude flow untested end-to-end. | `e2e/` | Add after D7. |

## Cross-reference: prompt §2.1 findings → where they are tracked

| Prompt finding | Tracked in | Status |
|---|---|---|
| Transcript endpoint `auth: "none"` | PROGRESS.md audit #1/#1b/#1c/#1d | Fixed this session |
| Channel addition directly enqueued | PROGRESS.md #2 | Fixed (proposal + approval) |
| Channel sync directly enqueued | PROGRESS.md #3, #3b | Fixed |
| No durable universal approval | PROGRESS.md #4 | Fixed |
| Compliance refresh advanced record-wide timestamp | PROGRESS.md #5 | Fixed |
| Early deletion when quota unavailable | PROGRESS.md #6, #6b | Fixed |
| Single thumbnail URL | PROGRESS.md #7 | Fixed |
| One transcript per video | PROGRESS.md #8 | Fixed |
| AI integration lacks Atlas tools | PROGRESS.md #9 → D7 | Deferred |
| Missing reset/reindex scripts | PROGRESS.md #10 → D3, D4 | Scripts exist; hardening deferred |
| Docker dev credentials / exposed ports | PROGRESS.md #11 → D1 | Deferred |
| Sparse similarity / co-topic edges | PROGRESS.md #12 → D8 | Deferred |
