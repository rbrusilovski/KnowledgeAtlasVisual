# Progress

Sources of truth: `BUILD_SPEC.md` (architecture, design system, original requirements) and
`YouTube_Knowledge_Atlas_Prompt.md` (YouTube collection, coverage, approval and expansion — more recent, wins on
conflict). Compliance: `docs/COMPLIANCE_DECISIONS.md`. Decisions: `docs/DECISIONS.md`.

---

## Round 2 — collection, approval, coverage, compliance (started 2026-11-09)

### Gap audit (verified in source, 2026-11-09)

Legend: CONFIRMED (finding reproduced) · PARTIALLY_PRESENT · NOT_PRESENT · NOT_REPRODUCIBLE

| # | Area | Finding | Verdict | Evidence |
|---|---|---|---|---|
| 1 | Transcript endpoint | `GET /api/videos/:id/transcript` is `auth: "none"` and returns any stored transcript | **CONFIRMED** | `src/app/api/videos/[id]/transcript/route.ts` |
| 1b | Transcript leakage elsewhere | Global search (keyword + semantic transcript hits), in-video search, video DTO, topic extraction and AI extraction all read every transcript regardless of owner | **CONFIRMED** | `services/search`, `services/catalog/videoDetail`, `services/topics`, `services/ai` |
| 1c | Transcript overwrite | `Transcript.videoId @unique`; any user's upload deletes and replaces the existing transcript (incl. another user's or owner captions) | **CONFIRMED** | `services/transcripts/storeTranscript` |
| 1d | Revocation purge scope | Disconnect purges *all* OWNER_CAPTIONS for the channel IDs, including other users' | **CONFIRMED** | `workspaces.purgeYouTubeConnectionData` |
| 2 | Channel addition | `POST /api/channels` resolves then directly enqueues ingest | **CONFIRMED** | `catalog.addChannel` |
| 3 | Channel sync | `POST /api/channels/:id/sync` directly enqueues sync / full backfill | **CONFIRMED** | route |
| 3b | Other unapproved expansion paths | `POST /api/demo/load` bulk-enqueues; scheduler auto-enqueues syncs (adds new uploads) and stats refresh; compliance auto-refreshes; seed enqueues | **CONFIRMED** | `ingestion.scheduleDueSyncs/scheduleStatsRefresh`, `compliance`, `demo/load`, seed |
| 4 | Expansion workflow | Only "confirm before spending a search" exists; no durable proposal/approval | **CONFIRMED (NOT_PRESENT)** | — |
| 5 | Compliance refresh | Channel refresh updates title/description/stats only but advances `lastRefreshedAt` (thumbnails, keywords, country, topics, playlist never refreshed); video refresh skips thumbnails/duration/category/language | **CONFIRMED** | `services/compliance` |
| 6 | Compliance deletion | When background budget is unavailable, batches 27 days old (deadline 30) are deleted immediately | **CONFIRMED** | `services/compliance` (`deletedNoBudget`) |
| 6b | Transient errors | One upstream error aborts the whole compliance run (nothing after it is refreshed or deleted) | **CONFIRMED** | no per-batch error handling |
| 7 | Thumbnails | One `thumbnailUrl`; schema only parses default/medium/high and live client requests medium/high | **CONFIRMED** | `youtube/schemas.ts`, `live.ts` |
| 8 | Transcript model | One transcript per video | **CONFIRMED** | schema |
| 9 | AI integration | Anthropic used for extraction/reranking only; no Atlas tool interface / MCP | **CONFIRMED** | `services/ai` |
| 10 | Maintenance scripts | `db:reset` and `embeddings:reindex` **exist** (PROGRESS "known issue" was stale). Reset has no production guard; reindex is not resumable and does not track model/dimension | **PARTIALLY_PRESENT** | `scripts/` |
| 11 | Docker | Fixed `atlas/atlas` credentials, Postgres/Redis published on 0.0.0.0, prod profile reuses them, Redis without auth | **CONFIRMED** | `docker-compose.yml` |
| 12 | Similarity relationships | Sparse at spec thresholds; no evaluation data | **CONFIRMED (no evaluation)** | DECISIONS.md |
| 13 | Coverage | No field-level coverage or availability tracking; unavailable stats stored as null with no reason; missing videos from `videos.list` silently dropped | **NOT_PRESENT** | — |
| 14 | Upload history | Single `backfillPageToken`; ids for up to 5,000 videos gathered in memory before any write (crash loses all); no pages/oldest/newest/state | **PARTIALLY_PRESENT** | `ingestion.ingestUnlocked` |
| 15 | Provenance | `VideoTopic.source` and `GraphEdge.evidence` exist; no extractor/model/taxonomy versions, no field/chunk attribution, no fact-vs-inference labeling | **PARTIALLY_PRESENT** | — |
| 16 | Policy gate | No live-collection or cross-owner gate; API key presence enables everything | **NOT_PRESENT** | `env.ts` |
| 17 | Jobs endpoint | `GET /api/jobs/:id` is `auth: "none"` and returns job results to anyone with an ID | **CONFIRMED** (new finding) | route |
| 18 | Admin failed-job list | Returns raw job `data` (no secrets today, but unbounded) | NOT_REPRODUCIBLE as a leak | `admin/overview` |

