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
