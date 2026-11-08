# Decisions

Format: decision — reason — alternative considered.
- Node 24 LTS installed user-locally in `~/.local/node` — no Homebrew on host, user approved — Homebrew/nvm.
- Docker runtime is OrbStack — installed by user — Docker Desktop.
- Prisma pinned to 7.10.1 (stable) — npm `latest` tag points at 8.0.0-rc; Better Auth peer range is `^7` — Prisma 8 RC.
- Prisma client generated to `src/generated/prisma` (gitignored) via `prisma-client` generator + `@prisma/adapter-pg` — Prisma 7 requires explicit output + driver adapter — legacy `prisma-client-js`.
- Extensions created in the init migration SQL, not `datasource.extensions` — that needs the `postgresqlExtensions` preview — enabling the preview.
- tsvector columns are trigger-maintained (`atlas_*_tsv()` functions); GIN indexes on them are declared in schema.prisma (Prisma allows Gin on Unsupported) — keeps `migrate dev` drift-free — GENERATED columns.
- HNSW indexes are *partial* (`WHERE embedding IS NOT NULL`) in a hand-written migration — Prisma can't express HNSW and would drop full indexes on each `migrate dev`, but ignores partial ones — expression index / ignoring drift. KNN queries always include the predicate.
- Next.js `cacheComponents` / `partialPrefetching` disabled — app is a client-heavy workspace backed by dynamic route handlers; avoids prerender constraints on DB-backed pages — adopting Cache Components.
- MSW dropped: MSW 3 did not intercept Node 24 fetch in Vitest (a request leaked to Google). LiveYouTubeClient takes an injectable fetch; tests use an in-memory transport — MSW.
- Fixture mode meters quota exactly like live mode — UI quota meter and lane logic are exercised in the demo — skipping metering in fixture mode.
- Fixture dataset is committed (~7 MB, deterministic seed 1337) and includes scheduled future uploads hidden until their publishedAt passes, so incremental sync finds new videos over time (`FIXTURE_NOW` overrides the clock) — generating at setup.
- Job events for user-initiated jobs go only to `events:user:{id}`; background jobs go to `events:global` — avoids duplicate delivery on one SSE connection — publishing to both.
- Incremental sync and stats refresh bypass the response cache — sync exists to see fresh data — relying on the 30 min first-page TTL.
- bull-board runs inside the worker on 127.0.0.1:BULL_BOARD_PORT; the web app proxies `/api/admin/queues` for ADMIN users — no maintained Next.js adapter — mounting via Hono.
- Custom job IDs use '-' separators (`ingest-UC…`, `sync-<id>-<hour>`) — BullMQ 6 rejects ':' in custom IDs — spec's `ingest:{id}` literal.
- Web process embeds search queries in-process (lazy transformers.js singleton, warmed by instrumentation; 2 s timeout → keyword fallback) — simpler than a BullMQ RPC and no worker round-trip — worker RPC via waitUntilFinished.
- `EMBEDDING_PROVIDER=hash` (feature hashing) added for offline/CI tests — keeps integration tests deterministic and fast; local MiniLM remains the default — downloading the model in CI.
- Topic rows are created on first sighting (needed for canonical merging + counts) but only topics with ≥ 2 videos become graph nodes / list results — spec says *materialize a node* at ≥ 2 videos.
- MiniLM cosine is rescaled (cos−0.12)/0.48 → 0..1 before the 0.55 weight — raw cosines for related text sit around 0.15–0.6 so unscaled scores never cleared the 0.35 threshold — per-channel max-normalization.
- If a channel has any MANUAL niche, all automatic labels are removed on reclassification — 'manual always wins' — mixing manual + automatic labels.
- Taxonomy lives in `src/server/taxonomy.ts` (seed + classification + fixture generator import it) — server code can't import from prisma/ via the @ alias — duplicating it.
