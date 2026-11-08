# BUILD SPEC — "Atlas": a YouTube Knowledge Atlas

> **For Claude Code.** This document is the single source of truth for this project. Read it completely before writing any code. When this spec and your instincts disagree, follow the spec; when the spec is silent, make the most reasonable decision, record it in `docs/DECISIONS.md`, and keep going.

---

## 1. Mission

Build a production-quality web app called **Atlas**: a dark, premium research workspace centered on an interactive, Obsidian-style **Knowledge Atlas** — a zoomable, draggable graph that maps YouTube **niches → subniches → channels → videos → topics** as interconnected nodes.

Users can:

1. **Discover real channels** in a niche via the YouTube Data API v3 and add them to the atlas.
2. **Explore** the graph: zoom, pan, drag, hover-highlight neighborhoods, expand/collapse connections, cluster dynamically, filter, and open rich previews.
3. **Search** across channels, videos, topics and transcripts (keyword, fuzzy, semantic, hybrid), including search *within* a single channel's videos and transcripts.
4. **Save** nodes into persistent, authenticated **collections** inside **workspaces**, with notes, tags, saved views and pinned layouts.
5. Watch the graph **update in real time** as background ingestion finishes.

**Everything must work.** No static mockups, no hardcoded arrays in components, no buttons that do nothing, no `// TODO: implement` in core paths.

---

## 2. Operating rules (how you work)

1. **Plan, then execute autonomously.** Read the whole spec, write a short plan to `docs/PROGRESS.md`, create a todo list mirroring the phases in §16, then build. Do not stop to ask the user questions — decide, log the decision in `docs/DECISIONS.md` (one line each: decision, reason, alternative), and continue.
2. **Verify every phase before moving on.** Each phase ends with: `pnpm typecheck`, `pnpm lint`, the relevant tests, and actually running the thing (start the app/worker, hit endpoints with `curl`, check the UI with Playwright). Fix failures before starting the next phase.
3. **Commit after each phase** (`git init` first) using conventional commits, e.g. `feat(graph): add traversal API`.
4. **Keep `docs/PROGRESS.md` current**: what's done, what's next, known issues. If the session ends, the next session resumes from it.
5. **Check current docs before using a library API.** Versions move fast. Install the latest stable versions, read the installed package's docs/types, and don't rely on memory for APIs that changed recently (Next.js, Prisma, Better Auth, BullMQ, sigma.js, Tailwind, Zod).
6. **Write a concise `CLAUDE.md`** in Phase 0 (≤ 80 lines): commands, architecture map, conventions, gotchas. Do *not* paste this spec into it.
7. **Use subagents** for well-isolated work (test suites, fixture generation, a single page) if available; keep architecture and cross-cutting decisions in the main thread.
8. **Never fake data as real.** The only non-YouTube data allowed is the clearly labeled demo fixture dataset (§7.1), which still flows through the real ingestion pipeline.
9. **Never commit secrets.** `.env*` is gitignored; `.env.example` documents every variable.

---

## 3. Ground truths about the YouTube Data API (design around these)

These facts were verified against Google's documentation in November 2026. Put the cost numbers in **one config file** (`src/server/youtube/costs.ts`) so they're easy to update.

| Fact | Design consequence |
|---|---|
| Default allocation: **10,000 units/day** shared by most endpoints. `search.list` (and `videos.insert`) have their **own quota buckets**; `search.list` is limited to **100 calls/day**. (Older docs say `search.list` costs 100 units from the shared pool — support both models via config.) | The quota manager tracks **multiple buckets**. Search is the scarcest resource — treat every search as precious. |
| `channels.list`, `videos.list`, `playlistItems.list`, `channelSections.list`, `videoCategories.list` cost **1 unit**. `captions.list` costs **50 units**. Invalid requests still cost at least 1 unit. | Validate inputs before calling. Never call `captions.list` speculatively. |
| Quota resets at **midnight Pacific Time**. | Quota keys are dated in `America/Los_Angeles`. |
| Never use `search.list` to list a channel's videos. Use `channels.list` → `contentDetails.relatedPlaylists.uploads` → `playlistItems.list` (50/page) → `videos.list` (batches of 50 IDs). | Ingesting a channel with 500 videos costs ≈ 1 + 10 + 10 + 1 ≈ **22 units** and **zero** searches. |
| `search.list`'s `relatedToVideoId` was **removed in 2023**. There is no "related channels" endpoint. | "Related creators" must be **inferred** (featured channels via `channelSections.list`, shared topics, semantic similarity, co-discovery). Make relations **explainable**. |
| `captions.download` only works for videos **owned by the authorized user** (OAuth). Transcripts of arbitrary channels are **not** available through the official API. | Transcripts come from **pluggable providers** (§7.3). The UI only says "transcript available" when one is actually stored. |
| YouTube API Developer Policies: stored API data must be **refreshed or deleted within 30 days**; users must be able to delete their data. | A daily compliance job refreshes/deletes stale records (§7.11). Account deletion is real. |
| Channel handles resolve cheaply with `channels.list?forHandle=` (1 unit). Legacy `/user/` names via `forUsername`. `/c/custom` URLs have no direct lookup. | URL resolver tries cheap paths first; falls back to search only with explicit user confirmation. |

Also: always link back to YouTube, show YouTube attribution where API data is displayed, never download video files, never scrape YouTube HTML by default.

---

