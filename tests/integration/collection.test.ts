/**
 * YouTube collection under approval — services called directly with the job IDs a worker would use (no workers run
 * in this file, so dispatched jobs just sit in the queue). Covers metadata/coverage, bounds, checkpoints and
 * crash/resume, sync, partial responses, unavailable items, approval enforcement and the compliance lifecycle.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { enqueueExpansion } from "@/server/jobs";
import * as ingestion from "@/server/services/ingestion";
import { runCompliance } from "@/server/services/compliance";
import { inspectChannel, inspectVideo, inspectAtlas } from "@/server/services/coverage";
import {
  approveProposal,
  authorizeJob,
  cancelProposal,
  createProposal,
  expireProposals,
  rejectProposal,
  scopeHash,
} from "@/server/services/expansion";
import { markExhausted } from "@/server/services/quota";
import { setRawClient } from "@/server/youtube";
import { resetFixtureStore } from "@/server/youtube/fixture";
import { actorFor, approved, authOf, ctlFor, fixtureUploads, flushRedis, makeUser, PagedFixture, resetDb, teardown, FIXTURE_CHANNEL } from "./helpers";

const DAY = 86_400_000;
let owner: Awaited<ReturnType<typeof makeUser>>;
let admin: Awaited<ReturnType<typeof makeUser>>;

const addScope = (max = 300, yt = FIXTURE_CHANNEL) => ({ kind: "ADD_CHANNELS", channels: [{ youtubeId: yt, aliases: [] }], maxVideosPerChannel: max, includeTranscripts: true });

async function ingest(max = 300, yt = FIXTURE_CHANNEL) {
  const p = await approved(addScope(max, yt), owner);
  const r = await ingestion.ingestChannel({ auth: authOf(p), lane: "interactive", youtubeId: yt }, ctlFor(p.jobIds[0]!));
  return { p, r };
}

beforeEach(async () => {
  await resetDb();
  await flushRedis();
  setRawClient(null);
  owner = await makeUser("owner@atlas.test");
  admin = await makeUser("admin@atlas.test", "ADMIN");
});
afterEach(() => {
  setRawClient(null);
  delete process.env.FIXTURE_NOW;
  delete process.env.FIXTURE_REMOVED;
  delete process.env.FIXTURE_UNAVAILABLE;
  resetFixtureStore();
});
afterAll(async () => teardown());

describe("metadata + coverage", () => {
  it("collects full channel/video metadata, thumbnail variants and statistics availability without search", async () => {
    const { p, r } = await ingest();
    expect(r.status).toBe("completed");
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    expect(ch.uploadsPlaylistId).toBe(`UU${FIXTURE_CHANNEL.slice(2)}`);
    expect((ch.thumbnails as { variant: string; width: number }[]).map((t) => t.variant)).toEqual(["default", "medium", "high"]);
    expect((ch.thumbnails as { width: number }[])[0]!.width).toBe(88);
    expect(ch.topicIds.length).toBeGreaterThan(0);
    expect(ch.privacyStatus).toBe("public");

    const videos = await db.video.findMany({ where: { channelId: ch.id } });
    expect(videos.length).toBe(r.videos.created);
    const v = videos[0]!;
    expect(v.channelTitle).toBe(ch.title);
    expect(v.definition).toMatch(/hd|sd/);
    expect((v.thumbnails as unknown[]).length).toBeGreaterThanOrEqual(3);
    expect(v.thumbnailUrl).toBeTruthy();
    // Some fixture videos hide likes: stored as NULL (never 0) with a reason in coverage.
    const hidden = videos.filter((x) => x.likeCount === null);
    expect(hidden.length).toBeGreaterThan(0);
    const cov = await inspectVideo(hidden[0]!.id);
    expect((cov.groups.find((g) => g.group === "STATISTICS")!.details as { likes: string }).likes).toBe("HIDDEN");
    expect(cov.complete).toBe(true); // hidden likes don't make the record incomplete

    const run = await db.ingestionRun.findFirstOrThrow({ where: { targetId: FIXTURE_CHANNEL, kind: "ingest" } });
    expect(run).toMatchObject({ status: "completed", searchCalls: 0, proposalId: p.id, scopeHash: p.scopeHash });
    expect(run.unitsUsed).toBeGreaterThanOrEqual(3);
  });

  it("a video without any accessible transcript still counts as collected", async () => {
    await ingest();
    const noTx = await db.video.findFirstOrThrow({ where: { hasTranscript: false } });
    const cov = await inspectVideo(noTx.id);
    expect(cov.complete).toBe(true);
    expect(cov.groups.find((g) => g.group === "TRANSCRIPT")!.required).toBe(false);
    const atlas = await inspectAtlas();
    expect(atlas.videos.complete).toBe(atlas.videos.total);
  });

  it("records upload-history progress and channel coverage", async () => {
    await ingest();
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    const c = await inspectChannel(ch.id);
    expect(c.complete).toBe(true);
    expect(c.history).toMatchObject({ state: "COMPLETE_TO_SOURCE_LIMIT", hasMore: false, unavailable: 0 });
    expect(c.history!.itemsSeen).toBe((await fixtureUploads(FIXTURE_CHANNEL)).length);
    expect(c.history!.oldestPublishedAt).toBeTruthy();
  });

  it("partial API responses never erase stored values or extend retention", async () => {
    await ingest();
    const v = await db.video.findFirstOrThrow({ where: { viewCount: { not: null } } });
    const before = await db.fieldCoverage.findUniqueOrThrow({ where: { videoId_group: { videoId: v.id, group: "STATISTICS" } } });
    const t = new PagedFixture();
    t.stripParts = ["statistics"];
    setRawClient(t);
    await new Promise((r) => setTimeout(r, 20));
    const p = await approved({ kind: "REFRESH_METADATA", channelYoutubeIds: [], videoYoutubeIds: [v.youtubeId], fields: "all", purpose: "user" }, owner);
    await ingestion.refreshMetadata({ auth: authOf(p), lane: "interactive", channelYoutubeIds: [], videoYoutubeIds: [v.youtubeId] }, ctlFor(p.jobIds[0]!));
    const after = await db.video.findUniqueOrThrow({ where: { id: v.id } });
    expect(after.viewCount).toBe(v.viewCount);
    const cov = await db.fieldCoverage.findUniqueOrThrow({ where: { videoId_group: { videoId: v.id, group: "STATISTICS" } } });
    expect(cov.status).toBe("NOT_RETURNED");
    expect(cov.lastSuccessAt).toEqual(before.lastSuccessAt);
    expect(cov.retentionDeadline).toEqual(before.retentionDeadline);
    const text = await db.fieldCoverage.findUniqueOrThrow({ where: { videoId_group: { videoId: v.id, group: "TEXT" } } });
    expect(text.lastSuccessAt!.getTime()).toBeGreaterThan(before.lastSuccessAt!.getTime());
  });

  it("playlist items videos.list does not return are counted as unavailable, not created", async () => {
    const ids = await fixtureUploads(FIXTURE_CHANNEL);
    process.env.FIXTURE_UNAVAILABLE = ids.slice(0, 2).join(",");
    resetFixtureStore();
    const { r } = await ingest();
    expect(r.videos.unavailable).toBe(2);
    expect(await db.video.count({ where: { youtubeId: { in: ids.slice(0, 2) } } })).toBe(0);
    const h = await db.uploadHistory.findFirstOrThrow();
    expect(h.unavailableCount).toBe(2);
    expect(h.itemsSeen).toBe(ids.length);
  });
});

describe("bounds, checkpoints and resumability", () => {
  it("initial ingest stops exactly at the approved video bound mid-page and is idempotent on retry", async () => {
    const { p, r } = await ingest(30);
    expect(r.videos.created).toBe(30);
    expect(r.hasMore).toBe(true);
    const h = await db.uploadHistory.findFirstOrThrow();
    expect(h).toMatchObject({ state: "INITIAL_WINDOW_COLLECTED", itemsSeen: 30, pageOffset: 30, nextPageToken: null });
    // Retrying the same approved job (e.g. BullMQ retry after a crash) does no extra work.
    const again = await ingestion.ingestChannel({ auth: authOf(p), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, ctlFor(p.jobIds[0]!));
    expect(again.videos.created).toBe(30); // cumulative progress for this job, unchanged
    expect(await db.video.count()).toBe(30);
    expect((await db.uploadHistory.findFirstOrThrow()).itemsSeen).toBe(30);
  });

  it("backfill continues from the checkpoint without gaps or duplicates, pauses at its page bound", async () => {
    setRawClient(new PagedFixture(7));
    await ingest(10);
    const uploads = await fixtureUploads(FIXTURE_CHANNEL);
    const p = await approved({ kind: "BACKFILL_HISTORY", channelYoutubeId: FIXTURE_CHANNEL, maxPages: 2, maxVideos: 1000, includeTranscripts: false }, owner);
    const out = await ingestion.backfillHistory({ auth: authOf(p), lane: "background", youtubeId: FIXTURE_CHANNEL, slice: 0 }, ctlFor(p.jobIds[0]!));
    expect(out.pages).toBe(2);
    expect(out.state).toBe("PAUSED_AWAITING_APPROVAL");
    const have = (await db.video.findMany({ select: { youtubeId: true } })).map((v) => v.youtubeId).sort();
    // 10 from the initial window (page 1 = 7 + 3 of page 2), then the remaining 4 of page 2 + all 7 of page 3.
    expect(have).toEqual(uploads.slice(0, 21).sort());
    expect((await db.uploadHistory.findFirstOrThrow()).state).toBe("PAUSED_AWAITING_APPROVAL");
  });

  it("an interrupted backfill resumes at the first uncommitted page", async () => {
    const t = new PagedFixture(5);
    setRawClient(t);
    await ingest(5); // 1 page
    const uploads = await fixtureUploads(FIXTURE_CHANNEL);
    const p = await approved({ kind: "BACKFILL_HISTORY", channelYoutubeId: FIXTURE_CHANNEL, maxPages: 100, maxVideos: 1000, includeTranscripts: false }, owner);
    t.videoCalls = 0;
    t.failVideosOnCall = 3; // crash while collecting the 3rd backfill page
    await expect(ingestion.backfillHistory({ auth: authOf(p), lane: "background", youtubeId: FIXTURE_CHANNEL, slice: 0 }, ctlFor(p.jobIds[0]!))).rejects.toThrow("injected crash");
    expect(await db.video.count()).toBe(15); // initial 5 + 2 committed backfill pages
    const h = await db.uploadHistory.findFirstOrThrow();
    expect(h.state).toBe("FAILED_RETRYABLE");
    t.failVideosOnCall = null;
    // BullMQ retry of the same job: resumes, finishes the slice (10 pages), registers a continuation.
    const out = await ingestion.backfillHistory({ auth: authOf(p), lane: "background", youtubeId: FIXTURE_CHANNEL, slice: 0 }, ctlFor(p.jobIds[0]!));
    let slice = 1;
    let cont = out.continuation;
    while (cont) {
      const r = await ingestion.backfillHistory({ auth: authOf(p), lane: "background", youtubeId: FIXTURE_CHANNEL, slice }, ctlFor(cont));
      cont = r.continuation;
      slice++;
    }
    const have = (await db.video.findMany({ select: { youtubeId: true } })).map((v) => v.youtubeId).sort();
    expect(have).toEqual([...uploads].sort());
    const done = await db.uploadHistory.findFirstOrThrow();
    expect(done.state).toBe("COMPLETE_TO_SOURCE_LIMIT");
    expect(done.itemsSeen).toBe(uploads.length);
    expect(done.completedAt).toBeTruthy();
  });

  it("incremental sync stops at the first known upload and respects its bound", async () => {
    process.env.FIXTURE_NOW = new Date(Date.now() - 60 * DAY).toISOString();
    resetFixtureStore();
    await ingest();
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    const initial = await db.video.count({ where: { channelId: ch.id } });
    delete process.env.FIXTURE_NOW;
    await flushRedis();
    const p = await approved({ kind: "SYNC_UPLOADS", channelYoutubeIds: [FIXTURE_CHANNEL], maxNewVideosPerChannel: 1, includeTranscripts: false }, owner);
    const s = await ingestion.syncChannel({ auth: authOf(p), lane: "background", youtubeId: FIXTURE_CHANNEL }, ctlFor(p.jobIds[0]!));
    expect(s.newVideos).toBe(1);
    expect(s.boundReached).toBe(true);
    expect(await db.video.count({ where: { channelId: ch.id } })).toBe(initial + 1);
    const p2 = await approved({ kind: "SYNC_UPLOADS", channelYoutubeIds: [FIXTURE_CHANNEL], maxNewVideosPerChannel: 200, includeTranscripts: false }, owner);
    const s2 = await ingestion.syncChannel({ auth: authOf(p2), lane: "background", youtubeId: FIXTURE_CHANNEL }, ctlFor(p2.jobIds[0]!));
    expect(s2.boundReached).toBe(false);
    const p3 = await approved({ kind: "SYNC_UPLOADS", channelYoutubeIds: [FIXTURE_CHANNEL], maxNewVideosPerChannel: 200, includeTranscripts: false }, owner);
    const s3 = await ingestion.syncChannel({ auth: authOf(p3), lane: "background", youtubeId: FIXTURE_CHANNEL }, ctlFor(p3.jobIds[0]!));
    expect(s3).toMatchObject({ newVideos: 0, pages: 1 });
    expect(s3.units).toBeLessThanOrEqual(3);
  });

  it("scheduled sync only proposes — it never adds uploads by itself", async () => {
    process.env.FIXTURE_NOW = new Date(Date.now() - 60 * DAY).toISOString();
    resetFixtureStore();
    await ingest();
    await db.channel.updateMany({ data: { lastSyncedAt: new Date(Date.now() - 30 * DAY) } });
    delete process.env.FIXTURE_NOW;
    const n = await db.video.count();
    const r = await ingestion.scheduleDueSyncs();
    expect(r.proposed).toBe(1);
    expect(await db.video.count()).toBe(n);
    const p = await db.expansionProposal.findUniqueOrThrow({ where: { id: r.proposalId! } });
    expect(p).toMatchObject({ source: "SYSTEM", status: "PENDING", kind: "SYNC_UPLOADS", createdByUserId: null });
    expect((await ingestion.scheduleDueSyncs()).skipped).toBe("pending proposal exists");
  });
});

describe("approval enforcement", () => {
  it("rejects jobs without, or outside, an approved scope", async () => {
    const p = await approved(addScope(5), owner);
    const job = p.jobIds[0]!;
    const run = (auth: Parameters<typeof ingestion.ingestChannel>[0]["auth"], jobId = job, yt = FIXTURE_CHANNEL) => ingestion.ingestChannel({ auth, lane: "interactive", youtubeId: yt }, ctlFor(jobId));
    await expect(run(undefined as never)).rejects.toThrow(/No approved proposal/);
    await expect(run({ proposalId: p.id, scopeHash: "0".repeat(64) })).rejects.toThrow(/Scope hash mismatch/);
    await expect(run(authOf(p), "x-forged-job")).rejects.toThrow(/not registered/);
    await expect(run(authOf(p), job, "UCEuOyNcOAiA66JNfVjlPDS6")).rejects.toThrow(/outside the approved scope/);
    await expect(ingestion.syncChannel({ auth: authOf(p), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, ctlFor(job))).rejects.toThrow(/does not authorize/);
    expect(await db.channel.count()).toBe(0);
  });

  it("tampering with the stored scope invalidates the approval", async () => {
    const p = await approved(addScope(5), owner);
    await db.expansionProposal.update({ where: { id: p.id }, data: { scope: { ...addScope(5000) } } });
    await expect(authorizeJob(authOf(p), p.jobIds[0], "ADD_CHANNELS")).rejects.toThrow(/integrity/);
  });

  it("pending, rejected, expired, cancelled and completed proposals execute nothing", async () => {
    const a = actorFor(owner);
    const pending = await createProposal({ scope: addScope(5), reason: "t" }, a);
    await expect(authorizeJob(authOf(pending), "x", "ADD_CHANNELS")).rejects.toThrow(/pending/);
    await rejectProposal(pending.id, a, pending.scopeHash);
    await expect(approveProposal(pending.id, a, pending.scopeHash)).rejects.toThrow(/rejected/);

    const exp = await createProposal({ scope: addScope(6), reason: "t", expiresAt: new Date(Date.now() - 1000) }, a);
    await expect(approveProposal(exp.id, a, exp.scopeHash)).rejects.toThrow(/expired/);
    expect((await db.expansionProposal.findUniqueOrThrow({ where: { id: exp.id } })).status).toBe("EXPIRED");

    const run = await approved(addScope(7), owner);
    await cancelProposal(run.id, a);
    await expect(ingestion.ingestChannel({ auth: authOf(run), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, ctlFor(run.jobIds[0]!))).rejects.toThrow(/cancelled/);

    const done = await approved(addScope(8), owner);
    await db.expansionProposal.update({ where: { id: done.id }, data: { status: "COMPLETED" } });
    await expect(ingestion.ingestChannel({ auth: authOf(done), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, ctlFor(done.jobIds[0]!))).rejects.toThrow(/completed/);
    expect(await db.channel.count()).toBe(0);
  });

  it("approval is explicit, user-specific, single-use and scope-bound; agents and the system cannot approve", async () => {
    const a = actorFor(owner);
    const other = actorFor(await makeUser("other@atlas.test"));
    const p = await createProposal({ scope: addScope(5), reason: "t" }, { kind: "agent", userId: owner.id });
    expect(p.source).toBe("CLAUDE");
    await expect(approveProposal(p.id, { kind: "agent", userId: owner.id }, p.scopeHash)).rejects.toThrow(/Only a signed-in user/);
    await expect(approveProposal(p.id, { kind: "system" }, p.scopeHash)).rejects.toThrow(/Only a signed-in user/);
    await expect(approveProposal(p.id, other, p.scopeHash)).rejects.toThrow(/not found/);
    await expect(approveProposal(p.id, a, scopeHash({ ...addScope(500) } as never))).rejects.toThrow(/no longer matches/);
    const ok = await approveProposal(p.id, a, p.scopeHash);
    expect(ok.status).toBe("RUNNING");
    expect(ok.approvedByUserId).toBe(owner.id);
    await expect(approveProposal(p.id, a, p.scopeHash)).rejects.toThrow(/single-use/);
  });

  it("SYSTEM proposals need an admin; CLI approval is fixture-only", async () => {
    const p = await createProposal({ scope: addScope(5), reason: "scheduled" }, { kind: "system" });
    await expect(approveProposal(p.id, actorFor(owner), p.scopeHash)).rejects.toThrow(/not found/);
    expect((await approveProposal(p.id, actorFor(admin), p.scopeHash)).status).toBe("RUNNING");
  });

  it("queue producers refuse unregistered expansion jobs", async () => {
    const p = await approved(addScope(5), owner);
    await expect(enqueueExpansion("ingest-channel", { auth: authOf(p), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, "x-not-registered")).rejects.toThrow(/not authorized/);
  });

  it("refuses proposals for channels already present, and expires stale pending proposals", async () => {
    await ingest(5);
    await expect(createProposal({ scope: addScope(5), reason: "t" }, actorFor(owner))).rejects.toThrow(/already in the atlas/);
    const p = await createProposal({ scope: { kind: "SYNC_UPLOADS", channelYoutubeIds: [FIXTURE_CHANNEL], maxNewVideosPerChannel: 5, includeTranscripts: false }, reason: "t" }, actorFor(owner));
    await db.expansionProposal.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await expireProposals()).expired).toBe(1);
  });

  it("estimates come from central costs and never require search for known channels", async () => {
    const p = await createProposal({ scope: addScope(120), reason: "t" }, actorFor(owner));
    // channels.list 1 + 3 playlist pages + 3 videos.list + 1 channelSections = 8
    expect(p).toMatchObject({ estimatedQuota: 8, estimatedSearchCalls: 0, estimatedChannels: 1, estimatedVideos: 120 });
    const d = await createProposal({ scope: { kind: "DISCOVER_CHANNELS", queries: ["sourdough"], maxCandidatesPerQuery: 10, maxChannelsToAdd: 2, maxVideosPerChannel: 50, includeTranscripts: false }, reason: "t" }, actorFor(owner));
    expect(d.estimatedSearchCalls).toBe(1);
    expect(d.estimatedChannels).toBe(2);
  });
});

describe("compliance lifecycle", () => {
  it("quota exhaustion never deletes data early; it proposes a refresh instead", async () => {
    await ingest();
    const n = await db.video.count();
    // 27 days old: inside the refresh window, 3 days before the deadline.
    const at = new Date(Date.now() - 27 * DAY);
    await db.fieldCoverage.updateMany({ data: { lastSuccessAt: at, retentionDeadline: new Date(at.getTime() + 30 * DAY) } });
    await markExhausted("general");
    const r = await runCompliance();
    expect(r.videos.deleted).toBe(0);
    expect(r.channels.deleted).toBe(0);
    expect(await db.video.count()).toBe(n);
    expect(r.refresh.proposalId).toBeTruthy();
    const p = await db.expansionProposal.findUniqueOrThrow({ where: { id: r.refresh.proposalId! } });
    expect(p).toMatchObject({ source: "SYSTEM", kind: "REFRESH_METADATA", status: "PENDING" });
    expect(p.expiresAt.getTime()).toBeLessThan(at.getTime() + 30 * DAY);
  });

  it("deletes data past its deadline without needing any approval", async () => {
    await ingest();
    const victims = await db.video.findMany({ take: 3, select: { id: true } });
    await db.fieldCoverage.updateMany({ where: { videoId: { in: victims.map((v) => v.id) }, group: "TEXT" }, data: { retentionDeadline: new Date(Date.now() - 1000) } });
    const r = await runCompliance();
    expect(r.videos.deleted).toBe(3);
    expect(await db.video.count({ where: { id: { in: victims.map((v) => v.id) } } })).toBe(0);
    expect(await db.fieldCoverage.count({ where: { videoId: { in: victims.map((v) => v.id) } } })).toBe(0);
  });

  it("expires only statistics when just the statistics deadline passed", async () => {
    await ingest();
    const v = await db.video.findFirstOrThrow({ where: { viewCount: { not: null } } });
    await db.fieldCoverage.update({ where: { videoId_group: { videoId: v.id, group: "STATISTICS" } }, data: { retentionDeadline: new Date(Date.now() - 1000) } });
    await runCompliance();
    const after = await db.video.findUniqueOrThrow({ where: { id: v.id } });
    expect(after).toMatchObject({ viewCount: null, likeCount: null, commentCount: null, title: v.title });
    expect((await db.fieldCoverage.findUniqueOrThrow({ where: { videoId_group: { videoId: v.id, group: "STATISTICS" } } })).status).toBe("EXPIRED");
  });

  it("an approved compliance refresh refetches all fields and deletes what YouTube no longer returns", async () => {
    await ingest();
    const [gone, ...rest] = await db.video.findMany({ orderBy: { publishedAt: "desc" }, take: 6, select: { id: true, youtubeId: true } });
    const at = new Date(Date.now() - 28 * DAY);
    await db.fieldCoverage.updateMany({ data: { lastSuccessAt: at, retentionDeadline: new Date(at.getTime() + 30 * DAY) } });
    const report = await runCompliance();
    const p = await db.expansionProposal.findUniqueOrThrow({ where: { id: report.refresh.proposalId! } });
    const scope = p.scope as { videoYoutubeIds: string[]; channelYoutubeIds: string[] };
    expect(scope.videoYoutubeIds).toContain(gone!.youtubeId);
    process.env.FIXTURE_REMOVED = gone!.youtubeId;
    resetFixtureStore();
    await flushRedis();
    const ok = await approveProposal(p.id, actorFor(admin), p.scopeHash);
    const n = await db.video.count();
    for (const jobId of ok.jobIds) {
      const job = jobId.includes("refresh-c") ? { channelYoutubeIds: scope.channelYoutubeIds.slice(0, 50), videoYoutubeIds: [] } : { channelYoutubeIds: [], videoYoutubeIds: scope.videoYoutubeIds.slice(Number(jobId.split("refresh-v")[1]) * 50, Number(jobId.split("refresh-v")[1]) * 50 + 50) };
      await ingestion.refreshMetadata({ auth: authOf(ok), lane: "background", ...job }, ctlFor(jobId));
    }
    expect(await db.video.findUnique({ where: { id: gone!.id } })).toBeNull();
    expect(await db.video.count()).toBe(n - 1); // refresh never adds records
    const fresh = await db.fieldCoverage.findMany({ where: { videoId: { in: rest.map((r) => r.id) }, group: { in: ["TEXT", "THUMBNAILS", "PUBLICATION", "STATISTICS", "STATUS"] } } });
    expect(fresh.every((f) => f.lastSuccessAt!.getTime() > at.getTime() + DAY)).toBe(true);
  });

  it("assigns sync tiers (HOT when in a collection)", async () => {
    await ingest(5);
    const ch = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL } });
    expect(await ingestion.computeTier(ch.id)).toBe("WARM");
    const ws = await db.workspace.create({ data: { ownerId: owner.id, name: "w", collections: { create: { name: "c" } } }, include: { collections: true } });
    await db.collectionItem.create({ data: { collectionId: ws.collections[0]!.id, nodeId: `channel:${FIXTURE_CHANNEL}` } });
    expect(await ingestion.computeTier(ch.id)).toBe("HOT");
  });
});

describe("drift re-scan + proposal routes", () => {
  it("a complete history is not re-backfillable unless YouTube reports items the scan never saw", async () => {
    await ingest();
    await expect(createProposal({ scope: { kind: "BACKFILL_HISTORY", channelYoutubeId: FIXTURE_CHANNEL, maxPages: 5, maxVideos: 500, includeTranscripts: false }, reason: "t" }, actorFor(owner))).rejects.toThrow(/already complete/);
    // Simulate positional-token drift: two uploads were skipped by the earlier scan.
    const missed = await db.video.findMany({ orderBy: { publishedAt: "asc" }, take: 2, select: { id: true, youtubeId: true } });
    await db.video.deleteMany({ where: { id: { in: missed.map((m) => m.id) } } });
    const h = await db.uploadHistory.findFirstOrThrow();
    await db.uploadHistory.update({ where: { channelId: h.channelId }, data: { itemsSeen: h.itemsSeen - 2, totalResults: h.itemsSeen } });
    const cov = await inspectChannel(h.channelId);
    expect(cov.history!.gap).toBe(2);
    const p = await approved({ kind: "BACKFILL_HISTORY", channelYoutubeId: FIXTURE_CHANNEL, maxPages: 5, maxVideos: 500, includeTranscripts: false }, owner);
    const out = await ingestion.backfillHistory({ auth: authOf(p), lane: "background", youtubeId: FIXTURE_CHANNEL, slice: 0 }, ctlFor(p.jobIds[0]!));
    expect(out.state).toBe("COMPLETE_TO_SOURCE_LIMIT");
    expect(await db.video.count({ where: { youtubeId: { in: missed.map((m) => m.youtubeId) } } })).toBe(2);
    const after = await db.uploadHistory.findFirstOrThrow();
    expect(after.itemsSeen).toBe(after.totalResults);
  });

  it("propose routes create PENDING proposals and spend no quota", async () => {
    const { signUp, req, ctx } = await import("./helpers");
    const { usage } = await import("@/server/services/quota");
    const { seedTaxonomy } = await import("@/server/services/classification");
    const discoverRoute = await import("@/app/api/discover/niche/[nicheId]/propose/route");
    const refreshRoute = await import("@/app/api/channels/[id]/refresh/route");
    const syncRoute = await import("@/app/api/channels/[id]/sync/route");
    await seedTaxonomy();
    const u = await signUp("router@atlas.test");
    await ingest(10);
    const before = await usage();
    const d = await discoverRoute.POST(req("/api/discover/niche/baking/propose", { method: "POST", cookie: u.cookie, body: { maxChannelsToAdd: 3 } }), ctx({ nicheId: "baking" }));
    expect(d.status).toBe(201);
    const dp = (await d.json()).data;
    expect(dp).toMatchObject({ kind: "DISCOVER_CHANNELS", status: "PENDING", canDecide: true, estimate: { channels: 3 } });
    expect(dp.estimate.searchCalls).toBeGreaterThan(0);
    const r = await refreshRoute.POST(req(`/api/channels/${FIXTURE_CHANNEL}/refresh`, { method: "POST", cookie: u.cookie, body: { fields: "all" } }), ctx({ id: FIXTURE_CHANNEL }));
    expect((await r.json()).data).toMatchObject({ kind: "REFRESH_METADATA", status: "PENDING" });
    const s = await syncRoute.POST(req(`/api/channels/${FIXTURE_CHANNEL}/sync`, { method: "POST", cookie: u.cookie, body: { full: true } }), ctx({ id: FIXTURE_CHANNEL }));
    expect((await s.json()).data).toMatchObject({ kind: "BACKFILL_HISTORY", status: "PENDING" });
    const after = await usage();
    expect(after.buckets).toEqual(before.buckets); // proposing never calls YouTube
    // Another user cannot approve them.
    const other = await signUp("intruder@atlas.test");
    const approveRoute = await import("@/app/api/expansions/[id]/approve/route");
    const x = await approveRoute.POST(req(`/api/expansions/${dp.id}/approve`, { method: "POST", cookie: other.cookie, body: { scopeHash: dp.scopeHash } }), ctx({ id: dp.id }));
    expect(x.status).toBe(404);
    const anon = await approveRoute.POST(req(`/api/expansions/${dp.id}/approve`, { method: "POST", body: { scopeHash: dp.scopeHash } }), ctx({ id: dp.id }));
    expect(anon.status).toBe(401);
  });
});
