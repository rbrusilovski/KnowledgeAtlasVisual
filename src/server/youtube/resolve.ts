import { db } from "@/server/db";
import { redis, key } from "@/server/redis";
import { youtube, costOf } from "./index";
import { CACHE_TTL } from "./costs";
import { parseChannelInput, aliasKey, type ParsedInput } from "./resolver";

export type Resolution =
  | { status: "resolved"; youtubeId: string; via: string; aliases: string[]; inAtlas: boolean }
  | { status: "needsConfirmation"; query: string; cost: { bucket: string; units: number }; reason: string }
  | { status: "notFound"; reason: string }
  | { status: "invalid"; reason: string };

async function lookupAlias(alias: string): Promise<string | null> {
  const row = await db.channelAlias.findUnique({ where: { value: alias }, select: { channel: { select: { youtubeId: true } } } });
  if (row) return row.channel.youtubeId;
  return redis.get(key("resolve", alias));
}

async function remember(alias: string, youtubeId: string) {
  await redis.set(key("resolve", alias), youtubeId, "EX", CACHE_TTL.resolution);
}

async function finish(youtubeId: string, via: string, aliases: (string | null)[]): Promise<Resolution> {
  const list = aliases.filter((a): a is string => Boolean(a));
  for (const a of list) await remember(a, youtubeId);
  const inAtlas = Boolean(await db.channel.findUnique({ where: { youtubeId }, select: { id: true } }));
  return { status: "resolved", youtubeId, via, aliases: list, inAtlas };
}

export async function resolveChannelInput(input: string, opts: { confirmSearch?: boolean } = {}): Promise<Resolution> {
  const parsed: ParsedInput = parseChannelInput(input);
  if (parsed.kind === "invalid") return { status: "invalid", reason: parsed.reason };

  const alias = aliasKey(parsed);
  if (alias) {
    const known = await lookupAlias(alias);
    if (known) return finish(known, "alias", [alias]);
  }

  switch (parsed.kind) {
    case "id":
      return finish(parsed.value, "id", [alias]);
    case "handle": {
      const [c] = await youtube.getChannels({ forHandle: parsed.value });
      return c ? finish(c.id, "forHandle", [alias]) : { status: "notFound", reason: `No channel with handle @${parsed.value}` };
    }
    case "username": {
      const [c] = await youtube.getChannels({ forUsername: parsed.value });
      return c ? finish(c.id, "forUsername", [alias]) : { status: "notFound", reason: `No channel for /user/${parsed.value}` };
    }
    case "ambiguous": {
      const [byHandle] = await youtube.getChannels({ forHandle: parsed.value });
      if (byHandle) return finish(byHandle.id, "forHandle", [alias]);
      const userAlias = `user:${parsed.value.toLowerCase()}`;
      const [byUser] = /^[a-z0-9]{1,40}$/i.test(parsed.value) ? await youtube.getChannels({ forUsername: parsed.value }) : [];
      if (byUser) return finish(byUser.id, "forUsername", [userAlias]);
      return { status: "notFound", reason: `No channel found for “${parsed.value}”` };
    }
    case "video": {
      const videoAlias = `video:${parsed.value}`;
      const known = await lookupAlias(videoAlias);
      if (known) return finish(known, "alias", []);
      const [v] = await youtube.getVideos([parsed.value]);
      const channelId = v?.snippet?.channelId;
      if (!channelId) return { status: "notFound", reason: "Video not found" };
      await remember(videoAlias, channelId);
      return finish(channelId, "video", []);
    }
    case "custom": {
      if (!opts.confirmSearch) {
        return {
          status: "needsConfirmation",
          query: parsed.value,
          cost: costOf("search.list"),
          reason: `Legacy /c/${parsed.value} URLs have no direct lookup; resolving needs one YouTube search.`,
        };
      }
      const hits = await youtube.searchChannels({ q: parsed.value, maxResults: 5 });
      const first = hits[0];
      return first ? finish(first.channelId, "search", [alias]) : { status: "notFound", reason: `No channel found for /c/${parsed.value}` };
    }
  }
}
