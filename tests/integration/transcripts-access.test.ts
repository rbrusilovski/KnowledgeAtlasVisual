/** Transcript ownership, visibility and IDOR protection across every read path. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import * as ingestion from "@/server/services/ingestion";
import { fetchAndStore, storeTranscript } from "@/server/services/transcripts";
import { extractTopics } from "@/server/services/topics";
import { videoContent } from "@/server/services/ai";
import { purgeYouTubeConnectionData, deleteAccount, exportUserData } from "@/server/services/workspaces";
import { search } from "@/server/services/search";
import * as transcriptRoute from "@/app/api/videos/[id]/transcript/route";
import * as videoRoute from "@/app/api/videos/[id]/route";
import * as searchRoute from "@/app/api/search/route";
import * as jobsRoute from "@/app/api/jobs/[id]/route";
import { approved, authOf, ctlFor, ctx, flushRedis, req, resetDb, signUp, teardown, FIXTURE_CHANNEL } from "./helpers";

const SECRET = "zanzibar quokka telemetry";
let alice: Awaited<ReturnType<typeof signUp>>;
let bob: Awaited<ReturnType<typeof signUp>>;
let video: { id: string; youtubeId: string };
let aliceTranscriptId: string;

const body = async (r: Response) => (await r.json()) as { data: unknown; meta?: Record<string, unknown>; error?: { code: string } };

beforeAll(async () => {
  await resetDb();
  await flushRedis();
  alice = await signUp("alice@atlas.test");
  bob = await signUp("bob@atlas.test");
  const p = await approved({ kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL, aliases: [] }], maxVideosPerChannel: 20, includeTranscripts: false }, alice.user);
  await ingestion.ingestChannel({ auth: authOf(p), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, ctlFor(p.jobIds[0]!));
  video = await db.video.findFirstOrThrow({ select: { id: true, youtubeId: true } });
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome, this mentions ${SECRET} only once.\n\n00:00:05.000 --> 00:00:09.000\nMore private notes follow here.\n`;
  const r = await transcriptRoute.POST(req(`/api/videos/${video.youtubeId}/transcript`, { method: "POST", cookie: alice.cookie, body: { text: vtt, filename: "a.vtt" } }), ctx({ id: video.youtubeId }));
  expect(r.status).toBe(201);
  aliceTranscriptId = ((await body(r)).data as { transcriptId: string }).transcriptId;
}, 120_000);
afterAll(async () => teardown());

describe("private transcripts", () => {
  it("are readable only by their owner", async () => {
    const get = (cookie?: string) => transcriptRoute.GET(req(`/api/videos/${video.youtubeId}/transcript`, { cookie }), ctx({ id: video.youtubeId }));
    const mine = (await body(await get(alice.cookie))).data as { id: string; mine: boolean; visibility: string };
    expect(mine).toMatchObject({ id: aliceTranscriptId, mine: true, visibility: "PRIVATE" });
    expect((await body(await get(bob.cookie))).data).toBeNull();
    expect((await body(await get())).data).toBeNull();
    // Asking for the id explicitly doesn't help either.
    const direct = await transcriptRoute.GET(req(`/api/videos/${video.youtubeId}/transcript?transcriptId=${aliceTranscriptId}`, { cookie: bob.cookie }), ctx({ id: video.youtubeId }));
    expect((await body(direct)).data).toBeNull();
  });

  it("never appear in another user's search, video detail or the shared hasTranscript flag", async () => {
    const s = async (cookie?: string) => (await body(await searchRoute.GET(req(`/api/search?q=${encodeURIComponent("zanzibar quokka")}&types=transcript&mode=keyword`, { cookie }), ctx({})))).data as unknown[];
    expect((await s(alice.cookie)).length).toBe(1);
    expect(await s(bob.cookie)).toHaveLength(0);
    expect(await s()).toHaveLength(0);
    expect((await search({ q: "zanzibar quokka", mode: "keyword", types: ["transcript"], limit: 5 })).items).toHaveLength(0); // no viewer = shared corpus only
    const detail = async (cookie?: string) => (await body(await videoRoute.GET(req(`/api/videos/${video.youtubeId}`, { cookie }), ctx({ id: video.youtubeId })))).data as { transcripts: unknown[]; hasTranscript: boolean };
    expect((await detail(alice.cookie)).transcripts).toHaveLength(1);
    expect((await detail(bob.cookie)).transcripts).toHaveLength(0);
    expect((await detail(bob.cookie)).hasTranscript).toBe(false);
  });

  it("the 'My transcripts' scope returns only the viewer's own private transcripts, never cached (D10, D11)", async () => {
    const mine = (cookie?: string) => searchRoute.GET(req(`/api/search?q=${encodeURIComponent("zanzibar quokka")}&mode=keyword&transcripts=mine`, { cookie }), ctx({}));
    const a = await mine(alice.cookie);
    expect(a.headers.get("cache-control")).toBe("private, no-store");
    const hits = (await body(a)).data as { type: string }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]!.type).toBe("transcript");
    expect((await body(await mine(bob.cookie))).data).toHaveLength(0);
    expect((await mine()).status).toBe(401);
    // The shared corpus never appears in the "mine" scope.
    const corpus = (await body(await searchRoute.GET(req(`/api/search?q=welcome&mode=keyword&transcripts=mine`, { cookie: bob.cookie }), ctx({})))).data as unknown[];
    expect(corpus).toHaveLength(0);
  });

  it("another user's upload for the same video/language does not overwrite it", async () => {
    const r = await transcriptRoute.POST(req(`/api/videos/${video.youtubeId}/transcript`, { method: "POST", cookie: bob.cookie, body: { text: "bob's own words about the video", filename: "b.txt" } }), ctx({ id: video.youtubeId }));
    expect(r.status).toBe(201);
    expect(await db.transcript.count({ where: { videoId: video.id, source: "USER_UPLOAD", language: "en" } })).toBe(2);
    expect(await db.transcript.findUnique({ where: { id: aliceTranscriptId } })).not.toBeNull();
  });

  it("cannot be deleted by another user (404, no existence leak)", async () => {
    const r = await transcriptRoute.DELETE(req(`/api/videos/${video.youtubeId}/transcript?transcriptId=${aliceTranscriptId}`, { method: "DELETE", cookie: bob.cookie }), ctx({ id: video.youtubeId }));
    expect(r.status).toBe(404);
    expect(await db.transcript.findUnique({ where: { id: aliceTranscriptId } })).not.toBeNull();
  });

  it("never feed shared derived data (topics, AI input)", async () => {
    await extractTopics([video.id]);
    expect(await db.topic.count({ where: { OR: [{ label: { contains: "quokka" } }, { label: { contains: "zanzibar" } }] } })).toBe(0);
    expect((await videoContent(video.id)).content).not.toContain("quokka");
  });

  it("export includes only the user's own transcripts", async () => {
    const a = await exportUserData(alice.user.id);
    const b = await exportUserData(bob.user.id);
    expect(a.transcriptUploads.map((t) => t.id)).toContain(aliceTranscriptId);
    expect(b.transcriptUploads.map((t) => t.id)).not.toContain(aliceTranscriptId);
  });

  it("fixture transcripts are the shared corpus (fixture mode only)", async () => {
    const withFx = await db.video.findMany({ select: { id: true } });
    let stored = 0;
    for (const v of withFx) if ((await fetchAndStore(v.id, "FIXTURE")).stored) stored++;
    expect(stored).toBeGreaterThan(0);
    const fx = await db.transcript.findFirstOrThrow({ where: { source: "FIXTURE" }, include: { video: true } });
    expect(fx).toMatchObject({ visibility: "CORPUS", ownerUserId: null, ownerKey: "corpus" });
    expect(fx.video.hasTranscript).toBe(true);
    expect(fx.video.transcriptStatus).toBe("AVAILABLE");
    const anon = (await body(await transcriptRoute.GET(req(`/api/videos/${fx.video.youtubeId}/transcript`), ctx({ id: fx.video.youtubeId })))).data as { source: string };
    expect(anon.source).toBe("FIXTURE");
  });

  it("revoking one user's YouTube connection purges only that connection's captions", async () => {
    const mk = (userId: string) => db.youTubeConnection.create({ data: { userId, googleSub: userId, channelIds: [FIXTURE_CHANNEL], accessTokenEnc: "x", scope: "s", expiresAt: new Date() } });
    const ca = await mk(alice.user.id);
    const cb = await mk(bob.user.id);
    const cue = [{ start: 1, end: 2, text: "owner caption text" }];
    await storeTranscript(video.id, { source: "OWNER_CAPTIONS", visibility: "PRIVATE", ownerUserId: alice.user.id, connectionId: ca.id, language: "en", trackKind: "MANUAL", isAutoGenerated: false, cues: cue });
    await storeTranscript(video.id, { source: "OWNER_CAPTIONS", visibility: "PRIVATE", ownerUserId: bob.user.id, connectionId: cb.id, language: "en", trackKind: "MANUAL", isAutoGenerated: false, cues: cue });
    const r = await purgeYouTubeConnectionData(alice.user.id);
    expect(r.deleted).toBe(1);
    expect(await db.transcript.count({ where: { source: "OWNER_CAPTIONS", ownerUserId: alice.user.id } })).toBe(0);
    expect(await db.transcript.count({ where: { source: "OWNER_CAPTIONS", ownerUserId: bob.user.id } })).toBe(1);
    expect(await db.youTubeConnection.count({ where: { userId: alice.user.id } })).toBe(0);
  });

  it("job status is only visible to the requesting user", async () => {
    const p = await db.expansionProposal.findFirstOrThrow();
    const jobId = p.jobIds[0]!;
    const r = await jobsRoute.GET(req(`/api/jobs/${jobId}`, { cookie: bob.cookie }), ctx({ id: jobId }));
    expect(r.status).toBe(404);
    const anon = await jobsRoute.GET(req(`/api/jobs/${jobId}`), ctx({ id: jobId }));
    expect(anon.status).toBe(401);
  });

  it("account deletion removes the user's private transcripts and nobody else's", async () => {
    await deleteAccount(alice.user.id);
    expect(await db.transcript.count({ where: { id: aliceTranscriptId } })).toBe(0);
    expect(await db.transcript.count({ where: { ownerUserId: bob.user.id } })).toBeGreaterThan(0);
  });
});
