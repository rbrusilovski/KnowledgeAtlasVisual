import type { Worker } from "bullmq";
import { db } from "@/server/db";
import { redis, key } from "@/server/redis";
import { getQueue, QUEUES, closeQueues, type QueueName } from "@/server/jobs";
import type { JobControl } from "@/server/services/ingestion";
import { NextRequest } from "next/server";
import { auth as betterAuth } from "@/server/auth";
import { createProposal, approveProposal, type Actor } from "@/server/services/expansion";
import type { ExpansionAuth } from "@/server/jobs";
import { FixtureYouTubeClient } from "@/server/youtube/fixture";
import type { PlaylistPage } from "@/server/youtube";
import type { YtVideo } from "@/server/youtube";

export const noopCtl: JobControl = { jobId: "test", progress: async () => {} };

export async function resetDb() {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  for (let attempt = 0; ; attempt++) {
    try {
      await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
      return;
    } catch (e) {
      // A straggling in-process job can hold row locks; back off and retry.
      if (attempt >= 5 || !String(e).includes("deadlock")) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

export async function flushRedis() {
  const stream = redis.scanStream({ match: `${key("")}*`, count: 500 });
  for await (const keys of stream as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
  const bull = redis.scanStream({ match: `${process.env.REDIS_PREFIX}-bull:*`, count: 500 });
  for await (const keys of bull as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
}

let served: QueueName[] = Object.values(QUEUES);
/** Queues that have an in-process worker in this test file (others are not drained). */
export function setServed(workers: Worker[]) {
  served = workers.map((w) => w.name as QueueName).filter((q) => q !== "scheduler" && q !== "compliance");
}

/** Wait until every served queue has nothing waiting/active/delayed-soon. */
export async function drain(timeoutMs = 120_000, queues: QueueName[] = served) {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < timeoutMs) {
    let busy = 0;
    for (const q of queues) {
      const c = await getQueue(q).getJobCounts("waiting", "active", "prioritized", "delayed");
      busy += (c.waiting ?? 0) + (c.active ?? 0) + (c.prioritized ?? 0);
      // Short (debounce) delays count as busy; long (quota) delays don't.
      const delayed = await getQueue(q).getDelayed(0, 50);
      busy += delayed.filter((j) => j.timestamp + (j.opts.delay ?? 0) - Date.now() < 30_000).length;
    }
    quiet = busy === 0 ? quiet + 1 : 0;
    if (quiet >= 3) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("queues did not drain in time");
}

export async function stopWorkers(workers: Worker[]) {
  await Promise.all(workers.map((w) => w.close(true)));
  await closeQueues();
}

export async function teardown(workers: Worker[] = []) {
  await stopWorkers(workers);
  await redis.quit();
  await db.$disconnect();
}

export const FIXTURE_CHANNEL = "UCSkce29rCKQIIQVOKKuihmk"; // "Ember Dev" (ai-ml)

// ── Approval + collection helpers ──────────────────────────────────────────

export async function makeUser(email: string, role: "USER" | "ADMIN" = "USER") {
  return db.user.upsert({ where: { email }, create: { id: `u-${email.replace(/[^a-z0-9]/gi, "")}`, name: email.split("@")[0]!, email, role }, update: { role } });
}
export const actorFor = (u: { id: string; role: "USER" | "ADMIN" }): Actor => ({ kind: "user", userId: u.id, role: u.role });

/** Create + approve a proposal as `user` (jobs are dispatched to BullMQ; run them with workers or call services). */
export async function approved(scope: unknown, user: { id: string; role: "USER" | "ADMIN" }) {
  const a = actorFor(user);
  const p = await createProposal({ scope, reason: "integration test" }, a);
  return approveProposal(p.id, a, p.scopeHash);
}
export const authOf = (p: { id: string; scopeHash: string }): ExpansionAuth => ({ proposalId: p.id, scopeHash: p.scopeHash });
export const ctlFor = (jobId: string): JobControl => ({ jobId, progress: async () => {} });

/**
 * Fixture transport with small playlist pages (so 20–60-video fixture channels span many pages) and optional fault
 * injection — used to test pagination, checkpoints and crash/resume without real quota.
 */
export class PagedFixture extends FixtureYouTubeClient {
  failVideosOnCall: number | null = null;
  videoCalls = 0;
  stripParts: ("statistics" | "snippet" | "contentDetails")[] = [];
  constructor(readonly pageSize = 7) {
    super();
  }
  override async playlistItemsList(playlistId: string, pageToken?: string): Promise<PlaylistPage> {
    const all: PlaylistPage["items"] = [];
    let t: string | undefined;
    do {
      const p = await super.playlistItemsList(playlistId, t);
      all.push(...p.items);
      t = p.nextPageToken;
    } while (t);
    const offset = pageToken ? Number(pageToken.slice(1)) : 0;
    const next = offset + this.pageSize < all.length ? `p${offset + this.pageSize}` : undefined;
    return { items: all.slice(offset, offset + this.pageSize), nextPageToken: next, totalResults: all.length };
  }
  override async videosList(ids: string[]): Promise<YtVideo[]> {
    this.videoCalls++;
    if (this.failVideosOnCall !== null && this.videoCalls === this.failVideosOnCall) throw new Error("injected crash");
    const out = await super.videosList(ids);
    return out.map((v) => {
      const c = { ...v } as Record<string, unknown>;
      for (const part of this.stripParts) delete c[part];
      return c as YtVideo;
    });
  }
}

/** Ordered upload ids (newest first) of a fixture channel, as the API would list them. */
export async function fixtureUploads(channelYoutubeId: string): Promise<string[]> {
  const c = new FixtureYouTubeClient();
  const [ch] = await c.channelsList({ ids: [channelYoutubeId] });
  const out: string[] = [];
  let t: string | undefined;
  do {
    const p = await c.playlistItemsList(ch!.contentDetails!.relatedPlaylists!.uploads!, t);
    out.push(...p.items.map((i) => i.videoId));
    t = p.nextPageToken;
  } while (t);
  return out;
}

// ── HTTP helpers (route handlers with real Better Auth sessions) ───────────
export const ORIGIN = "http://localhost:3000";
export async function signUp(email: string) {
  const res = await betterAuth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! }, asResponse: true });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return { user, cookie };
}
export function req(url: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(url, ORIGIN), {
    method: init.method ?? "GET",
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.method && init.method !== "GET" ? { origin: ORIGIN } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
export const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
