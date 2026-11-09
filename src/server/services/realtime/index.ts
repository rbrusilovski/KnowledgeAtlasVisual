import type { Redis } from "ioredis";
import { redis, key, createRedis } from "@/server/redis";
import { log } from "@/server/logger";

export type EventType = "job.progress" | "job.completed" | "job.failed" | "graph.delta" | "quota.updated" | "proposal.created" | "proposal.updated";

export interface AtlasEvent {
  type: EventType;
  /** "global" or a userId (→ events:user:{id}). */
  scope: "global" | { userId: string };
  payload: Record<string, unknown>;
}

export interface DeliveredEvent {
  id: string;
  type: EventType;
  channel: string;
  payload: Record<string, unknown>;
}

const STREAM_MAXLEN = 1000;

export function channelFor(scope: AtlasEvent["scope"]): string {
  return scope === "global" ? "events:global" : `events:user:${scope.userId}`;
}

/** Publish to Redis pub/sub AND append to a capped stream so reconnecting clients can replay (Last-Event-ID). */
export async function publish(ev: AtlasEvent): Promise<string> {
  const channel = channelFor(ev.scope);
  const body = JSON.stringify({ type: ev.type, payload: ev.payload });
  const id = (await redis.xadd(key("stream", channel), "MAXLEN", "~", STREAM_MAXLEN, "*", "e", body)) as string;
  await redis.publish(key(channel), JSON.stringify({ id, ...JSON.parse(body) }));
  return id;
}

/** Events after `lastId` on the given channels (for Last-Event-ID resume). */
export async function replaySince(channels: string[], lastId: string): Promise<DeliveredEvent[]> {
  const out: DeliveredEvent[] = [];
  for (const channel of channels) {
    const entries = (await redis.xrange(key("stream", channel), `(${lastId}`, "+", "COUNT", 200)) as [string, string[]][];
    for (const [id, fields] of entries) {
      const e = JSON.parse(fields[1] ?? "{}") as { type: EventType; payload: Record<string, unknown> };
      out.push({ id, channel, type: e.type, payload: e.payload });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ── Single subscriber per process, fanned out in-process ───────────────────

type Listener = (e: DeliveredEvent) => void;

interface Hub {
  sub: Redis | null;
  listeners: Map<string, Set<Listener>>;
  subscribed: Set<string>;
}

const g = globalThis as unknown as { __atlasHub?: Hub };
const hub: Hub = (g.__atlasHub ??= { sub: null, listeners: new Map(), subscribed: new Set() });

function ensureSub(): Redis {
  if (hub.sub) return hub.sub;
  const sub = createRedis({ maxRetriesPerRequest: null });
  sub.on("message", (rawChannel: string, msg: string) => {
    const channel = rawChannel.slice(key("").length);
    const set = hub.listeners.get(channel);
    if (!set?.size) return;
    try {
      const e = JSON.parse(msg) as { id: string; type: EventType; payload: Record<string, unknown> };
      for (const l of set) l({ id: e.id, type: e.type, payload: e.payload, channel });
    } catch (err) {
      log().warn({ err }, "bad realtime message");
    }
  });
  sub.on("error", (err) => log().warn({ err }, "realtime subscriber error"));
  hub.sub = sub;
  return sub;
}

export function subscribe(channels: string[], listener: Listener): () => void {
  const sub = ensureSub();
  for (const c of channels) {
    let set = hub.listeners.get(c);
    if (!set) hub.listeners.set(c, (set = new Set()));
    set.add(listener);
    if (!hub.subscribed.has(c)) {
      hub.subscribed.add(c);
      void sub.subscribe(key(c));
    }
  }
  return () => {
    for (const c of channels) {
      const set = hub.listeners.get(c);
      set?.delete(listener);
      if (set && set.size === 0) {
        hub.listeners.delete(c);
        hub.subscribed.delete(c);
        void sub.unsubscribe(key(c));
      }
    }
  };
}

export function connectionCount(): number {
  let n = 0;
  for (const s of hub.listeners.values()) n += s.size;
  return n;
}