## 4. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js current Active LTS (24+), **pnpm** |
| Framework | **Next.js 16** (App Router, Route Handlers, TypeScript `strict`, Turbopack) — check docs for the installed minor (e.g. request interception lives in `proxy.ts` in v16) |
| UI | **Tailwind CSS v4** (CSS-first `@theme` tokens), **shadcn/ui** (Radix) restyled with our tokens, **lucide-react**, **motion** (formerly Framer Motion), **cmdk**, **sonner** |
| Graph rendering | **sigma.js** (latest stable major, WebGL) + **graphology** + `@react-sigma/core`, `graphology-layout-forceatlas2` (**web worker**), `graphology-layout-noverlap`, `graphology-communities-louvain`, `@sigma/node-image`, `@sigma/node-border`. If `@react-sigma/core` or the `@sigma/*` programs don't yet support sigma's newest major, pin sigma to the major they support and log it in `DECISIONS.md` |
| Client state | **TanStack Query** (server state), **Zustand** (UI state), **nuqs** (URL state for focus/filters so views are linkable) |
| Validation | **Zod** — shared contracts in `src/shared/contracts/` used by route handlers *and* client fetchers |
| DB | **PostgreSQL 17** + **pgvector** + **pg_trgm** (Docker image `pgvector/pgvector:pg17`) |
| ORM | **Prisma ORM** (latest stable; follow its current config/driver-adapter setup). Vectors/tsvectors via `Unsupported(...)` + typed raw SQL |
| Cache / queues | **Redis 7** + **ioredis** + **BullMQ** (use Job Schedulers, i.e. `upsertJobScheduler`, for recurring jobs) |
| Auth | **Better Auth** with the Prisma adapter (Auth.js is now maintained by the Better Auth team, which recommends Better Auth for new projects). Email+password, GitHub and Google OAuth |
| Embeddings | Default: **local** `@huggingface/transformers` in the worker, `Xenova/all-MiniLM-L6-v2` (384-d, mean-pooled, normalized) — works with zero API keys. Pluggable remote provider |
| Optional AI | **Anthropic TypeScript SDK**, model from `ANTHROPIC_MODEL` (default `claude-haiku-5-5`), only when `ANTHROPIC_API_KEY` is set |
| Logging | **pino** (structured, request IDs) |
| Testing | **Vitest** (unit + integration), **Playwright** (e2e), **MSW** where HTTP mocking is needed |
| Queue UI | **bull-board** mounted on an admin-only route |

---

## 5. Architecture

```
┌──────────────────────────── Next.js app (web) ─────────────────────────────┐
│  App Router pages (atlas, discover, channel, video, collections, search…)  │
│  Route Handlers  /api/**  →  withRoute(): auth · zod · rate-limit · errors │
│  SSE /api/events  ←── Redis pub/sub (one subscriber per process, fan-out)  │
└───────────────┬───────────────────────────────────────────┬────────────────┘
                │ imports services (read paths + enqueue)   │
┌───────────────▼──────────── src/server/services ──────────▼────────────────┐
│ youtube  quota  cache  ingestion  transcripts  embeddings  classification  │
│ topics   graph  search  dedup     workspaces   realtime    compliance  ai  │
└───────────────┬───────────────────────────────────────────┬────────────────┘
                │                                           │
        ┌───────▼───────┐                          ┌────────▼────────┐
        │  PostgreSQL   │                          │      Redis      │
        │ pgvector/trgm │                          │ cache·quota·rl  │
        │ tsvector/GIN  │                          │ BullMQ·pub/sub  │
        └───────▲───────┘                          └────────▲────────┘
                │                                           │
┌───────────────┴──────────── Worker process (src/worker) ──┴────────────────┐
│ BullMQ workers: ingest · sync · stats · transcripts · embed · classify ·  │
│ topics · graph-build · communities · ai-extract · compliance · scheduler  │
└────────────────────────────────────────────────────────────────────────────┘
```

**Single package, strict module boundaries.** Each service lives in `src/server/services/<name>/` and exposes only `index.ts`. Services never import another service's internals (enforce with ESLint `no-restricted-imports` or dependency-cruiser). The worker is a separate Node process (`tsx src/worker/index.ts`) that imports the same services. Route handlers use the Node runtime (not edge).

```
src/
  app/                    # pages + /api route handlers
  components/             # ui/ (shadcn), atlas/, inspector/, layout/, …
  lib/                    # client utilities, fetchers, hooks
  shared/contracts/       # zod schemas + inferred types (client+server)
  server/
    env.ts                # zod-validated env (server/client split)
    db.ts  redis.ts  logger.ts  auth.ts
    http/withRoute.ts     # auth, validation, rate limit, error envelope
    youtube/              # client (live + fixture), costs, schemas
    services/<name>/
  worker/                 # entrypoint, queues, processors, schedulers
prisma/                   # schema + migrations (incl. hand-written SQL)
fixtures/youtube/         # generated demo dataset (API-shaped JSON)
scripts/                  # fixtures:generate, yt:probe, graph:rebuild, …
tests/  e2e/  docs/
```

---

## 6. Data model

Sketch — refine as needed, but keep the concepts. All YouTube IDs are unique. Undirected edge kinds store `sourceId < targetId` (canonical order).

