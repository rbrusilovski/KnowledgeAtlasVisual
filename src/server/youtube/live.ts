import type { z } from "zod";
import {
  ytCaptionList,
  ytChannelList,
  ytChannelSections,
  ytError,
  ytPlaylistItems,
  ytSearchList,
  ytVideoList,
  bestThumb,
} from "./schemas";
import { YouTubeApiError, type RawYouTubeClient, type PlaylistPage, type SearchChannelHit, type CaptionTrack } from "./types";
import { MAX_IDS_PER_CALL, MAX_PAGE_SIZE } from "./costs";

const BASE = "https://www.googleapis.com/youtube/v3";

/** Thin typed fetch client. Uses `part` + `fields` partial responses to minimize payload. */
export class LiveYouTubeClient implements RawYouTubeClient {
  readonly mode = "live" as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T extends z.ZodType>(
    resource: string,
    params: Record<string, string | number | undefined>,
    schema: T,
    accessToken?: string,
  ): Promise<z.infer<T>> {
    const url = new URL(`${BASE}/${resource}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    if (!accessToken) url.searchParams.set("key", this.apiKey);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { accept: "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new YouTubeApiError(0, "network", e instanceof Error ? e.message : "network error");
    }
    const text = await res.text();
    if (!res.ok) {
      const parsed = ytError.safeParse(safeJson(text));
      const reason = parsed.success ? (parsed.data.error.errors?.[0]?.reason ?? "unknown") : "unknown";
      const message = parsed.success ? (parsed.data.error.message ?? res.statusText) : res.statusText;
      throw new YouTubeApiError(res.status, reason, message);
    }
    return schema.parse(safeJson(text));
  }

  async channelsList(p: { ids?: string[]; forHandle?: string; forUsername?: string }) {
    if (p.ids && p.ids.length > MAX_IDS_PER_CALL) throw new Error("channels.list accepts ≤ 50 ids");
    const r = await this.call(
      "channels",
      {
        part: "snippet,statistics,contentDetails,brandingSettings,topicDetails",
        fields:
          "items(id,etag,snippet(title,description,customUrl,publishedAt,country,thumbnails(default,medium,high)),statistics,contentDetails(relatedPlaylists(uploads)),brandingSettings(channel(keywords)),topicDetails(topicCategories))",
        id: p.ids?.join(","),
        forHandle: p.forHandle,
        forUsername: p.forUsername,
        maxResults: p.ids ? undefined : 1,
      },
      ytChannelList,
    );
    return r.items;
  }

  async playlistItemsList(playlistId: string, pageToken?: string): Promise<PlaylistPage> {
    const r = await this.call(
      "playlistItems",
      {
        part: "contentDetails",
        fields: "nextPageToken,pageInfo(totalResults),items(contentDetails(videoId,videoPublishedAt))",
        playlistId,
        maxResults: MAX_PAGE_SIZE,
        pageToken,
      },
      ytPlaylistItems,
    );
    return {
      items: r.items.map((i) => ({ videoId: i.contentDetails.videoId, publishedAt: i.contentDetails.videoPublishedAt })),
      nextPageToken: r.nextPageToken,
      totalResults: r.pageInfo?.totalResults,
    };
  }

  async videosList(ids: string[]) {
    if (!ids.length) return [];
    if (ids.length > MAX_IDS_PER_CALL) throw new Error("videos.list accepts ≤ 50 ids");
    const r = await this.call(
      "videos",
      {
        part: "snippet,contentDetails,statistics",
        fields:
          "items(id,etag,snippet(channelId,title,description,publishedAt,tags,categoryId,defaultLanguage,defaultAudioLanguage,thumbnails(medium,high)),contentDetails(duration,caption),statistics(viewCount,likeCount,commentCount))",
        id: ids.join(","),
        maxResults: MAX_PAGE_SIZE,
      },
      ytVideoList,
    );
    return r.items;
  }

  async channelSectionsList(channelId: string) {
    const r = await this.call(
      "channelSections",
      { part: "snippet,contentDetails", fields: "items(id,snippet(type,title),contentDetails(channels))", channelId },
      ytChannelSections,
    );
    return r.items.map((s) => ({ type: s.snippet?.type, channels: s.contentDetails?.channels ?? [] }));
  }

  async searchChannels(p: { q: string; regionCode?: string; relevanceLanguage?: string; maxResults?: number }): Promise<SearchChannelHit[]> {
    const r = await this.call(
      "search",
      {
        part: "snippet",
        type: "channel",
        fields: "items(id(channelId),snippet(title,description,channelId,thumbnails(default,medium,high)))",
        q: p.q,
        regionCode: p.regionCode,
        relevanceLanguage: p.relevanceLanguage,
        maxResults: Math.min(p.maxResults ?? 25, 50),
      },
      ytSearchList,
    );
    return r.items
      .map((i) => ({
        channelId: i.id.channelId ?? i.snippet?.channelId ?? "",
        title: i.snippet?.title ?? "",
        description: i.snippet?.description ?? "",
        thumbnailUrl: bestThumb(i.snippet?.thumbnails),
      }))
      .filter((h) => h.channelId);
  }

  async captionsList(videoId: string, accessToken: string): Promise<CaptionTrack[]> {
    const r = await this.call("captions", { part: "snippet", videoId }, ytCaptionList, accessToken);
    return r.items.map((c) => ({
      id: c.id,
      language: c.snippet.language ?? "en",
      isAutoGenerated: c.snippet.trackKind === "asr",
      name: c.snippet.name,
    }));
  }

  async captionsDownload(captionId: string, accessToken: string): Promise<string> {
    const url = `${BASE}/captions/${encodeURIComponent(captionId)}?tfmt=vtt`;
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new YouTubeApiError(res.status, "captionDownloadFailed", res.statusText);
    return res.text();
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
