# Atlas — working notes for Claude

Spec: `BUILD_SPEC.md` (source of truth). Status: `docs/PROGRESS.md`. Decisions: `docs/DECISIONS.md`.
Next.js here is v16 — read `node_modules/next/dist/docs/` before using an unfamiliar API (see AGENTS.md).

## Environment
- Node 24 is user-local: prefix shell commands with `export PATH="$HOME/.local/node/bin:$PATH"`.
- Services: `docker compose up -d postgres redis` (OrbStack). Tests use DB `atlas_test` + Redis prefix `atlas-test`.

## Commands
- `pnpm dev` (web + worker) · `pnpm dev:web` · `pnpm worker`
- `pnpm db:migrate` (deploy) · `pnpm db:migrate:dev` · `pnpm db:seed` · `pnpm db:reset`
- `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm test:integration` · `pnpm e2e` · `pnpm build`
- `pnpm fixtures:generate` · `pnpm yt:probe <url|@handle>` · `pnpm graph:rebuild [--topics]` · `pnpm embeddings:reindex`
- `pnpm taxonomy status|reconcile|shadow|apply [--rebuild]|classify|cleanup [--yes <hash>]` (dynamic taxonomy; never calls YouTube)
- Parallel worktrees share Docker services: isolate runs with `TEST_DATABASE_URL=…/atlas_test_<name>`
  `TEST_REDIS_PREFIX=atlas-test-<name>` (integration) and `E2E_PORT` / `E2E_DATABASE_URL` / `E2E_REDIS_PREFIX` /
  `E2E_BULL_BOARD_PORT` (e2e), or the runs corrupt each other's state.
- E2E: `pnpm e2e` boots `scripts/e2e-server.ts` (DB `atlas_e2e`, prefix `atlas-e2e`, port 3100, distDir `.next-e2e`,
  hash embeddings, 14 seeded channels). Specs read node positions through `window.__atlas`.

## Architecture map
- `src/app` pages + `/api/**` route handlers (all wrapped in `withRoute` from `src/server/http/withRoute.ts`).
- `src/server/{env,db,redis,logger,auth,session,crypto}.ts` — infrastructure singletons.
- `src/server/youtube/` — `YouTubeClient` (live | fixture), `costs.ts` (all quota numbers), resolver.
- `src/server/services/<name>/index.ts` — the ONLY public surface of a service (ESLint enforces).
- `src/worker/` — BullMQ worker process (separate Node process, same services).
- `src/shared/contracts/` — Zod schemas shared by route handlers and client fetchers.
- `src/components`, `src/lib` — client code; may not import `@/server/*` (ESLint enforces).
- `src/lib/atlas/{graph,controller}.ts` — graphology instance (outside React) + sigma 4 controller (reducers, FA2
  worker, interactions). Sigma 4 uses `nodeReducer` returning display data (`opacity`, `visibility`, `depth`…).

## Conventions
- API envelope `{ data, meta? }` / `{ error: { code, message, details? } }`; throw `AppError`.
- Prisma client import: `@/server/db` (generated to `src/generated/prisma`, gitignored).
- BigInt columns serialize as numbers via `jsonReplacer`.
- Graph node IDs: `niche:<slug>`, `subniche:<slug>`, `channel:<UC…>`, `video:<id>`, `topic:<slug>`.
- Undirected edges store `sourceId < targetId`.

## YouTube collection (approval-gated)
- Corpus additions/refreshes ONLY via `services/expansion` proposals → approval → `enqueueExpansion` → services that
  call `authorizeJob` first. Never call `ingestChannel`/`syncChannel`/… without an approved proposal; never add
  a direct enqueue path. Tests: `approved(scope, user)` + `ctlFor(jobId)` in `tests/integration/helpers.ts`.
- Normalization + coverage: `src/server/youtube/normalize.ts`, `services/coverage`. Policy gates: `youtube/policy.ts`.
- Transcript reads must go through `visibleWhere`/`visibleSql`/`corpusWhere` (services/transcripts).
- Docs: `docs/COMPLIANCE_DECISIONS.md`, `docs/DEFERRED_AUDIT_FINDINGS.md`.

## Dynamic taxonomy
- `services/taxonomy`: `VideoNiche` evidence is authoritative; `ChannelNiche` is its projection (MANUAL wins).
  `TAXONOMY_MODE=dynamic` routes `classifyChannel` to projection and video embedding → `taxonomy-classify` queue.
- Category creation only under the advisory lock in `classifyVideos`/`bootstrapTaxonomy`. Demo cleanup only via the
  dry-run hash flow, and only with the owner's explicit approval.

## Gotchas
- HNSW indexes are partial: every KNN query must include `WHERE embedding IS NOT NULL`.
- tsvector columns are trigger-maintained — never write them from Prisma.
- `prisma migrate reset` is blocked for agents; use `pnpm db:reset` only with user consent.
- Never call `search.list` where a 1-unit call works; never call `captions.list` speculatively.
- Callbacks registered once in effects must use `useEffectEvent` (stale closures broke pin saving before).
- BullMQ custom job IDs cannot contain `:`.
