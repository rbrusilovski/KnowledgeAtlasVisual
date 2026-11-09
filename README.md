# Atlas — a YouTube knowledge atlas

Atlas is a dark, research-grade workspace built around an interactive graph that maps YouTube
**niches → subniches → channels → videos → topics**. Discover real channels with the YouTube Data API,
explore them in a zoomable WebGL graph, search across channels, videos and transcripts, and save findings into
collections — while the graph updates live as background ingestion finishes.

## Quickstart (fixture mode, no API keys)

Requires Node 24+, pnpm and Docker (Docker Desktop or OrbStack).

```bash
docker compose up -d postgres redis
pnpm install
cp .env.example .env   # then set BETTER_AUTH_SECRET and ENCRYPTION_KEY (openssl rand -base64 32)
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Open http://localhost:3000 and sign in as `demo@atlas.local` / `atlas-demo-1234`, or create an account.

`pnpm db:seed` loads the taxonomy and ingests the **fictional** demo dataset (`fixtures/youtube/`, 60 made-up
channels) through the real pipeline: ingestion → embeddings → topics → classification → graph. The first run
downloads the 23 MB MiniLM embedding model into `.cache/models`. The UI shows a **Demo data** badge in fixture mode.

## Collection is approval-gated

Nothing is added to or refreshed in the atlas without your explicit approval:

- **Add channel**, **Discover → Add**, **Sync**, **Load full history**, **Load demo dataset** and Claude/agent
  suggestions create an *expansion proposal* with an exact, bounded scope and a quota estimate.
- You review it (dialog, or **Data** page → *Waiting for approval*) and approve that exact scope once. The approval is
  re-checked by the queue producer and by the worker before any data is written; jobs never exceed their bounds.
- Scheduled syncs, statistics refreshes and the 30-day compliance refresh only *propose* (an admin approves).
  Compliance **deletion** never waits: unrefreshed API data is deleted at its retention deadline.
- The **Data** page shows field-level coverage (what's collected, unavailable on YouTube, stale, not requested),
  upload-history progress, retention deadlines, running jobs and quota.

`pnpm db:seed` approves the fictional demo load from the CLI (fixture mode only).

## Using real YouTube data

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, enable **YouTube Data API v3**,
   and create an **API key** (restrict it to that API and your server's IPs).
2. In `.env`: `YOUTUBE_MODE=live` and `YOUTUBE_API_KEY=…`.
   **Live collection stays disabled** until you record a decision in `docs/COMPLIANCE_DECISIONS.md` and set
   `YOUTUBE_LIVE_COLLECTION_ENABLED=true`. Cross-owner relationships and derived data have their own gates — the
   YouTube Developer Policies restrict aggregating data across content owners (III.E.2) and deriving new data
   (III.E.4.h). An API key alone enables nothing.
3. Restart `pnpm dev`. Discover channels on **/discover** or paste any channel/video URL in ⌘K → *Add channel by URL*.

No code changes are needed; fixture and live clients share the same pipeline.

### Quota cheat-sheet

All numbers live in `src/server/youtube/costs.ts`.

| Call | Cost | Used for |
|---|---|---|
| `channels.list` | 1 unit (up to 50 channels) | details, stats, handle/username resolution |
| `playlistItems.list` | 1 unit (50 uploads) | listing a channel's videos (never `search.list`) |
| `videos.list` | 1 unit (50 videos) | video metadata + stats |
| `channelSections.list` | 1 unit | featured channels |
| `search.list` | 1 call from the **search bucket** (100/day) — or 100 units with `QUOTA_SEARCH_MODEL=shared` | discovery only, after showing the cost |
| `captions.list` | 50 units | owner captions only (OAuth), never speculative |

- Ingesting a channel with 500 videos ≈ 1 + 10 + 10 + 1 = **22 units, zero searches**.
- An incremental sync stops at the first known upload: usually **2–3 units**.
- Quota resets at **midnight Pacific**. Background jobs stop at `QUOTA_BACKGROUND_RATIO` (60 %), keeping headroom for
  users. A real `quotaExceeded` pauses background jobs until the reset; users get `QUOTA_EXHAUSTED` with `resetAt`.
- Each user is limited to `DISCOVERY_SEARCHES_PER_USER_PER_DAY` searches. Repeated searches are cached for 24 h.

## Transcripts: what is and isn't possible

The official API only lets a channel's **owner** download its captions. Atlas therefore uses pluggable providers:

- **Owner captions** — private to the user whose connection authorized them; deleted immediately on disconnect.
  Connect your own channel under Settings (`FEATURE_YOUTUBE_OAUTH=true`, Google OAuth with the
  `youtube.force-ssl` scope; **this scope requires Google app verification in production**).
- **User upload** — paste or upload `.vtt`, `.srt` or plain text on any video page. **Private to the uploader**: only
  they can read or search it, and it never feeds shared topics, AI extraction or the graph.
- **Fixture** — synthetic transcripts for ~30 % of demo videos.
- **Third party** — an adapter *interface* only, disabled (`TRANSCRIPT_THIRD_PARTY_ENABLED=false`). If you plug one in,
  you are responsible for complying with YouTube's Terms of Service. Atlas ships no scraper.

The UI only claims a transcript exists when one is stored. A video without a transcript still counts as fully
collected — transcripts are one optional field group.

## Architecture

```
Next.js (web)  ── /api/** route handlers (withRoute: auth · zod · rate limit · error envelope)
   │            ── SSE /api/events ← Redis pub/sub (one subscriber per process)
   ▼
src/server/services/*   youtube · quota · cache · ingestion · transcripts · embeddings · classification
                        topics · graph · search · workspaces · realtime · compliance · ai · catalog
   │                                   │
PostgreSQL 17 + pgvector + pg_trgm    Redis 7: cache · quota · rate limits · BullMQ · pub/sub
   ▲                                   ▲
Worker (src/worker): BullMQ processors — ingest · sync · stats · transcripts · embed · topics · classify ·
                     graph-build · communities · ai-extract · compliance · scheduler (+ bull-board)
```

- The graph is **materialized** (`GraphNode`/`GraphEdge`) and rebuilt incrementally from "dirty" node IDs; every
  write takes a version from `graph_version_seq`, so clients fetch `/api/graph/delta?since=` on `graph.delta` events.
- Relations are explainable: featured channels, semantic similarity (pgvector), shared topics (weighted Jaccard),
  topic co-occurrence (NPMI), and co-discovery.
- Search fuses keyword (tsvector) and semantic (HNSW) rankings with reciprocal rank fusion.
- Stored API data is tracked per field group (`FieldCoverage`). A daily compliance job deletes data past its 30-day
  deadline and proposes an (approval-gated) refresh beforehand.

See `docs/DECISIONS.md` for the reasoning behind non-obvious choices and `CLAUDE.md` for a code map.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` | web + worker |
| `pnpm db:migrate` · `pnpm db:seed` · `pnpm db:reset --yes` | migrations · seed (`--no-ingest`, `--channels N`) · wipe + reseed |
| `pnpm fixtures:generate` | regenerate the fictional dataset (seeded, deterministic) |
| `pnpm yt:probe <url\|@handle>` | resolve a channel input and print the quota it cost |
| `pnpm graph:rebuild [--topics]` | full graph rebuild (optionally re-extract topics) |
| `pnpm embeddings:reindex` | re-embed everything after changing the provider |
| `pnpm typecheck` · `pnpm lint` | static checks |
| `pnpm test` · `pnpm test:integration` · `pnpm e2e` | unit · integration (Docker services) · Playwright |

## Tests

- **Unit** (`pnpm test`): resolver, quota math/lanes, VTT/SRT parsing and chunking, topic normalization, scoring, RRF,
  graph math, cursors, encryption, live client error mapping.
- **Integration** (`pnpm test:integration`): uses database `atlas_test` and Redis prefix `atlas-test` (created
  automatically); covers end-to-end ingestion, idempotency, incremental sync, quota pauses, search, graph limits,
  IDOR protection on every personal resource, rate limits and account deletion.
- **E2E** (`pnpm e2e`, after `pnpm exec playwright install chromium`): starts an isolated environment on port 3100
  (`atlas_e2e`, `.next-e2e`) seeded with 14 demo channels; covers signup, ⌘K focus, expand, drag-to-pin persistence,
  collections, live channel adds over SSE, discovery, channel search and transcript timestamps.

## Production

`docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build` runs `web`, `worker`, Postgres
and Redis with no published database ports, required secrets and Redis auth (`docker-compose.yml` is development
only). Set `BETTER_AUTH_URL` to your public URL, add OAuth credentials if wanted, and put `ADMIN_EMAILS` for `/admin`
access (queue dashboard at `/api/admin/queues`). Deploy/rollback, encrypted backups (`pnpm db:backup`), restore tests
(`pnpm db:restore-test`), alerts and recovery tools are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

**Claude**: create an agent token in Settings → Agent access and run `ATLAS_AGENT_TOKEN=atl_… pnpm mcp` (local stdio
MCP server). Claude can inspect coverage and propose expansions; only you can approve them on `/data`. `/privacy` and `/terms` are **templates** you must adapt.

YouTube data is shown with attribution and links back to YouTube. Atlas never downloads videos or scrapes YouTube pages.
