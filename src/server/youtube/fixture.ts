import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ytChannel, ytVideo, bestThumb, type YtChannel, type YtVideo } from "./schemas";
import { YouTubeApiError, type RawYouTubeClient, type PlaylistPage, type SearchChannelHit, type CaptionTrack } from "./types";
import { MAX_IDS_PER_CALL, MAX_PAGE_SIZE } from "./costs";

export interface FixtureChannelFile {
  channel: unknown;
  username?: string;
  sections: { snippet: { type: string; title?: string }; contentDetails: { channels: string[] } }[];
  videos: unknown[];
  transcripts: Record<string, string>;
}

interface FixtureStore {
  channels: Map<string, YtChannel>;
  byHandle: Map<string, string>;
  byUsername: Map<string, string>;
  uploads: Map<string, { id: string; publishedAt: string }[]>; // playlistId → newest-first
  videos: Map<string, YtVideo & { __raw: unknown }>;
  sections: Map<string, { type?: string; channels: string[] }[]>;
  transcripts: Map<string, string>;
  /** Channels with `isAvailable=false` simulation (deleted upstream) — set via FIXTURE_REMOVED. */
  removed: Set<string>;
  /** IDs still listed in uploads playlists but not returned by videos.list (private/deleted lag) — FIXTURE_UNAVAILABLE. */
  unavailable: Set<string>;
}

let store: FixtureStore | null = null;

export function fixtureDir(): string {
  return process.env.FIXTURE_DIR ?? path.join(process.cwd(), "fixtures", "youtube");
}

/** Fixture clock: videos "published" after now are hidden, so incremental sync finds new uploads over time. */
export function fixtureNow(): number {
  return process.env.FIXTURE_NOW ? Date.parse(process.env.FIXTURE_NOW) : Date.now();
}

export function loadFixtures(): FixtureStore {
  if (store) return store;
  const dir = path.join(fixtureDir(), "channels");
  if (!existsSync(dir)) throw new Error(`Fixture dataset missing at ${dir}. Run \`pnpm fixtures:generate\`.`);
  const s: FixtureStore = {
    channels: new Map(),
    byHandle: new Map(),
    byUsername: new Map(),
    uploads: new Map(),
    videos: new Map(),
    sections: new Map(),
    transcripts: new Map(),
    removed: new Set((process.env.FIXTURE_REMOVED ?? "").split(",").filter(Boolean)),
    unavailable: new Set((process.env.FIXTURE_UNAVAILABLE ?? "").split(",").filter(Boolean)),
  };
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const file = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as FixtureChannelFile;
    const ch = ytChannel.parse(file.channel);
    s.channels.set(ch.id, ch);
    const handle = ch.snippet?.customUrl?.replace(/^@/, "").toLowerCase();
    if (handle) s.byHandle.set(handle, ch.id);
    if (file.username) s.byUsername.set(file.username.toLowerCase(), ch.id);
    const uploads: { id: string; publishedAt: string }[] = [];
    for (const raw of file.videos) {
      const v = ytVideo.parse(raw);
      s.videos.set(v.id, Object.assign(v, { __raw: raw }));
      uploads.push({ id: v.id, publishedAt: v.snippet!.publishedAt });
    }
    uploads.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const pl = ch.contentDetails?.relatedPlaylists?.uploads;
    if (pl) s.uploads.set(pl, uploads);
    s.sections.set(ch.id, file.sections.map((x) => ({ type: x.snippet.type, channels: x.contentDetails.channels })));
    for (const [vid, vtt] of Object.entries(file.transcripts)) s.transcripts.set(vid, vtt);
  }
  store = s;
  return s;
}

/** For tests: drop the cached store so env overrides (FIXTURE_REMOVED) take effect. */
export function resetFixtureStore() {
  store = null;
}

function visible(publishedAt: string) {
  return Date.parse(publishedAt) <= fixtureNow();
}

