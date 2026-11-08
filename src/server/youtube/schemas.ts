import { z } from "zod";

/** Only the fields we use; unknown fields are stripped. Counts arrive as strings. */
const thumbs = z
  .object({
    default: z.object({ url: z.string() }).optional(),
    medium: z.object({ url: z.string() }).optional(),
    high: z.object({ url: z.string() }).optional(),
  })
  .partial()
  .optional();

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
    .object({ channel: z.object({ keywords: z.string().optional() }).partial().optional() })
    .optional(),
  topicDetails: z.object({ topicCategories: z.array(z.string()).optional() }).optional(),
});
export type YtChannel = z.infer<typeof ytChannel>;

export const ytChannelList = z.object({
  items: z.array(ytChannel).default([]),
  nextPageToken: z.string().optional(),
});

export const ytPlaylistItem = z.object({
  snippet: z.object({ publishedAt: z.string().optional(), title: z.string().optional() }).partial().optional(),
  contentDetails: z.object({ videoId: z.string(), videoPublishedAt: z.string().optional() }),
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
      title: z.string(),
      description: z.string().default(""),
      publishedAt: z.string(),
      tags: z.array(z.string()).optional(),
      categoryId: z.string().optional(),
      defaultLanguage: z.string().optional(),
      defaultAudioLanguage: z.string().optional(),
      thumbnails: thumbs,
    })
    .optional(),
  contentDetails: z.object({ duration: z.string().optional(), caption: z.string().optional() }).optional(),
  statistics: z
    .object({ viewCount: countStr, likeCount: countStr, commentCount: countStr })
    .partial()
    .optional(),
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

export function bestThumb(t?: z.infer<typeof thumbs>): string | undefined {
  return t?.high?.url ?? t?.medium?.url ?? t?.default?.url;
}
