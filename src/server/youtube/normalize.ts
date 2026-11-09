/**
 * Pure normalization of official YouTube API resources into Atlas columns + field-group coverage.
 *
 * Rules (docs/DECISIONS.md "metadata coverage"):
 *  • A part the API did not return (partial response) contributes NO columns, so existing good values are preserved;
 *    its group is reported NOT_RETURNED and keeps its previous freshness/deadline.
 *  • A field the API omits *inside a returned part* with known semantics (hidden likes, disabled comments, hidden
 *    subscriber count, no tags, no country) is stored as null/empty and reported UNAVAILABLE with a reason — never 0.
 *  • Nothing is inferred: Atlas-derived values (topics, niches) are not produced here.
 */
import type { CoverageGroup, CoverageStatus } from "@/server/db";
import { bestThumb, parseIsoDuration, THUMBNAIL_VARIANTS, type YtChannel, type YtThumbnails, type YtVideo } from "./schemas";

/** Where a thumbnail variant came from (plan Phase 2: URL, width, height, source). */
export type ThumbSource = "youtube-data-api" | "fixture";

export interface ThumbVariant {
  variant: string;
  url: string;
  width: number | null;
  height: number | null;
  source: ThumbSource;
}

export interface NormalizeOptions {
  /** Provenance recorded on each thumbnail variant (default: the YouTube Data API). */
  source?: ThumbSource;
}

export interface GroupCoverage {
  group: CoverageGroup;
  status: CoverageStatus;
  reason?: string;
  details?: Record<string, unknown>;
}

export function thumbnailVariants(t?: YtThumbnails, source: ThumbSource = "youtube-data-api"): ThumbVariant[] {
  if (!t) return [];
  const out: ThumbVariant[] = [];
  for (const variant of THUMBNAIL_VARIANTS) {
    const v = t[variant];
    if (v?.url) out.push({ variant, url: v.url, width: v.width ?? null, height: v.height ?? null, source });
  }
  return out;
}

/** Handles arrive as customUrl "@name"; legacy custom URLs have no "@". */
export function handleFrom(customUrl?: string): string | null {
  return customUrl?.startsWith("@") ? customUrl.slice(1).toLowerCase() : null;
}

/** Brand keywords arrive as a space-separated string with "quoted phrases". */
export function parseKeywords(s?: string): string[] {
  if (!s) return [];
  const out: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push((m[1] ?? m[2]!).trim().toLowerCase());
  return [...new Set(out.filter(Boolean))].slice(0, 50);
}

const date = (s?: string) => (s ? new Date(s) : null);
const presence = (v: unknown) => (v === undefined || v === null || (Array.isArray(v) && !v.length) ? "UNAVAILABLE" : "PRESENT");
const bool = (s?: string) => (s === "true" ? true : s === "false" ? false : null);

// ── Channels ───────────────────────────────────────────────────────────────

