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
- `pnpm fixtures:generate` · `pnpm yt:probe <url|@handle>` · `pnpm graph:rebuild` · `pnpm embeddings:reindex`

## Architecture map
- `src/app` pages + `/api/**` route handlers (all wrapped in `withRoute` from `src/server/http/withRoute.ts`).
- `src/server/{env,db,redis,logger,auth,session,crypto}.ts` — infrastructure singletons.
- `src/server/youtube/` — `YouTubeClient` (live | fixture), `costs.ts` (all quota numbers), resolver.
- `src/server/services/<name>/index.ts` — the ONLY public surface of a service (ESLint enforces).
- `src/worker/` — BullMQ worker process (separate Node process, same services).
- `src/shared/contracts/` — Zod schemas shared by route handlers and client fetchers.
- `src/components`, `src/lib` — client code; may not import `@/server/*` (ESLint enforces).

## Conventions
- API envelope `{ data, meta? }` / `{ error: { code, message, details? } }`; throw `AppError`.
- Prisma client import: `@/server/db` (generated to `src/generated/prisma`, gitignored).
- BigInt columns serialize as numbers via `jsonReplacer`.
- Graph node IDs: `niche:<slug>`, `subniche:<slug>`, `channel:<UC…>`, `video:<id>`, `topic:<slug>`.
- Undirected edges store `sourceId < targetId`.

## Gotchas
- HNSW indexes are partial: every KNN query must include `WHERE embedding IS NOT NULL`.
- tsvector columns are trigger-maintained — never write them from Prisma.
- `prisma migrate reset` is blocked for agents; use `pnpm db:reset` only with user consent.
- Never call `search.list` where a 1-unit call works; never call `captions.list` speculatively.