/** Deterministic 0..1 value per id (FNV-1a) so fixture variation is stable across runs. */
export function fixtureRoll(id: string, salt: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${salt}:${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0) / 0xffffffff;
}

/**
 * The committed dataset predates full-field collection. Enrich responses at read time — deterministically — with the
 * parts the live client now requests, including realistic gaps: ~12% of videos hide likes, ~6% have comments
 * disabled, maxres/standard thumbnails exist only for some uploads. Mirrors what the real API returns.
 */
function enrichChannel(c: YtChannel): YtChannel {
  const t = c.snippet?.thumbnails;
  const dims = { default: [88, 88], medium: [240, 240], high: [800, 800] } as const;
  return {
    ...c,
    snippet: c.snippet && {
      ...c.snippet,
      defaultLanguage: c.snippet.defaultLanguage ?? "en",
      thumbnails: t && Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { ...v, width: dims[k as keyof typeof dims]?.[0], height: dims[k as keyof typeof dims]?.[1] }])),
    },
    topicDetails: c.topicDetails && { ...c.topicDetails, topicIds: c.topicDetails.topicIds ?? (c.topicDetails.topicCategories ?? []).map((_, i) => `/m/fx${i}`) },
    status: c.status ?? { privacyStatus: "public", isLinked: true, madeForKids: false },
  };
}

function enrichVideo(v: YtVideo, channel: YtChannel | undefined): YtVideo {
  const t = v.snippet?.thumbnails ?? {};
  const base = t.high?.url ?? t.medium?.url ?? "";
  const thumbnails: NonNullable<NonNullable<YtVideo["snippet"]>["thumbnails"]> = {
    default: { url: base, width: 120, height: 90 },
    medium: { url: t.medium?.url ?? base, width: 320, height: 180 },
    high: { url: t.high?.url ?? base, width: 480, height: 360 },
  };
  if (fixtureRoll(v.id, "standard") < 0.6) thumbnails.standard = { url: base, width: 640, height: 480 };
  if (fixtureRoll(v.id, "maxres") < 0.3) thumbnails.maxres = { url: base, width: 1280, height: 720 };
  const stats = { ...v.statistics };
  if (fixtureRoll(v.id, "likes") < 0.12) delete stats.likeCount;
  if (fixtureRoll(v.id, "comments") < 0.06) delete stats.commentCount;
  return {
    ...v,
    snippet: v.snippet && { ...v.snippet, channelTitle: v.snippet.channelTitle ?? channel?.snippet?.title, liveBroadcastContent: v.snippet.liveBroadcastContent ?? "none", defaultAudioLanguage: v.snippet.defaultAudioLanguage ?? "en", thumbnails },
    contentDetails: v.contentDetails && { ...v.contentDetails, dimension: "2d", definition: fixtureRoll(v.id, "hd") < 0.85 ? "hd" : "sd", projection: "rectangular", licensedContent: false },
    status: v.status ?? { uploadStatus: "processed", privacyStatus: "public", license: "youtube", embeddable: true, publicStatsViewable: true, madeForKids: false },
    statistics: stats,
    topicDetails: v.topicDetails ?? { topicCategories: channel?.topicDetails?.topicCategories ?? [] },
  };
}

const tokenize = (s: string): string[] => s.toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? [];

/** Reads API-shaped JSON from fixtures/youtube; responses mirror real shapes so the same pipeline runs. */
export class FixtureYouTubeClient implements RawYouTubeClient {
  readonly mode = "fixture" as const;

  async channelsList(p: { ids?: string[]; forHandle?: string; forUsername?: string }) {
    const s = loadFixtures();
    if (p.ids && p.ids.length > MAX_IDS_PER_CALL) throw new YouTubeApiError(400, "invalidParameter", "Too many ids");
    let ids: string[] = [];
    if (p.ids) ids = p.ids;
    else if (p.forHandle) ids = [s.byHandle.get(p.forHandle.replace(/^@/, "").toLowerCase()) ?? ""];
    else if (p.forUsername) ids = [s.byUsername.get(p.forUsername.toLowerCase()) ?? ""];
    return ids
      .filter((id) => !s.removed.has(id))
      .map((id) => s.channels.get(id))
      .filter((c): c is YtChannel => Boolean(c))
      .map((c) => enrichChannel({ ...c, statistics: c.statistics && { ...c.statistics, videoCount: BigInt(this.visibleCount(c)) } }));
  }

