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
- [x] Phase 0 — Foundations (Next 16.4, Tailwind v4 tokens, ESLint module boundaries, Zod env, Prisma + hand-written SQL, withRoute, health). Drift-free.
- [x] Phase 1 — YouTube layer: live/fixture clients, costs.ts, quota buckets+lanes (Lua), cache (SWR), resolver, fixture generator (60 fictional channels), yt:probe.
- [x] Phase 2 — Ingestion & workers: BullMQ queues/processors, initial ingest, incremental sync, tiers/scheduler, stats, compliance, retries/quota delay, SSE with Last-Event-ID.
- [x] Phase 3 — Intelligence: embeddings (local MiniLM / hash / remote), transcripts (providers, VTT/SRT/TXT parse, chunking), TF-IDF topics + canonicalization, classification, optional AI.
- [x] Phase 4 — Graph: all edge kinds, provenance-exact incremental builds, Louvain, global/local traversal (Redis-cached by version), neighbors, delta, related creators, path.
- [x] Phase 5 — Search: keyword/fuzzy/semantic/hybrid (RRF), channel-scoped facets, transcript deep links. suggest ≈ 3 ms warm.
- [x] Phase 6 — Personal layer: workspaces/collections/items/views/layouts, export (JSON/CSV), account deletion, rate limits, security headers, IDOR tests.
- [ ] Phase 7 — Atlas UI
- [ ] Phase 8 — Pages
- [ ] Phase 9 — Polish, README, CI

Tests: 92 unit, 30 integration passing.

## Environment notes
- Node v24.22.2 + pnpm 12.18 at `~/.local/node` (not on default PATH; prefix commands).
- Docker via OrbStack.

## Known issues
- None yet.