export function normalizeChannel(c: YtChannel, opts: NormalizeOptions = {}) {
  const data: Record<string, unknown> = { youtubeId: c.id, etag: c.etag ?? null };
  const coverage: GroupCoverage[] = [{ group: "IDENTITY", status: "PRESENT", details: { url: `https://www.youtube.com/channel/${c.id}` } }];
  const sn = c.snippet;
  const branding = c.brandingSettings?.channel;

  if (sn) {
    const thumbs = thumbnailVariants(sn.thumbnails, opts.source);
    Object.assign(data, {
      title: sn.title,
      description: sn.description ?? "",
      customUrl: sn.customUrl ?? null,
      handle: handleFrom(sn.customUrl),
      country: sn.country ?? branding?.country ?? null,
      publishedAt: date(sn.publishedAt),
      defaultLanguage: sn.defaultLanguage ?? branding?.defaultLanguage ?? null,
      thumbnailUrl: bestThumb(sn.thumbnails) ?? null,
      thumbnails: thumbs,
    });
    coverage.push({
      group: "TEXT",
      status: "PRESENT",
      details: { title: "PRESENT", description: sn.description ? "PRESENT" : "EMPTY", keywords: c.brandingSettings ? presence(branding?.keywords) : "NOT_RETURNED" },
    });
    coverage.push(
      thumbs.length
        ? { group: "THUMBNAILS", status: "PRESENT", details: { variants: thumbs.map((t) => t.variant), preferred: data.thumbnailUrl } }
        : { group: "THUMBNAILS", status: "UNAVAILABLE", reason: "no thumbnails in snippet" },
    );
  } else {
    coverage.push({ group: "TEXT", status: "NOT_RETURNED", reason: "snippet part not returned" });
    coverage.push({ group: "THUMBNAILS", status: "NOT_RETURNED", reason: "snippet part not returned" });
  }

  if (c.brandingSettings) Object.assign(data, { keywords: parseKeywords(branding?.keywords), trailerVideoId: branding?.unsubscribedTrailer ?? null });
  if (c.topicDetails) Object.assign(data, { topicCategories: c.topicDetails.topicCategories ?? [], topicIds: c.topicDetails.topicIds ?? [] });
  if (c.contentDetails) data.uploadsPlaylistId = c.contentDetails.relatedPlaylists?.uploads ?? null;
  if (c.localizations) data.localizations = c.localizations;

  if (sn || c.contentDetails) {
    coverage.push({
      group: "CHANNEL_PROFILE",
      status: sn && c.contentDetails ? "PRESENT" : "NOT_RETURNED",
      reason: sn && c.contentDetails ? undefined : `${sn ? "contentDetails" : "snippet"} part not returned`,
      details: {
        handle: sn ? presence(data.handle) : "NOT_RETURNED",
        customUrl: sn ? presence(sn.customUrl) : "NOT_RETURNED",
        country: sn ? presence(data.country) : "NOT_RETURNED",
        publishedAt: sn ? presence(sn.publishedAt) : "NOT_RETURNED",
        defaultLanguage: sn ? presence(data.defaultLanguage) : "NOT_RETURNED",
        uploadsPlaylistId: c.contentDetails ? presence(data.uploadsPlaylistId) : "NOT_RETURNED",
        topicCategories: c.topicDetails ? presence(c.topicDetails.topicCategories) : "NOT_RETURNED",
        localizations: c.localizations ? Object.keys(c.localizations).length : "NOT_RETURNED",
      },
    });
  } else coverage.push({ group: "CHANNEL_PROFILE", status: "NOT_RETURNED", reason: "snippet and contentDetails parts not returned" });

  const st = c.statistics;
  if (st) {
    const hidden = st.hiddenSubscriberCount ?? false;
    Object.assign(data, {
      subscriberCount: hidden ? null : (st.subscriberCount ?? null),
      hiddenSubscriberCount: hidden,
      viewCount: st.viewCount ?? null,
      videoCount: st.videoCount !== undefined ? Number(st.videoCount) : null,
    });
    coverage.push({
      group: "STATISTICS",
      status: "PRESENT",
      details: { subscribers: hidden ? "HIDDEN" : presence(st.subscriberCount), views: presence(st.viewCount), videos: presence(st.videoCount) },
    });
  } else coverage.push({ group: "STATISTICS", status: "NOT_RETURNED", reason: "statistics part not returned" });

  if (c.status) {
    Object.assign(data, { privacyStatus: c.status.privacyStatus ?? null, isLinked: c.status.isLinked ?? null, madeForKids: c.status.madeForKids ?? null });
    coverage.push({ group: "STATUS", status: "PRESENT", details: { privacyStatus: c.status.privacyStatus ?? null } });
  } else coverage.push({ group: "STATUS", status: "NOT_RETURNED", reason: "status part not returned" });

  return { data, coverage };
}

// ── Videos ─────────────────────────────────────────────────────────────────