  private visibleCount(c: YtChannel) {
    const pl = c.contentDetails?.relatedPlaylists?.uploads;
    return (pl ? loadFixtures().uploads.get(pl) ?? [] : []).filter((u) => visible(u.publishedAt)).length;
  }

  async playlistItemsList(playlistId: string, pageToken?: string): Promise<PlaylistPage> {
    const s = loadFixtures();
    const all = s.uploads.get(playlistId);
    if (!all) throw new YouTubeApiError(404, "playlistNotFound", "Playlist not found");
    const list = all.filter((u) => visible(u.publishedAt) && !s.removed.has(u.id));
    const offset = pageToken ? Number(pageToken.replace(/^o/, "")) || 0 : 0;
    const page = list.slice(offset, offset + MAX_PAGE_SIZE);
    const next = offset + MAX_PAGE_SIZE < list.length ? `o${offset + MAX_PAGE_SIZE}` : undefined;
    return {
      items: page.map((u) => ({ videoId: u.id, publishedAt: u.publishedAt, privacyStatus: "public" })),
      nextPageToken: next,
      totalResults: list.length,
    };
  }

  async videosList(ids: string[]) {
    const s = loadFixtures();
    if (ids.length > MAX_IDS_PER_CALL) throw new YouTubeApiError(400, "invalidParameter", "Too many ids");
    return ids
      .filter((id) => !s.removed.has(id) && !s.unavailable.has(id))
      .map((id) => s.videos.get(id))
      .filter((v): v is YtVideo & { __raw: unknown } => Boolean(v) && visible(v!.snippet!.publishedAt))
      .map(({ __raw: _r, ...v }) => enrichVideo(v as YtVideo, s.channels.get(v.snippet!.channelId)));
  }

  async channelSectionsList(channelId: string) {
    return loadFixtures().sections.get(channelId) ?? [];
  }

  /** regionCode biases (not filters) results toward that country, like the real API; all fixture content is English. */
  async searchChannels(p: { q: string; maxResults?: number; regionCode?: string }): Promise<SearchChannelHit[]> {
    const s = loadFixtures();
    const q = new Set(tokenize(p.q));
    if (!q.size) return [];
    const scored = [...s.channels.values()]
      .filter((c) => !s.removed.has(c.id))
      .map((c) => {
        const title = tokenize(c.snippet?.title ?? "");
        const body = tokenize(`${c.snippet?.description ?? ""} ${c.brandingSettings?.channel?.keywords ?? ""}`);
        let score = 0;
        for (const t of q) {
          if (title.includes(t)) score += 3;
          score += body.filter((b) => b === t).length;
        }
        if (score > 0 && p.regionCode && c.snippet?.country === p.regionCode) score += 2;
        return { c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id))
      .slice(0, Math.min(p.maxResults ?? 25, 50));
    return scored.map(({ c }) => ({
      channelId: c.id,
      title: c.snippet?.title ?? "",
      description: c.snippet?.description ?? "",
      thumbnailUrl: bestThumb(c.snippet?.thumbnails),
    }));
  }

  async captionsList(): Promise<CaptionTrack[]> {
    // Fixture channels are never "owned" by the signed-in user.
    throw new YouTubeApiError(403, "forbidden", "Fixture mode does not support owner captions");
  }

  async captionsDownload(): Promise<string> {
    throw new YouTubeApiError(403, "forbidden", "Fixture mode does not support owner captions");
  }
}

/** Used by the fixture transcript provider. */
export function fixtureTranscript(videoId: string): string | undefined {
  return loadFixtures().transcripts.get(videoId);
}