```prisma
enum SyncTier   { HOT WARM COLD }
enum NodeType   { NICHE SUBNICHE CHANNEL VIDEO TOPIC }
enum EdgeKind   { CONTAINS IN_NICHE PUBLISHED MENTIONS CHANNEL_TOPIC
                  FEATURED SIMILAR CO_TOPIC TOPIC_RELATED NICHE_TOPIC CO_DISCOVERED }
enum ClassMethod { RULES EMBEDDING AI MANUAL }
enum TranscriptSource { OWNER_CAPTIONS USER_UPLOAD THIRD_PARTY }

model Channel {
  id String @id @default(cuid())
  youtubeId String @unique            // UC…
  handle String? @unique              // lowercased, no @
  title String
  description String @default("")
  customUrl String?
  country String?
  publishedAt DateTime?
  thumbnailUrl String?
  keywords String[]
  topicCategories String[]            // Wikipedia URLs from topicDetails
  subscriberCount BigInt?
  hiddenSubscriberCount Boolean @default(false)
  videoCount Int?
  viewCount BigInt?
  uploadsPlaylistId String?
  etag String?
  syncTier SyncTier @default(WARM)
  lastSyncedAt DateTime?
  lastStatsAt DateTime?
  lastRefreshedAt DateTime?           // compliance clock
  latestVideoAt DateTime?
  backfillPageToken String?
  isAvailable Boolean @default(true)
  embedding Unsupported("vector(384)")?
  searchVector Unsupported("tsvector")?
  videos Video[]
  niches ChannelNiche[]
  aliases ChannelAlias[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model ChannelAlias { id String @id @default(cuid()); channelId String; kind String; value String @unique }

model Video {
  id String @id @default(cuid())
  youtubeId String @unique
  channelId String
  title String
  description String @default("")
  publishedAt DateTime
  durationSec Int?
  tags String[]
  categoryId String?
  defaultLanguage String?
  thumbnailUrl String?
  viewCount BigInt?
  likeCount BigInt?
  commentCount BigInt?
  isShort Boolean @default(false)
  etag String?
  lastStatsAt DateTime?
  lastRefreshedAt DateTime?
  isAvailable Boolean @default(true)
  hasTranscript Boolean @default(false)
  embedding Unsupported("vector(384)")?
  searchVector Unsupported("tsvector")?
  @@index([channelId, publishedAt(sort: Desc)])
}

model Transcript      { id; videoId @unique; source TranscriptSource; language; isAutoGenerated Boolean; contentHash; fetchedAt; chunks TranscriptChunk[] }
model TranscriptChunk { id; transcriptId; idx Int; startSec Float; endSec Float; text; embedding vector(384)?; searchVector tsvector?; @@unique([transcriptId, idx]) }

model Niche        { id; slug @unique; name; description; keywords String[]; discoveryQueries String[]; parentId String?; depth Int; centroid vector(384)?; channelCount Int @default(0) }
model ChannelNiche { channelId; nicheId; confidence Float; method ClassMethod; rationale String?; @@id([channelId, nicheId]); @@index([nicheId, confidence]) }
model Topic        { id; slug @unique; label; aliases String[]; videoCount Int; channelCount Int; embedding vector(384)?; searchVector tsvector? }
model VideoTopic   { videoId; topicId; weight Float; source String; @@id([videoId, topicId]); @@index([topicId, weight]) }

// Materialized graph — the traversal layer
model GraphNode { id String @id /* "channel:UC…" */; type NodeType; refId String; label String; size Float; communityId Int?; attrs Json; version BigInt; updatedAt DateTime; @@unique([type, refId]) }
model GraphEdge { id String @id; sourceId String; targetId String; kind EdgeKind; weight Float; evidence Json?; version BigInt; updatedAt DateTime
                  @@unique([sourceId, targetId, kind]); @@index([sourceId, kind, weight]); @@index([targetId, kind]) }

// Personal layer
model Workspace      { id; ownerId; name; description?; collections; savedViews; layouts; createdAt; updatedAt }
model Collection     { id; workspaceId; name; description?; color; icon; sortOrder Int; items CollectionItem[] }
model CollectionItem { id; collectionId; nodeId; note String?; tags String[]; addedAt; @@unique([collectionId, nodeId]) }
model SavedView      { id; workspaceId; name; state Json /* filters, focus, mode, camera */; createdAt }
model NodeLayout     { workspaceId; nodeId; x Float; y Float; pinned Boolean; @@id([workspaceId, nodeId]) }

// Ops
model DiscoveryQuery   { id; userId?; query; nicheId?; resultChannelIds String[]; createdAt }
model IngestionRun     { id; kind; targetId; status; unitsUsed Int; searchCalls Int; startedAt; finishedAt?; error?; stats Json }
model YouTubeConnection{ id; userId @unique; googleSub; channelIds String[]; accessTokenEnc; refreshTokenEnc; scope; expiresAt }
model AiExtraction     { id; targetType; targetId; contentHash; model; output Json; tokensIn Int; tokensOut Int; createdAt; @@unique([targetType, targetId, contentHash]) }
// + Better Auth tables (User with role USER|ADMIN, Session, Account, Verification) — generate with Better Auth's CLI for the Prisma adapter.
```

**Hand-written SQL migration** (create with `prisma migrate dev --create-only`, then edit):

- `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;`
- `tsvector` maintenance for Channel (title A, handle A, keywords B, description C), Video (title A, tags B, description C), TranscriptChunk, Topic (label A, aliases B). **Prefer trigger-maintained columns** over `GENERATED ALWAYS` if Prisma's migration diffing fights generated columns. After the custom migration, `prisma migrate dev` must report **no drift**.
- GIN indexes on every `searchVector`; GIN `gin_trgm_ops` on `Channel.title`, `Channel.handle`, `Topic.label`, `Video.title`.
- HNSW indexes (`vector_cosine_ops`) on all embedding columns.
- Sequence `graph_version_seq` — every graph write takes `nextval` as its `version`.
- Helper `src/server/db/vector.ts`: serialize `number[]` → `'[…]'::vector`, typed `$queryRaw` wrappers for KNN.

---

## 7. Services

### 7.1 YouTube layer — `src/server/youtube/`

- **`YouTubeClient` interface** with two implementations selected by `YOUTUBE_MODE=live|fixture`:
  - `LiveYouTubeClient`: thin typed `fetch` client against `https://www.googleapis.com/youtube/v3/*`. Use `part` and `fields` partial responses to minimize payload. Zod-parse only the fields we use. Never expose the key to the browser.
  - `FixtureYouTubeClient`: reads API-shaped JSON from `fixtures/youtube/`. Responses are byte-compatible with real shapes so the **same pipeline** runs.