export function normalizeVideo(v: YtVideo, opts: NormalizeOptions = {}) {
  const data: Record<string, unknown> = { youtubeId: v.id, etag: v.etag ?? null };
  const coverage: GroupCoverage[] = [{ group: "IDENTITY", status: "PRESENT", details: { url: `https://www.youtube.com/watch?v=${v.id}` } }];
  const sn = v.snippet;
  const cd = v.contentDetails;

  if (sn) {
    const thumbs = thumbnailVariants(sn.thumbnails, opts.source);
    Object.assign(data, {
      title: sn.title,
      description: sn.description ?? "",
      publishedAt: new Date(sn.publishedAt),
      tags: (sn.tags ?? []).slice(0, 60),
      categoryId: sn.categoryId ?? null,
      channelTitle: sn.channelTitle ?? null,
      defaultLanguage: sn.defaultLanguage ?? null,
      defaultAudioLanguage: sn.defaultAudioLanguage ?? null,
      liveBroadcastContent: sn.liveBroadcastContent ?? null,
      thumbnailUrl: bestThumb(sn.thumbnails) ?? null,
      thumbnails: thumbs,
    });
    coverage.push({ group: "TEXT", status: "PRESENT", details: { title: "PRESENT", description: sn.description ? "PRESENT" : "EMPTY", tags: sn.tags?.length ? "PRESENT" : "UNAVAILABLE" } });
    coverage.push(
      thumbs.length
        ? { group: "THUMBNAILS", status: "PRESENT", details: { variants: thumbs.map((t) => t.variant), preferred: data.thumbnailUrl } }
        : { group: "THUMBNAILS", status: "UNAVAILABLE", reason: "no thumbnails in snippet" },
    );
  } else {
    coverage.push({ group: "TEXT", status: "NOT_RETURNED", reason: "snippet part not returned" });
    coverage.push({ group: "THUMBNAILS", status: "NOT_RETURNED", reason: "snippet part not returned" });
  }

  if (cd) {
    const durationSec = parseIsoDuration(cd.duration) ?? null;
    Object.assign(data, {
      durationSec,
      // Atlas heuristic (not a YouTube field): ≤ 60 s counts as a Short.
      isShort: durationSec !== null && durationSec <= 60,
      dimension: cd.dimension ?? null,
      definition: cd.definition ?? null,
      projection: cd.projection ?? null,
      captionFlag: bool(cd.caption),
      licensedContent: cd.licensedContent ?? null,
      regionRestriction: cd.regionRestriction ?? null,
      contentRating: cd.contentRating && Object.keys(cd.contentRating).length ? cd.contentRating : null,
    });
  }
  if (v.liveStreamingDetails) {
    Object.assign(data, {
      liveScheduledStartAt: date(v.liveStreamingDetails.scheduledStartTime),
      liveActualStartAt: date(v.liveStreamingDetails.actualStartTime),
      liveActualEndAt: date(v.liveStreamingDetails.actualEndTime),
    });
  }
  if (v.topicDetails) data.topicCategories = v.topicDetails.topicCategories ?? [];
  if (v.localizations) data.localizations = v.localizations;

  const live = sn?.liveBroadcastContent && sn.liveBroadcastContent !== "none";
  coverage.push({
    group: "PUBLICATION",
    status: sn && cd ? "PRESENT" : "NOT_RETURNED",
    reason: sn && cd ? undefined : `${sn ? "contentDetails" : "snippet"} part not returned`,
    details: {
      publishedAt: sn ? "PRESENT" : "NOT_RETURNED",
      duration: cd ? presence(cd.duration) : "NOT_RETURNED",
      defaultLanguage: sn ? presence(sn.defaultLanguage) : "NOT_RETURNED",
      audioLanguage: sn ? presence(sn.defaultAudioLanguage) : "NOT_RETURNED",
      live: live ? (v.liveStreamingDetails ? "PRESENT" : "NOT_RETURNED") : "NOT_APPLICABLE",
      captionFlag: cd ? presence(cd.caption) : "NOT_RETURNED",
      topicCategories: v.topicDetails ? presence(v.topicDetails.topicCategories) : "NOT_RETURNED",
    },
  });

  const st = v.statistics;
  const statsHidden = v.status?.publicStatsViewable === false;
  if (st) {
    Object.assign(data, { viewCount: st.viewCount ?? null, likeCount: st.likeCount ?? null, commentCount: st.commentCount ?? null });
    const details = {
      views: st.viewCount !== undefined ? "PRESENT" : statsHidden ? "HIDDEN" : "UNAVAILABLE",
      likes: st.likeCount !== undefined ? "PRESENT" : "HIDDEN",
      comments: st.commentCount !== undefined ? "PRESENT" : "DISABLED_OR_HIDDEN",
    };
    coverage.push(
      st.viewCount === undefined
        ? { group: "STATISTICS", status: "UNAVAILABLE", reason: statsHidden ? "owner hid public statistics" : "view count not supplied", details }
        : { group: "STATISTICS", status: "PRESENT", details },
    );
  } else coverage.push({ group: "STATISTICS", status: "NOT_RETURNED", reason: "statistics part not returned" });

  if (v.status) {
    Object.assign(data, {
      privacyStatus: v.status.privacyStatus ?? null,
      uploadStatus: v.status.uploadStatus ?? null,
      license: v.status.license ?? null,
      embeddable: v.status.embeddable ?? null,
      publicStatsViewable: v.status.publicStatsViewable ?? null,
      madeForKids: v.status.madeForKids ?? null,
    });
    coverage.push({ group: "STATUS", status: "PRESENT", details: { privacyStatus: v.status.privacyStatus ?? null } });
  } else coverage.push({ group: "STATUS", status: "NOT_RETURNED", reason: "status part not returned" });

  return { data, coverage };
}

/** Groups that must be PRESENT/UNAVAILABLE/NOT_APPLICABLE for a record to count as collected. Transcript is excluded. */
export const REQUIRED_VIDEO_GROUPS: CoverageGroup[] = ["IDENTITY", "TEXT", "PUBLICATION", "THUMBNAILS", "STATISTICS"];
export const REQUIRED_CHANNEL_GROUPS: CoverageGroup[] = ["IDENTITY", "TEXT", "CHANNEL_PROFILE", "THUMBNAILS", "STATISTICS"];
export const RESOLVED_STATUSES: ReadonlySet<CoverageStatus> = new Set(["PRESENT", "UNAVAILABLE", "NOT_APPLICABLE"]);
