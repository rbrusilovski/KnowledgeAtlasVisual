import { z } from "zod";

/** Only the fields we use; unknown fields are stripped. Counts arrive as strings. */
const thumb = z.object({ url: z.string(), width: z.number().int().optional(), height: z.number().int().optional() });
export const THUMBNAIL_VARIANTS = ["default", "medium", "high", "standard", "maxres"] as const;
const thumbs = z
  .object({ default: thumb, medium: thumb, high: thumb, standard: thumb, maxres: thumb })
  .partial()
  .optional();
export type YtThumbnails = z.infer<typeof thumbs>;
const localized = z.object({ title: z.string().optional(), description: z.string().optional() }).partial();

const countStr = z.union([z.string(), z.number()]).transform((v) => BigInt(v)).optional();

export const ytChannel = z.object({
  id: z.string(),
  etag: z.string().optional(),
  snippet: z
    .object({
      title: z.string(),
      description: z.string().default(""),
      customUrl: z.string().optional(),
      publishedAt: z.string().optional(),
      country: z.string().optional(),
      defaultLanguage: z.string().optional(),
      localized: localized.optional(),
      thumbnails: thumbs,
    })
    .optional(),
  statistics: z
    .object({
      viewCount: countStr,
      subscriberCount: countStr,
      hiddenSubscriberCount: z.boolean().optional(),
      videoCount: countStr,
    })
    .optional(),
  contentDetails: z
    .object({ relatedPlaylists: z.object({ uploads: z.string().optional() }).partial() })
    .optional(),
  brandingSettings: z
    .object({
      channel: z
        .object({ keywords: z.string().optional(), unsubscribedTrailer: z.string().optional(), defaultLanguage: z.string().optional(), country: z.string().optional() })
        .partial()
        .optional(),
    })
    .optional(),
  topicDetails: z.object({ topicIds: z.array(z.string()).optional(), topicCategories: z.array(z.string()).optional() }).optional(),
  status: z.object({ privacyStatus: z.string().optional(), isLinked: z.boolean().optional(), madeForKids: z.boolean().optional() }).partial().optional(),
  localizations: z.record(z.string(), localized).optional(),
});
export type YtChannel = z.infer<typeof ytChannel>;

export const ytChannelList = z.object({
  items: z.array(ytChannel).default([]),
  nextPageToken: z.string().optional(),
});

export const ytPlaylistItem = z.object({
  snippet: z.object({ publishedAt: z.string().optional(), title: z.string().optional() }).partial().optional(),
  contentDetails: z.object({ videoId: z.string(), videoPublishedAt: z.string().optional() }),
  status: z.object({ privacyStatus: z.string().optional() }).partial().optional(),
});
export const ytPlaylistItems = z.object({
  items: z.array(ytPlaylistItem).default([]),
  nextPageToken: z.string().optional(),
  pageInfo: z.object({ totalResults: z.number().optional() }).partial().optional(),
});

export const ytVideo = z.object({
  id: z.string(),
  etag: z.string().optional(),
  snippet: z
    .object({
      channelId: z.string(),
      channelTitle: z.string().optional(),
      title: z.string(),
      description: z.string().default(""),
      publishedAt: z.string(),
      tags: z.array(z.string()).optional(),
      categoryId: z.string().optional(),
      defaultLanguage: z.string().optional(),
      defaultAudioLanguage: z.string().optional(),
      liveBroadcastContent: z.string().optional(),
      localized: localized.optional(),
      thumbnails: thumbs,
    })
    .optional(),
  contentDetails: z
    .object({
      duration: z.string().optional(),
      dimension: z.string().optional(),
      definition: z.string().optional(),
      caption: z.string().optional(),
      licensedContent: z.boolean().optional(),
      projection: z.string().optional(),
      regionRestriction: z.object({ allowed: z.array(z.string()).optional(), blocked: z.array(z.string()).optional() }).partial().optional(),
      contentRating: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  status: z
    .object({
      uploadStatus: z.string().optional(),
      privacyStatus: z.string().optional(),
      license: z.string().optional(),
      embeddable: z.boolean().optional(),
      publicStatsViewable: z.boolean().optional(),
      madeForKids: z.boolean().optional(),
    })
    .partial()
    .optional(),
  statistics: z
    .object({ viewCount: countStr, likeCount: countStr, commentCount: countStr })
    .partial()
    .optional(),
  topicDetails: z.object({ topicCategories: z.array(z.string()).optional(), relevantTopicIds: z.array(z.string()).optional() }).partial().optional(),
  liveStreamingDetails: z
    .object({ scheduledStartTime: z.string().optional(), actualStartTime: z.string().optional(), actualEndTime: z.string().optional() })
    .partial()
    .optional(),
  localizations: z.record(z.string(), localized).optional(),
});
export type YtVideo = z.infer<typeof ytVideo>;
export const ytVideoList = z.object({ items: z.array(ytVideo).default([]) });

export const ytChannelSection = z.object({
  id: z.string().optional(),
  snippet: z.object({ type: z.string().optional(), title: z.string().optional() }).partial().optional(),
  contentDetails: z.object({ channels: z.array(z.string()).optional() }).partial().optional(),
});
export const ytChannelSections = z.object({ items: z.array(ytChannelSection).default([]) });

export const ytSearchResult = z.object({
  id: z.object({ kind: z.string().optional(), channelId: z.string().optional(), videoId: z.string().optional() }),
  snippet: z
    .object({ title: z.string().optional(), description: z.string().optional(), channelId: z.string().optional(), thumbnails: thumbs })
    .partial()
    .optional(),
});
export const ytSearchList = z.object({
  items: z.array(ytSearchResult).default([]),
  nextPageToken: z.string().optional(),
});

export const ytCaptionList = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({ language: z.string(), trackKind: z.string().optional(), name: z.string().optional() }).partial(),
      }),
    )
    .default([]),
});

export const ytError = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional(), domain: z.string().optional() })).optional(),
  }),
});

/** ISO-8601 duration (PT1H2M3S) → seconds. */
export function parseIsoDuration(iso?: string): number | undefined {
  if (!iso) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return undefined;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Math.round(Number(s ?? 0));
}

/** Preferred display variant: high (480×360) is sharp at card size without the weight of maxres. */
export function bestThumb(t?: z.infer<typeof thumbs>): string | undefined {
  return t?.high?.url ?? t?.medium?.url ?? t?.standard?.url ?? t?.maxres?.url ?? t?.default?.url;
}