- **Fixture generator** (`pnpm fixtures:generate`, seeded RNG): ~60 **clearly fictional** channels (no real creators) across the seed taxonomy, 20–60 videos each with realistic titles, descriptions, tags, durations, stats, `topicCategories`, some `channelSections` featuring each other, and synthetic VTT transcripts for ~30% of videos (served by a fixture transcript provider). IDs follow real formats (`UC` + 22 chars; 11-char video IDs). Avatars/thumbnails are deterministic generated SVGs from `/api/placeholder/[kind]/[seed]` — no external images in fixture mode. The UI shows a subtle **"Demo data"** badge whenever fixture mode is on.
- **Methods**: `getChannels(ids|forHandle|forUsername)`, `getPlaylistItems(playlistId, pageToken)`, `getVideos(ids[≤50])`, `getChannelSections(channelId)`, `searchChannels({q, regionCode?, relevanceLanguage?, maxResults})`, `listCaptions(videoId)` (OAuth only).
- **URL/handle resolver** (`resolveChannelInput`): accepts `UC…` IDs, `@handle`, `youtube.com/@handle`, `/channel/UC…`, `/user/name`, `/c/custom`, video URLs (→ video's channel), `youtu.be` links. Cheap paths first; `/c/custom` requires a search and the API returns `needsConfirmation: { cost }` instead of silently spending it. Cache resolutions in `ChannelAlias` + Redis.

### 7.2 Quota manager & cache — `services/quota`, `services/cache`

- Buckets from config: `general` (10,000 units/day) and `search` (100 calls/day), keyed `quota:{bucket}:{YYYY-MM-DD@America/Los_Angeles}`.
- `reserve(bucket, cost, lane)` — atomic Lua check-and-increment; lanes: `interactive` (user-initiated) and `background`. Background is denied once usage exceeds `QUOTA_BACKGROUND_RATIO` (default 0.6), reserving headroom for users.
- On a real `403 quotaExceeded`: mark the bucket exhausted until reset, pause background queues (delay jobs until reset), return `QUOTA_EXHAUSTED` with `resetAt` to the client.
- Every call is logged with its cost into the current `IngestionRun` and a per-day Redis tally; `/api/quota` exposes usage per bucket.
- **Response cache**: Redis, key = method + normalized params hash. TTLs: search 24h, channel details 6h, first page of uploads 30m, video stats 6h. Stale-while-revalidate for reads that power UI.
- **Per-user fairness**: discovery searches are also capped per user per day (`DISCOVERY_SEARCHES_PER_USER_PER_DAY`, default 20) so one user can't drain the project quota.

### 7.3 Transcripts — `services/transcripts`

`TranscriptProvider` interface: `isAvailable(video)`, `fetch(video) → { language, isAutoGenerated, cues[] }`.

- `OwnerCaptionsProvider`: for channels the user has connected via Google OAuth (`youtube.force-ssl` scope). Uses `captions.list` (50 units) + `captions.download`. Behind `FEATURE_YOUTUBE_OAUTH=true` (this scope needs Google verification in production — note it in the README).
- `UserUploadProvider`: user uploads/pastes `.vtt`, `.srt` or plain text (with optional timestamps) on the video page.
- `FixtureTranscriptProvider`: serves fixture VTTs.
- `ThirdPartyProvider`: an adapter **interface only**, disabled by default (`TRANSCRIPT_THIRD_PARTY_ENABLED=false`), with a README note that the operator is responsible for compliance with YouTube's Terms. Do not implement HTML scraping.
- Parsing: robust VTT/SRT parsers (unit-tested), normalize whitespace, merge cues into ~250–400-token chunks with 15% overlap, keep `startSec/endSec`. Store `contentHash` to skip unchanged re-imports. Deep links: `https://www.youtube.com/watch?v={id}&t={floor(startSec)}s`.

### 7.4 Embeddings — `services/embeddings`

- `EmbeddingProvider` interface `{ dimensions, embed(texts[]) }`. Default local transformers.js pipeline runs **in the worker only** (lazy-loaded singleton, batched). Boot-time check: `provider.dimensions === EMBEDDING_DIM` or fail fast. Changing provider/dimension requires a migration + `pnpm embeddings:reindex`.
- Text recipes: channel = title + handle + description + keywords + top 20 recent video titles; video = title + tags + first 1,000 chars of description; topic = label + aliases; chunk = text. Cache by content hash.
- The web process embeds **search queries** via a small worker RPC (BullMQ job with `waitUntilFinished`, ≤ 2s timeout) or an in-process lazy model — choose one, document it, and make semantic search degrade gracefully to keyword search if embedding is unavailable.

### 7.5 Niche classification — `services/classification`

- **Seed taxonomy** (`prisma/seed/taxonomy.ts`): ≥ 10 top-level niches with 4–6 subniches each, each with description, 15–30 keywords and 3 `discoveryQueries`. Minimum set: Technology (Programming tutorials, AI & ML, Consumer tech reviews, Cybersecurity, DevOps & cloud), Science & Education (Physics, Math, Biology, History, Space), Finance & Business (Personal finance, Investing, Entrepreneurship, Real estate), Gaming (Let's plays, Esports, Game dev, Retro, Speedrunning), Health & Fitness (Strength training, Running, Nutrition, Yoga & mobility), Food (Recipes, Baking, Food science, Restaurant reviews), Creative (Music production, Illustration, Filmmaking, Photography, Design), Lifestyle (Travel, Productivity, Minimalism, Fashion), DIY & Trades (Woodworking, Home improvement, Auto repair, Electronics, Gardening), Entertainment (Commentary, Comedy, Film analysis, Podcasts), Sports (Football, Basketball, Combat sports, Outdoor & adventure).
- **Scoring** per (channel, subniche): `0.55·embedding_cosine(channel, centroid) + 0.25·keyword_score(BM25-ish over channel text) + 0.20·topicCategory_match` (map Wikipedia topic URLs → niches in a config table). Multi-label: assign up to 3 subniches above `CLASSIFY_MIN_CONFIDENCE` (default 0.35); always assign the best one, flagged low-confidence if below threshold.
- Centroids start from the subniche description+keywords embedding and update as a running mean of confidently assigned channels.
- If AI is enabled, re-rank low-confidence cases with a structured-output prompt; store `rationale`.
- **Manual overrides** (`method=MANUAL`) always win and survive reclassification.
- Stretch: "Suggested subniches" — Louvain over the SIMILAR graph among low-confidence channels, shown in the UI for the user to accept and name.

### 7.6 Topic extraction — `services/topics`

- Without AI: candidate keyphrases (1–3-grams) from titles, tags, descriptions and transcript chunks; stopword filtering; light normalization (lowercase, strip punctuation, singularize simple plurals); TF-IDF against the corpus; keep top 8 per video with weights.
- **Canonicalization/dedup**: merge candidates when trigram similarity ≥ 0.8 **or** embedding cosine ≥ 0.9; the merged topic keeps `aliases`. Only materialize a Topic node once it appears in ≥ 2 videos.
- With AI (optional): per-video extraction of topics/entities/key claims + a 2-sentence summary as structured JSON, cached in `AiExtraction` by content hash, with a daily token budget (`AI_DAILY_TOKEN_BUDGET`).

### 7.7 Graph builder — `services/graph`

Edges (weights normalized 0–1, `evidence` JSON explains *why*):

| Kind | From → To | Rule |
|---|---|---|
| CONTAINS | niche → subniche | taxonomy |
| IN_NICHE | subniche → channel | classification confidence |
| PUBLISHED | channel → video | ownership |
| MENTIONS | video → topic | topic weight |
| CHANNEL_TOPIC | channel → topic | aggregated, top 15 per channel |
| NICHE_TOPIC | subniche → topic | top 10 topics per subniche |
| FEATURED | channel → channel | `channelSections` featured channels (weight 1.0) |
| SIMILAR | channel ↔ channel | embedding cosine ≥ 0.75, top 10 per channel via pgvector KNN |
| CO_TOPIC | channel ↔ channel | weighted Jaccard over topics ≥ 0.2, top 10 |
| TOPIC_RELATED | topic ↔ topic | co-occurrence PMI, top 10 |
| CO_DISCOVERED | channel ↔ channel | appeared together in discovery results (weak, 0.2) |

- **Incremental**: ingestion emits "dirty" node IDs; `graph-build` recomputes only affected nodes' edges, upserts with a new `version`, deletes stale edges, then publishes a `graph.delta` event. `pnpm graph:rebuild` does a full rebuild.
- **Communities**: a `communities` job runs Louvain (graphology) over channel/topic nodes after significant change (debounced), stores `communityId`.
- **Traversal**: bounded BFS (iterative SQL per hop, or recursive CTE) with depth ≤ 3, per-hop fan-out top-k by weight, and a global node limit; cache subgraph responses in Redis keyed by params hash + current graph version.
- **Default global view** = niches + subniches + channels + top topics (no videos). Videos appear by expanding a channel or topic.
- **Related creators** endpoint merges FEATURED/SIMILAR/CO_TOPIC/CO_DISCOVERED into one ranked list with human-readable reasons ("Featured by X", "Shares topics: a, b, c", "Semantic similarity 0.82").
- Stretch: `GET /api/graph/path?from&to` — "how are these two connected?" (bounded bidirectional BFS).

### 7.8 Search — `services/search`

- **Keyword**: `websearch_to_tsquery('english', q)` over `searchVector`s, ranked by `ts_rank_cd` with small recency/popularity boosts; `ts_headline` highlights.
- **Fuzzy/autocomplete**: `pg_trgm` similarity on titles, handles, topic labels and niche names; target < 50 ms.
- **Semantic**: embed query → HNSW KNN (`<=>`) per entity type; transcript hits group by video and return best chunks with timestamps.
- **Hybrid** (default): Reciprocal Rank Fusion (k = 60) of keyword + semantic lists.
- **Channel-scoped**: same engine with `channelId` filter + facets: date range, duration buckets (Shorts/<10m/10–30m/>30m), view range, has-transcript, sort (relevance/recent/views).
- Results are typed (`channel | video | topic | transcript | niche`), each with its `nodeId` so the UI can "show in atlas".

### 7.9 Deduplication — `services/dedup`

Unique constraints + upserts everywhere; `ChannelAlias` for every URL form seen; video writes skipped when the API `etag` is unchanged; topic canonicalization (§7.6); **BullMQ deterministic job IDs** (e.g. `ingest:channel:UC…`) so duplicate requests coalesce, plus a short Redis lock around ingestion of the same channel.

### 7.10 Realtime — `services/realtime`

- `GET /api/events` is **Server-Sent Events** from a Route Handler (`text/event-stream`, heartbeat every 25 s, `Last-Event-ID` support via a short Redis stream buffer).
- One Redis subscriber connection per web process fans out in-process to connected clients.
- Channels: `events:user:{id}` and `events:global`. Event types: `job.progress`, `job.completed`, `job.failed`, `graph.delta` (`{ fromVersion, toVersion, nodeIds }`), `quota.updated`.
- Client: on `graph.delta`, fetch `GET /api/graph/delta?since=` and merge into the in-memory graphology instance with enter animations.

### 7.11 Sync scheduler & compliance — `services/ingestion`, `services/compliance`

- **Initial ingest**: channel details → uploads playlist newest-first up to `INGEST_MAX_VIDEOS_PER_CHANNEL` (default 300) → videos.list batches → channelSections → transcripts (if a provider applies) → embed → topics → classify → graph-build. Progress events at each step. "Load full history" continues from `backfillPageToken`.
- **Incremental sync**: page the uploads playlist newest-first and **stop at the first known video ID** (usually 1 unit).
- **Tiers**: HOT (in any collection or viewed in last 7 days) every 6 h; WARM daily; COLD weekly. A scheduler job every 15 min enqueues due channels within the background quota budget.
- **Stats refresh**: batch `videos.list` for recent videos per tier.
- **Compliance (daily)**: any API-derived record with `lastRefreshedAt` older than 27 days is refreshed (or deleted if the budget can't cover it); videos/channels no longer returned by the API are deleted, with graph cleanup.
- **Retries**: BullMQ `attempts: 5`, exponential backoff with jitter for 5xx/429/network errors; no retry for 4xx (except 429); `quotaExceeded` → delay until reset. Failed jobs retained and visible in admin.

---

## 8. Queues

| Queue | Payload | Job ID | Lane | Concurrency |
|---|---|---|---|---|
| `ingest-channel` | `{ youtubeId, requestedBy?, full? }` | `ingest:{youtubeId}` | interactive/background | 3 |
| `sync-channel` | `{ channelId }` | `sync:{channelId}:{date-hour}` | background | 5 |
| `refresh-stats` | `{ videoIds[≤50] }` | hash of IDs | background | 5 |
| `fetch-transcript` | `{ videoId, provider }` | `tx:{videoId}` | background | 2 |
| `embed` | `{ entity, ids[] }` | hash | — | 1 (CPU-bound) |
| `extract-topics` | `{ videoIds[] }` | hash | — | 2 |
| `classify-channel` | `{ channelId }` | `cls:{channelId}` | — | 4 |
| `graph-build` | `{ dirtyNodeIds[] }` | debounced | — | 1 |
| `communities` | `{}` | singleton, debounced | — | 1 |
| `ai-extract` | `{ targetType, targetId }` | `ai:{type}:{id}:{hash}` | — | 2 |
| `compliance` / `scheduler` | `{}` | job schedulers | background | 1 |

Graceful shutdown on SIGTERM; each processor updates its `IngestionRun`.

---

## 9. REST API

**Conventions**: JSON; success `{ data, meta? }`; errors `{ error: { code, message, details? } }` with codes `VALIDATION_ERROR | UNAUTHORIZED | FORBIDDEN | NOT_FOUND | CONFLICT | RATE_LIMITED | QUOTA_EXHAUSTED | NEEDS_CONFIRMATION | UPSTREAM_ERROR | INTERNAL`; opaque cursor pagination (`limit` ≤ 100); every handler wrapped in `withRoute({ auth, input, rateLimit })`; Zod contracts shared with the client; `429` includes `Retry-After`. Expose `GET /api/openapi.json` generated from the Zod contracts if a maintained Zod→OpenAPI library supports the installed Zod version.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/discover/channels` | ✓ | YouTube search for channels `{ query, nicheId?, regionCode?, maxResults }` → enriched results (stats via channels.list), flags already-in-atlas, returns quota used |
| `POST /api/discover/niche/:nicheId` | ✓ | Run a subniche's `discoveryQueries` (confirm cost first: returns `NEEDS_CONFIRMATION` unless `confirm: true`) |
| `POST /api/channels` | ✓ | Add by URL/handle/ID → resolve, enqueue ingest → `{ channel?, jobId }` |
| `GET /api/channels` | – | List/filter (niche, subscriber range, sort, cursor) |
| `GET /api/channels/:id` | – | Detail DTO (stats, niches with confidence, top topics, latest videos) |
| `GET /api/channels/:id/videos` | – | Search/filter within a channel (q, sort, date, duration, views, hasTranscript) |
| `GET /api/channels/:id/related` | – | Ranked related creators with reasons |
| `POST /api/channels/:id/sync` | ✓ | Manual sync `{ full? }` |
| `PATCH /api/channels/:id/niches` | ✓ | Manual niche override |
| `GET /api/videos/:id` | – | Detail |
| `GET /api/videos/:id/transcript` | – | Chunks + optional in-transcript search `?q=` |
| `POST /api/videos/:id/transcript` | ✓ | Upload VTT/SRT/TXT |
| `POST /api/videos/:id/extract` | ✓ | AI extraction (if enabled) |
| `GET /api/niches` · `GET /api/niches/:id` | – | Tree with counts · top channels/topics |
| `GET /api/topics` · `GET /api/topics/:id` | – | List/search · videos & channels |
| `GET /api/search` | – | `q, mode=hybrid|keyword|semantic, types, channelId, cursor` |
| `GET /api/search/suggest` | – | Autocomplete for the command palette |
| `GET /api/graph` | – | Subgraph: `mode=global|local, focus, depth, nodeTypes, edgeKinds, nicheIds, minWeight, minSubscribers, maxSubscribers, publishedAfter, limit` → `{ version, nodes, edges, truncated }` |
| `GET /api/graph/nodes/:nodeId/neighbors` | – | Expand: `edgeKinds, limit, cursor` |
| `GET /api/graph/delta` | – | `since=version` → upserted nodes/edges + removed IDs |
| `GET/POST /api/workspaces`, `GET/PATCH/DELETE /api/workspaces/:id` | ✓ | Workspaces (first one auto-created on signup) |
| `GET/POST /api/workspaces/:id/collections`, `GET/PATCH/DELETE /api/collections/:id` | ✓ | Collections |
| `POST/DELETE /api/collections/:id/items`, `PATCH /api/collections/:id/items/:itemId` | ✓ | Bulk add/remove, notes/tags |
| `GET /api/collections/:id/export?format=json|csv` | ✓ | Export |
| `GET/POST /api/workspaces/:id/views`, `PATCH/DELETE /api/views/:id` | ✓ | Saved views |
| `PUT /api/workspaces/:id/layout` | ✓ | Batch upsert pinned node positions |
| `GET /api/events` | opt. | SSE stream |
| `GET /api/jobs/:id` · `GET /api/quota` · `GET /api/health` | – | Ops |
| `GET /api/me/export` · `DELETE /api/me` | ✓ | Data export · account + data deletion |
| `GET /api/youtube/connect` · callback · `DELETE /api/youtube/connection` | ✓ | Optional OAuth for owner captions |

**Rate limits** (Redis sliding window, all configurable): anonymous 60 req/min/IP; authenticated 300 req/min/user; discovery 10/min and the per-user daily cap; channel adds 30/hour/user; AI extraction 50/day/user.

**Authorization**: every workspace/collection/view/layout query is scoped by owner. Write IDOR tests.

---

## 10. Frontend

### 10.1 Shell

- **Top bar** (48 px): wordmark "Atlas", workspace switcher, command palette trigger (⌘K / Ctrl+K), quota meter (general units + searches left, with reset time tooltip), live indicator (SSE connected), "Demo data" badge in fixture mode, user menu.
- **Left sidebar** (collapsible 280 px ↔ 56 px rail, `[` to toggle): Explore (niche tree with channel counts; click = focus), Collections (drop target), Saved Views, Filters.
- **Center**: the atlas canvas.
- **Right inspector** (collapsible 380 px, `]` to toggle): tabs Overview · Videos · Topics · Related · Notes.
- **Bottom-left graph controls**: zoom ±, fit, layout play/pause, color by (type / niche / community), labels (auto/all/none), node size by (subscribers / views / degree), global ↔ local mode, list view toggle.
- **Bottom status bar**: running jobs with progress, last sync, graph node/edge counts.

### 10.2 Atlas canvas (sigma.js + graphology)

- Keep the graphology instance **outside React render** (ref or store); React only drives settings/reducers.
- **Interactions**: wheel/pinch zoom, drag-pan, **drag nodes** (dragging pins the node and persists its position to the workspace layout, debounced), hover highlights node + neighbors and fades everything else to ~10% (Obsidian feel), click selects + opens inspector, double-click **expands** (fetch neighbors, animate new nodes in from the parent's position), context menu (Expand by edge kind ▸, Collapse, Hide, Pin/Unpin, Add to collection ▸, Find similar, Open on YouTube, Copy link), shift-click / box-select for multi-select with bulk actions.
- **Layout**: ForceAtlas2 in a web worker, auto-stops on convergence; resumes briefly after expansions; pinned nodes stay fixed; noverlap pass on settle.
- **Clustering**: color by community or niche; cluster labels rendered as an HTML overlay at the community centroid when zoomed out; labels for individual nodes appear by zoom level and node size.
- **Filters** (applied with sigma reducers — no graph rebuild, instant): node types, edge kinds, niches, subscriber range, upload recency, min edge weight, has-transcript, collection membership. Filter state lives in the URL.
- **Local graph mode**: N-hop neighborhood of the selection only (depth slider 1–3).
- **Search-to-focus**: choosing a result in ⌘K flies the camera to the node (loading it if absent).
- **Hover card** (300 ms delay) for channels: avatar, title, subscribers, niche chips, 3 latest thumbnails.
- **List view**: an accessible table of the currently visible nodes (sortable), synchronized with selection — also the a11y alternative to the canvas.
- **Performance**: smooth interaction at 5,000 nodes / 20,000 edges on a modern laptop; API caps each response (default 2,000 nodes) with "load more". Build a dev-only `/dev/graph-bench` page that loads 10k synthetic nodes and shows FPS.

### 10.3 Pages

- `/` — minimal landing (headline, one-line value prop, "Open the atlas", sign in). Signed-in users go straight to `/atlas`.
- `/atlas` — the workspace. Deep links: `/atlas?focus=channel:UC…&mode=local&depth=2`.
- `/discover` — search real channels by keyword or pick a subniche; shows the cost before running ("Uses 1 of 100 daily searches"); results grid with stats, niche guess, "Add to atlas" (single + bulk); added channels appear in the atlas live via SSE.
- `/channels/[id]` — header (avatar, stats, niches with confidence + manual override), videos list with **search within channel** and facets, transcript search across the channel, topics, related creators with reasons, mini local graph.
- `/videos/[id]` — click-to-load embed facade (`youtube-nocookie.com`), metadata, transcript viewer with search and clickable timestamps, transcript upload, topics, AI summary (if enabled).
- `/collections` and `/collections/[id]` — list/grid of items with notes and tags, "Show in atlas" (filters graph to members + their connections), export.
- `/search?q=` — full results with type tabs and mode switch (hybrid/keyword/semantic).
- `/settings` — profile, connected YouTube account (if enabled), reduced-motion and default layout preferences, export data, delete account.
- `/admin` — admin role only: quota history, ingestion runs, failed jobs, bull-board.
- `/privacy` and `/terms` — templates explicitly marked for the owner to review (the only allowed placeholder content).

### 10.4 Command palette (cmdk)

Groups: Atlas nodes, Channels, Videos, Topics, Niches, Actions ("Discover channels for “{q}” on YouTube", "Add channel by URL", "New collection", "Save current view", "Toggle sidebar/inspector", "Switch to local graph"). Fully keyboard-driven; results from `/api/search/suggest` debounced at 120 ms.

### 10.5 States

Every data view has a skeleton loading state, an empty state with a useful next action (e.g. empty atlas → "Discover channels" + "Load demo dataset" in fixture mode), and an error state with retry. Toasts (sonner) for job completion and errors. Optimistic updates for collection edits.

---

## 11. Design system

**Feel:** a quiet, premium research tool — Linear/Obsidian restraint. Dense but breathable. Color is reserved for meaning: ultramarine marks focus, selection and primary actions.

**Tokens** (Tailwind v4 `@theme`, CSS variables):

```
--bg-0: #0A0B0D   /* app background, deep graphite */
--bg-1: #101216   /* panels, sidebars */
--bg-2: #15181D   /* cards, raised */
--bg-3: #1C2027   /* hover, inputs */
--border: #242832    --border-strong: #2F3440
--text-1: #E7E9EE    --text-2: #A3A9B5    --text-3: #6B7280
--accent-300: #9AABFF  --accent-400: #6A82FF  --accent-500: #4361FF  --accent-600: #2E47E6
--accent-glow: rgb(67 97 255 / 0.35)
--success: #3CCB8F   --warning: #E8B04B   --danger: #F06A6A
```

**Graph encoding**: niche `#4361FF` (large, ring border); subniche `#8195FF` (medium); channel `#D9DCE3` with avatar image at close zoom, size ∝ log(subscribers); video `#7C8596` (small); topic `#57C7C2` (small). Edges `rgb(160 170 190 / 0.12)`; highlighted edges accent at 0.6; selected node gets an accent glow ring. "Color by community" uses a generated palette of desaturated hues at matched lightness that stays legible on `--bg-0`. Canvas background: `--bg-0` with a very faint dot grid and a barely-there ultramarine radial glow at center.

**Typography**: Inter Variable (or Geist Sans) for UI; JetBrains Mono / Geist Mono with `tabular-nums` for numbers, IDs and timestamps. Scale 12/13/14/16/20/24/32; weights 400/500/600; headings tracking −0.01em; panel body 13 px, content body 14 px.

**Shape & depth**: radii 6 (controls), 10 (cards), 14 (panels); 1 px borders do the work, shadows are minimal; floating overlays (palette, menus, hover cards) get a light backdrop blur and a 1 px inner top highlight `rgb(255 255 255 / 0.04)`.

**Motion** (motion library): 120 ms micro, 180 ms panels, 240 ms overlays; easing `cubic-bezier(0.2, 0.8, 0.2, 1)`; sidebar collapse animates width; new graph nodes scale/fade in over 300 ms; camera moves 400 ms ease-in-out. Honor `prefers-reduced-motion` and the user setting.

**Icons**: lucide, 16 px, 1.5 stroke. **Focus rings**: 2 px accent. **Contrast**: WCAG AA for all text.

---

## 12. Security & compliance

- `src/server/env.ts`: Zod-validated env with server/client split; boot fails on missing/invalid config. Only `NEXT_PUBLIC_*` reaches the browser. All YouTube and AI calls are server-side.
- OAuth tokens encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`, 32 bytes base64), ciphertext prefixed with a key ID for rotation.
- Zod validation on every input; response DTOs never leak internal fields.
- Security headers: CSP (images from `i.ytimg.com`, `yt3.ggpht.com`, `yt3.googleusercontent.com`; frames from `www.youtube-nocookie.com`), HSTS in production, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`. Configure `next/image` `remotePatterns` accordingly.
- Render YouTube descriptions as text with safe linkification — never `dangerouslySetInnerHTML`.
- Origin checks on mutating routes (in addition to Better Auth's protections).
- Account deletion cascades all personal data; revoking the YouTube connection deletes data obtained through it.
- Rate limiting and per-user quota fairness as in §7.2 and §9.

---

## 13. Observability & ops

pino logs with request IDs (propagated into enqueued jobs); `IngestionRun` history visible in `/admin` and in the channel page ("Last synced 2 h ago · 3 units"); `/api/health` checks DB, Redis, queue lag and embedding readiness; bull-board for queues.

---

## 14. Testing

- **Unit (Vitest)**: URL resolver (every URL form), quota reserve/lanes/reset date math, VTT/SRT parsing and chunking, topic normalization/merging, classification scoring, RRF, edge pruning/top-k, cursor encoding, encryption round-trip.
- **Integration (Vitest + Docker Postgres/Redis, fixture mode)**: ingest a fixture channel end-to-end → rows, embeddings, topics, niches, edges; re-ingest is idempotent (zero changes); incremental sync stops at known video; search returns expected fixture hits for keyword, semantic and transcript queries; graph traversal respects limits; quota exhaustion pauses background jobs; **IDOR tests** for every personal resource.
- **E2E (Playwright, fixture mode)**: sign up → atlas renders nodes (assert via list view and node count); ⌘K search → focus node; double-click expand increases node count; drag node → reload → position persisted; add to collection → reload → persisted; discover search → add channel → node appears **without reload** (SSE); channel page search-within-channel; video page transcript search jumps to timestamp.
- **CI**: GitHub Actions running lint, typecheck, unit, integration (service containers), e2e.

---

## 15. Developer setup

- `docker-compose.yml`: `postgres` (`pgvector/pgvector:pg17`, healthcheck), `redis` (`redis:7-alpine`); plus a `prod` profile with `web` and `worker` containers built from a multi-stage Dockerfile.
- Scripts: `dev` (Next + worker concurrently), `worker`, `build`, `start`, `db:migrate`, `db:seed` (taxonomy + demo user + fixture ingest through the real pipeline), `db:reset`, `fixtures:generate`, `yt:probe <url>`, `graph:rebuild`, `embeddings:reindex`, `test`, `test:integration`, `e2e`, `lint`, `typecheck`.
- `.env.example` (document each): `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `ENCRYPTION_KEY`, `YOUTUBE_MODE` (`fixture` default), `YOUTUBE_API_KEY`, `QUOTA_GENERAL_UNITS_PER_DAY=10000`, `QUOTA_SEARCH_CALLS_PER_DAY=100`, `QUOTA_BACKGROUND_RATIO=0.6`, `DISCOVERY_SEARCHES_PER_USER_PER_DAY=20`, `INGEST_MAX_VIDEOS_PER_CHANNEL=300`, `EMBEDDING_PROVIDER=local`, `EMBEDDING_DIM=384`, `ANTHROPIC_API_KEY` (optional), `ANTHROPIC_MODEL=claude-haiku-5-5`, `AI_DAILY_TOKEN_BUDGET`, `FEATURE_YOUTUBE_OAUTH=false`, `TRANSCRIPT_THIRD_PARTY_ENABLED=false`, `CLASSIFY_MIN_CONFIDENCE=0.35`.
- **README**: zero-to-running in ≤ 5 commands in fixture mode; how to get a YouTube Data API key and switch to `live`; quota math cheat-sheet; transcript limitations; architecture diagram; how to run tests.

---

## 16. Build phases (each ends with verification + commit)

| # | Phase | Acceptance criteria |
|---|---|---|
| 0 | **Foundations**: scaffold Next.js + TS strict, Tailwind v4 tokens, shadcn, ESLint (with module-boundary rules), Prettier, Vitest, Playwright, Docker Compose, env validation, Prisma schema + custom SQL migration, logger, `withRoute`, app shell skeleton, `CLAUDE.md`, `docs/` | `docker compose up -d && pnpm db:migrate && pnpm dev` works; `/api/health` green; no Prisma drift; typecheck + lint pass |
| 1 | **YouTube layer**: client (live + fixture), costs config, quota manager, cache, resolver, fixture generator, `yt:probe` | Unit tests pass; `pnpm yt:probe @somehandle` resolves in fixture mode (and live mode if a key is present) and prints cost |
| 2 | **Ingestion & workers**: queues, processors, incremental sync, tiers, scheduler, retries, dedup, `IngestionRun`, SSE | Fixture channel ingests end-to-end; re-run is a no-op; progress events visible via `curl -N /api/events` |
| 3 | **Intelligence**: embeddings, transcripts (providers, parsing, chunking), topics, classification, optional AI | Every fixture channel has ≥ 1 subniche with confidence; topics materialized; semantic KNN returns sensible neighbors; tests pass |
| 4 | **Graph**: builder, all edge kinds, communities, traversal, neighbors, delta, related creators | `/api/graph` returns bounded subgraphs; delta works after an ingest; p95 < 300 ms warm for a 2k-node depth-2 query on fixture data |
| 5 | **Search**: keyword, fuzzy/suggest, semantic, hybrid, channel-scoped with facets, transcript timestamps | Integration tests with known fixture queries pass; suggest < 50 ms locally |
| 6 | **Auth & personal layer**: Better Auth, workspaces, collections, items, saved views, layouts, rate limiting, security headers, export/delete | IDOR + rate-limit tests pass; account deletion verified |
| 7 | **Atlas UI**: canvas, layout worker, interactions, expand/collapse, filters, clustering, local mode, inspector, hover cards, ⌘K, live updates, list view | Playwright atlas specs pass; manual check at 5k nodes is smooth |
| 8 | **Pages**: discover, channel, video, collections, search, settings, admin, landing, legal templates | Playwright page specs pass |
| 9 | **Polish & hardening**: motion, empty/error states, a11y pass (keyboard, contrast, reduced motion), perf pass, README, CI | Definition of Done fully checked |

---

## 17. Definition of Done

- [ ] Fresh clone → README steps → working app in fixture mode with the demo dataset explorable.
- [ ] Setting `YOUTUBE_MODE=live` + `YOUTUBE_API_KEY` discovers and ingests **real** channels with no code changes.
- [ ] Atlas: zoom, pan, drag+pin (persisted), hover highlight, expand/collapse, clustering, filters, local mode, list view, hover cards, inspector — all functional.
- [ ] Search: hybrid/keyword/semantic across types; search within a channel; transcript hits deep-link to timestamps.
- [ ] Collections, saved views and layouts persist per authenticated user and are isolated between users.
- [ ] Background sync runs on schedule, respects quota lanes, retries correctly, pauses on exhaustion, and the 30-day compliance job works.
- [ ] Real-time: newly ingested channels appear in an open atlas without reload.
- [ ] Quota usage visible in the UI; costly actions confirm before spending searches.
- [ ] No secrets in the client bundle (verify by grepping the build output for the API key variable names/values).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:integration`, `pnpm e2e`, `pnpm build` all pass.
- [ ] `docs/DECISIONS.md` and `docs/PROGRESS.md` are complete; `CLAUDE.md` is accurate.

---

## 18. Guardrails (do not)

- Don't download videos or scrape YouTube pages; don't ship an enabled unofficial transcript scraper.
- Don't store API data beyond 30 days without refresh.
- Don't call `search.list` where a 1-unit call works; don't call `captions.list` speculatively.
- Don't put the YouTube or Anthropic key anywhere the browser can read it.
- Don't present fixture data as real; don't use real creators' names in fixtures.
- Don't leave stubs, fake buttons, or lorem ipsum (except the marked legal templates).
