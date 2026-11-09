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

### Session scope
The 2026-11-09 session was narrowed by the owner to the **YouTube collection/ingestion subsystem**. Out-of-scope
findings (Docker, backups, maintenance scripts, Claude tools/MCP, relationship evaluation, general alerts) are in
`docs/DEFERRED_AUDIT_FINDINGS.md` with a cross-reference of every prompt finding.

### Status (YouTube subsystem)
| Phase | Scope | Status |
|---|---|---|
| 0 | Audit, compliance doc, policy feature gate | ✅ done |
| 1 | Transcript ownership/visibility + authorization on every read path + IDOR tests | ✅ done |
| 2 | ExpansionProposal model/service/routes, producer + service/worker enforcement, schedulers → proposals | ✅ done |
| 3 | Full metadata (all API parts), thumbnail variants, statistics availability, FieldCoverage + coverage API | ✅ done |
| 4 | Compliance lifecycle: field-group retention, deadline-only deletion, approval-gated refresh, revocation/refresh-failure purge | ✅ done |
| 5 | Checkpointed, resumable, bounded upload-history backfill; bounded sync; bounded discovery | ✅ done |
| 6 | Provenance for topic extraction (fields, transcript chunks, extractor); Atlas-inferred labels in DTOs | ✅ partial (classification provenance + relationship evaluation deferred: D8, D9) |
| 7 | Claude tools / MCP | ⏸ deferred (D7) — services are ready to wrap |
| 8 | Ops hardening | ⏸ deferred (D1–D6, D12) |
| UI | Proposal review dialog on every expansion action, Data page (coverage + approvals + runs), channel history panel, video coverage + private transcripts | ✅ done |

Verification (2026-11-09, all executed): `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` 105/105 ✅ ·
`pnpm test:integration` 64/64 ✅ · `pnpm e2e` 12/12 ✅ (first run 11/12 — discover live-status bug, fixed) ·
`pnpm build` ✅ · client-bundle secret grep clean ✅ · migration applied to a clone of the dev DB with no data loss and
no Prisma drift ✅ · worker boot + SIGTERM graceful shutdown ✅. The dev database itself has **not** been migrated.

Follow-up round (same day): discovery proposals from the Discover page (query or subniche queries), quota-vs-estimate
check in the review dialog, "Refresh metadata" proposals per channel, drift detection + approved re-scan, live-client
tests for all requested parts and partial responses, configurable e2e/integration isolation for parallel worktrees.
Verified: typecheck ✅ · lint ✅ · unit 110/110 ✅ · integration 66/66 ✅ (isolated DB/prefix — another worktree was
running tests on the shared `atlas_test`) · e2e 12/12 ✅ (isolated port 3200, production build).

Remaining YouTube-specific gaps:
- Live client never exercised against the real API in this session (no key; live collection is gated off anyway).
- Owner captions fetch one preferred track per video (other languages not auto-fetched).
- Uploads-playlist page tokens are positional; deletions during a long backfill can shift items. Now detected
  (completed scan saw fewer items than YouTube reports → `gap` on the channel) and repairable by an approved re-scan.
- Discovery previews on `/discover` still spend search quota without a proposal (they add nothing to the corpus;
  cost confirmation is kept). Auto-add discovery runs as a bounded `DISCOVER_CHANNELS` proposal ("Propose auto-add").
- `localizations` are stored but not surfaced in the UI.

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
