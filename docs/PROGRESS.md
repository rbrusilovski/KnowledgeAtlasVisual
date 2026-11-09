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
- [x] Phase 7 — Atlas UI: sigma 4 canvas, FA2 worker layout, hover-highlight, select, box-select, drag-to-pin (persisted),
  expand/collapse, context menu, filters via reducers (URL state), clustering labels, local mode, inspector, hover cards,
  ⌘K palette with search-to-focus, live graph deltas, list view, status bar.
- [x] Phase 8 — Pages: landing, sign-in, discover, channel, video, collections (+detail), search, settings, admin,
  privacy/terms templates, /dev/graph-bench.
- [x] Phase 9 — Polish & hardening: README, GitHub Actions CI, e2e (10/10), production build, client-bundle secret
  check (no secret values; only Better Auth's isomorphic env-getter references the name), hydration fixes,
  graph-bench 60 FPS at 5k/19k and 10k/38k (headless Chromium).

- [x] Spec-gap pass: default-layout + reduced-motion preferences wired; discover region/language; suggested
  subniches (service, admin UI, accept/dismiss, integration test); "Load demo dataset" action; SWR on UI reads;
  status bar last sync; bull-board proxy verified; Docker prod build fixed (placeholders at build time).

## Definition of Done
- [x] Fresh clone → README steps → working fixture-mode app with the demo dataset.
- [x] `YOUTUBE_MODE=live` + key uses the live client with no code changes (live client covered by unit tests; not run
      against the real API here — no key was available).
- [x] Atlas: zoom, pan, drag+pin (persisted), hover highlight, expand/collapse, clustering, filters, local mode, list
      view, hover cards, inspector.
- [x] Search: hybrid/keyword/semantic across types; within-channel; transcript hits deep-link to timestamps.
- [x] Collections, saved views, layouts persist per user and are isolated (IDOR tests).
- [x] Background sync on schedule, quota lanes, retries, pause on exhaustion, 30-day compliance (integration tests).
- [x] Real-time: newly ingested channels appear in an open atlas without reload (e2e).
- [x] Quota usage visible in the UI; costly actions confirm before spending searches.
- [x] No secrets in the client bundle.
- [x] typecheck, lint, test, test:integration, e2e, build all pass.

Tests: 92 unit, 32 integration, 10 Playwright e2e — all passing.

## Environment notes
- Node v24.22.2 + pnpm 12.18 at `~/.local/node` (not on default PATH; prefix commands).
- Docker via OrbStack.

## Known issues
- `scripts/db-reset.ts` and `scripts/embeddings-reindex.ts` are referenced in package.json but not written yet.
- Demo-data SIMILAR/CO_TOPIC edges are sparse at spec thresholds (see DECISIONS.md).
- Seed must run with the worker code available in-process (it does); first run downloads the MiniLM model (~23 MB).
