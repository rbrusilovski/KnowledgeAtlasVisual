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
      .map((c) => ({ ...c, statistics: c.statistics && { ...c.statistics, videoCount: BigInt(this.visibleCount(c)) } }));
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
      items: page.map((u) => ({ videoId: u.id, publishedAt: u.publishedAt })),
      nextPageToken: next,
      totalResults: list.length,
    };
  }

  async videosList(ids: string[]) {
    const s = loadFixtures();
    if (ids.length > MAX_IDS_PER_CALL) throw new YouTubeApiError(400, "invalidParameter", "Too many ids");
    return ids
      .filter((id) => !s.removed.has(id))
      .map((id) => s.videos.get(id))
      .filter((v): v is YtVideo & { __raw: unknown } => Boolean(v) && visible(v!.snippet!.publishedAt))
      .map(({ __raw: _r, ...v }) => v as YtVideo);
  }

  async channelSectionsList(channelId: string) {
    return loadFixtures().sections.get(channelId) ?? [];
  }

  async searchChannels(p: { q: string; maxResults?: number }): Promise<SearchChannelHit[]> {
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
