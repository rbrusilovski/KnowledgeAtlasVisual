# Progress

Source of truth: `BUILD_SPEC.md`. Phases follow §16.

## Plan
0. Foundations (Next 16, Tailwind v4, Prisma + custom SQL, env, withRoute, shell, CLAUDE.md)
1. YouTube layer (live + fixture client, costs, quota, cache, resolver, fixture generator, yt:probe)
2. Ingestion & workers (BullMQ queues/processors, sync tiers, scheduler, dedup, IngestionRun, SSE)
3. Intelligence (embeddings, transcripts, topics, classification, optional AI)
4. Graph (builder, edges, communities, traversal, delta, related creators)
5. Search (keyword, fuzzy, semantic, hybrid, channel-scoped)
6. Auth & personal layer (Better Auth, workspaces, collections, views, layouts, rate limits, export/delete)
7. Atlas UI (sigma canvas, layout worker, interactions, filters, inspector, ⌘K, live updates, list view)
8. Pages (discover, channel, video, collections, search, settings, admin, landing, legal)
9. Polish & hardening (motion, states, a11y, perf, README, CI)

## Status
- [x] Phase 0 — Foundations: Next 16.4 + TS strict, Tailwind v4 tokens, ESLint module boundaries, Prettier,
  Vitest/Playwright config, Docker Compose, Zod env, Prisma schema + hand-written SQL (triggers, GIN, partial HNSW,
  `graph_version_seq`), pino logger w/ request IDs, `withRoute`, Better Auth wiring, `/api/health`. Drift-free.
- [ ] Phase 1 — YouTube layer

## Environment notes
- Node v24.22.2 + pnpm 12.18 at `~/.local/node` (not on default PATH; prefix commands).
- Docker via OrbStack.

## Known issues
- None yet.
