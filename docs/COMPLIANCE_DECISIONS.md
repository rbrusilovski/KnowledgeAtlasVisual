# Compliance decisions — YouTube API Services

Status: **DRAFT, not legal advice, not a compliance approval.** This document records what Atlas does with
YouTube API Data, which official policy sections apply, where Atlas's design is in tension with those policies, and
which live features are therefore **gated off by default**. Nothing here means Atlas is approved by YouTube.
No policy amendment has been accepted and no compliance audit has been submitted on the owner's behalf.

Sources reviewed 2026-11-09 (re-check before enabling anything live):
- YouTube API Services Developer Policies — https://developers.google.com/youtube/terms/developer-policies
- Developer Policies Guide — https://developers.google.com/youtube/terms/developer-policies-guide
- Derived Metrics and Data Storage Policy — https://developers.google.com/youtube/terms/derived-metrics-policy

## 1. What Atlas collects

| Data | Endpoint | Auth | Retention class |
|---|---|---|---|
| Channel identity, title, description, handle/custom URL, country, publish date, keywords, topic categories/ids, localizations, default language, uploads playlist ID, status flags, thumbnails (all variants) | `channels.list` | API key (non-authorized) | `API_METADATA` (≤ 30 days) |
| Channel statistics (subscribers + hidden flag, views, video count) | `channels.list` | API key | `API_STATISTICS` (≤ 30 days; 36 months only if the derived-metrics amendment is accepted) |
| Upload history (video IDs, publish times) | `playlistItems.list` | API key | `API_METADATA` |
| Video title, description, tags, category, languages, duration, definition, caption flag, live details, status, topic categories, thumbnails | `videos.list` | API key | `API_METADATA` |
| Video statistics (views, likes, comments) | `videos.list` | API key | `API_STATISTICS` |
| Featured channels | `channelSections.list` | API key | `API_METADATA` |
| Channel search results | `search.list` (discovery only) | API key | not stored beyond the proposal/discovery record (IDs + query) |
| Owner captions | `captions.list` + `captions.download` | OAuth (`youtube.force-ssl`) of the channel owner | `AUTHORIZED_DATA` (≤ 30 days; purged ≤ 7 days after revocation — Atlas purges immediately) |
| User-uploaded transcripts | — (user content) | Atlas session | `USER_CONTENT` (until the user deletes it or their account) |
| Fixture dataset | none — fictional, generated locally | — | `FIXTURE` (no API policy applies) |

Atlas never downloads audiovisual content (III.E.1) and never scrapes YouTube or uses non-API retrieval (III.E.6,
III.I.14). There is no third-party transcript provider enabled (the adapter interface is disabled by default).

## 2. Display scope

Atlas is a **shared corpus**: channels/videos collected by any approved proposal appear in every signed-in user's
atlas (search, graph, channel pages). Personal data (collections, views, layouts, private transcripts) is isolated
per user. Private transcripts (owner captions, user uploads) are visible **only** to the user they belong to.

## 3. Owners

The demo dataset is fictional. In live mode the corpus would normally contain **channels belonging to many
unrelated content owners**. That is the crux of the feasibility question below.

## 4–7. How derived artifacts are produced

| Artifact | Derived from | Cross-owner? | Stored as |
|---|---|---|---|
| Embeddings (MiniLM, local) | title/description/tags/keywords (+ corpus transcripts) | No (per entity) | vector column on the source row; deleted with it |
| Topics (TF-IDF + optional AI) | same text fields | Topic *nodes* aggregate mentions across channels | `VideoTopic` rows (cascade with video) + `Topic` rows (pruned when no video references them) |
| Niche classification | channel embedding vs. seeded taxonomy centroids + keywords + topicCategories | Centroids learn from member channels (cross-owner) | `ChannelNiche` (cascade) |
| SIMILAR edges | cosine between channel embeddings | **Yes** | `GraphEdge` |
| CO_TOPIC edges | weighted Jaccard over channel topic profiles | **Yes** | `GraphEdge` |
| TOPIC_RELATED / NICHE_TOPIC | co-occurrence across videos/channels | **Yes** | `GraphEdge` |
| CO_DISCOVERED | channels returned by the same search | **Yes** | `GraphEdge` |
| FEATURED / PUBLISHED / MENTIONS / IN_NICHE / CONTAINS | a single channel's own data or classification | No | `GraphEdge` |
| Channel comparisons / statistical summaries | Atlas shows raw API statistics only; it computes **no** scores, ratios or rankings from statistics | — | — |

## 8. Transcripts