Preserved as-is (CONFIRMED working, covered by tests): YouTube live/fixture clients, central `costs.ts`, Lua quota
buckets + lanes, response cache, resolver (cheap paths first), uploads-playlist enumeration (never `search.list`),
BullMQ runtime (quota delay, retry policy), embeddings providers, TF-IDF topics, classification, materialized
graph + incremental builder, search (keyword/semantic/hybrid), Better Auth, workspaces/collections IDOR protection,
SSE, admin/bull-board.

### Conflicts between documents
- BUILD_SPEC §7.11 schedules automatic syncs (adding new uploads), stats refresh and compliance refresh. The newer
  spec requires explicit, single-use approval for every addition or refresh. **Newer spec wins**: schedulers now
  raise SYSTEM proposals; deletion stays automatic.
- BUILD_SPEC assumes cross-channel aggregation; the developer policies appear to restrict it (III.E.2.a). Kept for
  fixture mode; gated for live data (see COMPLIANCE_DECISIONS.md).

### Roadmap (dependency order) and status
| Phase | Scope | Status |
|---|---|---|
| 0 | Audit, compliance doc, policy feature gate | in progress |
| 1 | Transcript ownership/visibility model + authorization everywhere + IDOR tests | pending |
| 2 | ExpansionProposal model, service, approval routes, producer + worker enforcement, scheduler → proposals | pending |
| 3 | Full channel/video metadata, thumbnail variants, statistics availability, FieldCoverage + coverage API | pending |
| 4 | Compliance lifecycle: field-group retention, deadline-aware deletion, approval-gated refresh, revocation purge | pending |
| 5 | Checkpointed, resumable, bounded upload-history backfill | pending |
| 6 | Provenance (extractor/model/taxonomy versions, field + chunk evidence), fact vs inference, relationship evaluation | pending |
| 7 | Agent tokens, Atlas tool service (read + propose), HTTP tool endpoint, MCP stdio adapter | pending |
| 8 | Prod compose, backups/restore, reset guard, resumable reindex, graph verify, recovery, alerts | pending |
| UI | Coverage + approvals page, proposal review dialog wired into every expansion action | pending |

Policy-sensitive (blocked on the owner, infrastructure built): enabling live collection; cross-owner aggregation;
derived-metrics amendment; Google OAuth verification for `youtube.force-ssl`.

Testing requirements per phase: unit (scope hashing, estimates, coverage transitions, retention math, transcript
identity), integration (approval at every route, worker rejection, scope mismatch, replay, bounds, IDOR, revocation,
partial responses, quota-safe compliance, resumable backfill), e2e (propose → review → approve → data appears).

---

## Round 1 — original build (BUILD_SPEC §16), completed 2026-11-08
- [x] Phases 0–9 (foundations, YouTube layer, ingestion, intelligence, graph, search, personal layer, atlas UI,
  pages, polish) and a spec-gap pass. 92 unit, 32 integration, 10 e2e tests passed at the end of round 1.

## Environment notes
- Node v24.22.2 + pnpm 12.18 at `~/.local/node` (not on default PATH; prefix commands).
- Docker via OrbStack.

## Known issues
- Demo-data SIMILAR/CO_TOPIC edges are sparse at spec thresholds (see DECISIONS.md; evaluation added in phase 6).
- First seed downloads the MiniLM model (~23 MB).