Owner captions require OAuth by the channel owner and are tied to that user's connection; user uploads are tied to
the uploader. Both default to `PRIVATE` and never feed shared derived data (topics, AI extraction, global search,
graph). Fixture transcripts are `CORPUS` visibility and are only served in fixture mode.

## 9. Refresh, deletion, attribution

- Field-group freshness is tracked in `FieldCoverage` (`lastSuccessAt`, `retentionDeadline`).
- The daily compliance job **deletes** API data whose retention deadline passed (whole record if identity/text is
  past deadline; only the statistics fields if just statistics are past deadline). Deletion never needs approval.
- **Refreshing** requires an approved `REFRESH_METADATA` proposal (product decision: every collection refresh needs
  explicit approval). The compliance job raises a SYSTEM proposal ahead of the deadline; if it is not approved and
  executed in time, the data is deleted at the deadline. Quota shortfalls no longer cause early deletion.
- Records the API no longer returns (successful response, item absent) are deleted; transient errors are retried.
- Derived data cascades with its source row; graph nodes/edges are rebuilt from the dirty set after deletions.
- Revoking a YouTube connection deletes that connection's owner-caption transcripts immediately (policy: ≤ 7 days).
- Account deletion removes all personal data immediately (policy: ≤ 7 days).
- UI shows YouTube attribution and links back to YouTube on every API-derived view (III.F.2).

## 10. Policy analysis and open questions

| Question | Relevant section | Assessment | Status |
|---|---|---|---|
| May Atlas aggregate API Data across channels of different content owners? | III.E.2.a ("aggregate only for channels under the same content owner, viewable only by that owner"), III.E.2.b | **Appears prohibited** for the shared cross-owner atlas as designed. | **Unresolved → gated** (`YOUTUBE_CROSS_OWNER_AGGREGATION_APPROVED=false`) |
| May Atlas create cross-owner SIMILAR / CO_TOPIC / CO_DISCOVERED / TOPIC_RELATED / NICHE_TOPIC edges? | III.E.2.a, III.E.4.h | Same as above; these are cross-owner derived data. | **Gated** (not built from live data while the flag is false) |
| May Atlas build a global niche taxonomy using API Data? | III.E.2.a, III.E.4.h; Derived Metrics "content categorization and tagging" | Seed taxonomy is Atlas-authored. Learning centroids from member channels and suggesting subniches aggregates across owners. | **Gated** with cross-owner flag (centroid learning + suggestions off in live mode) |
| Are derived topic tags permitted? | III.E.4.h (no derived data) vs. Derived Metrics Policy (tagging allowed if disclosed, supplement not replace YouTube categories) | Only under an accepted amendment, and must be labeled as Atlas-generated. | **Gated** (`YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED=false` blocks topics/classification/embeddings/AI on live data). UI labels them "Atlas-inferred". |
| Which statistics qualify for extended storage? | III.E.4.b; Derived Metrics §storage | Views/likes/comments/subscribers up to 36 months **only** with an accepted amendment; titles, descriptions, creator names stay at 30 days. | Implemented as retention classes; extended class only active when the amendment flag is true. |
| Do embeddings/summaries/entities inherit source retention? | III.E.4.c/d, III.E.4.h | Conservative decision: **yes**. They are stored on/cascade with their source rows and are deleted when the source is deleted. | Implemented |
| What happens on disconnect? | III.D.2 | Revoke token, delete authorized data within 7 days (Atlas: immediately). Also periodically confirm token validity. | Implemented (immediate purge; refresh failure surfaces an alert) |
| Must statistics shown be current? | III.E.4.e/f | Display current data or historical data accurately time-labeled. | Statistics carry their `as of` timestamp in DTOs. |
| Is derived "channel score" allowed? | III.E.4.h | Prohibited without amendment. | Atlas computes none. |

## 11. Feature gates (server-side, `src/server/youtube/policy.ts`)

```env
YOUTUBE_LIVE_COLLECTION_ENABLED=false            # live mode: block every API Data collection call
YOUTUBE_CROSS_OWNER_AGGREGATION_APPROVED=false   # live mode: no cross-owner edges, centroid learning, suggestions
YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED=false # live mode: no topics/classification/embeddings/AI; 30-day stats
```

- Fixture mode ignores the gates (the dataset is fictional; no API Data).
- A present API key never enables anything by itself.
- Compliance deletion and revocation purges run regardless of gates.
- Setting a flag to `true` must be accompanied by a dated entry in §12 recording the owner's decision and basis.

## 12. Decision log

| Date | Decision | By |
|---|---|---|
| 2026-11-09 | Live collection, cross-owner aggregation and derived-data processing gated off pending owner review. | Engineering (default-safe) |
