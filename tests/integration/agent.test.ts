/** Claude/agent tools (plan Phase 5, D7): token auth, read-only enforcement, proposals only, never approval. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, readOnly, ReadOnlyViolation } from "@/server/db";
import * as ingestion from "@/server/services/ingestion";
import { approveProposal } from "@/server/services/expansion";
import type { ProposalDTO } from "@/shared/contracts/expansion";
import { extractTopics } from "@/server/services/topics";
import { rebuildAll } from "@/server/services/graph";
import { seedTaxonomy } from "@/server/services/classification";
import { TOOLS, runTool } from "@/server/services/agent";
import * as tokensRoute from "@/app/api/me/agent-tokens/route";
import * as tokenRoute from "@/app/api/me/agent-tokens/[id]/route";
import * as toolsRoute from "@/app/api/agent/tools/route";
import * as toolRoute from "@/app/api/agent/tools/[name]/route";
import * as approveRoute from "@/app/api/expansions/[id]/approve/route";
import * as transcriptRoute from "@/app/api/videos/[id]/transcript/route";
import { approved, authOf, ctlFor, ctx, flushRedis, req, resetDb, signUp, teardown, FIXTURE_CHANNEL } from "./helpers";

type Body = { data: unknown; meta?: Record<string, unknown>; error?: { code: string; message: string } };
const body = async (r: Response) => (await r.json()) as Body;
const SECRET = "marzipan heliotrope ledger";

let alice: Awaited<ReturnType<typeof signUp>>;
let bob: Awaited<ReturnType<typeof signUp>>;
let channel: { id: string; youtubeId: string };
let video: { id: string; youtubeId: string };
let ingestRunId: string;

async function mint(who: { cookie: string; user: { id: string } }, scopes: string[] = ["read", "propose"], name = "Claude") {
  // Stay under the per-user active-token cap across this file.
  if ((await db.agentToken.count({ where: { userId: who.user.id, revokedAt: null } })) >= 8) await db.agentToken.updateMany({ where: { userId: who.user.id }, data: { revokedAt: new Date() } });
  const r = await tokensRoute.POST(req("/api/me/agent-tokens", { method: "POST", cookie: who.cookie, body: { name, scopes } }), ctx({}));
  expect(r.status).toBe(201);
  return ((await body(r)).data as { token: string; record: { id: string } });
}
const call = (token: string | null, name: string, input: unknown = {}, extra: Record<string, string> = {}) =>
  toolRoute.POST(req(`/api/agent/tools/${name}`, { method: "POST", body: input, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } }), ctx({ name }));

/** Row counts + latest updatedAt of the corpus/governance tables (agent-token bookkeeping excluded). */
async function fingerprint() {
  const rows = await db.$queryRaw<{ f: string }[]>`
    SELECT concat_ws('|',
      (SELECT count(*) FROM "Channel"), (SELECT max("updatedAt") FROM "Channel"),
      (SELECT count(*) FROM "Video"), (SELECT max("updatedAt") FROM "Video"),
      (SELECT count(*) FROM "Transcript"), (SELECT count(*) FROM "TranscriptChunk"),
      (SELECT count(*) FROM "Topic"), (SELECT count(*) FROM "VideoTopic"), (SELECT count(*) FROM "ChannelNiche"),
      (SELECT count(*) FROM "GraphNode"), (SELECT max("updatedAt") FROM "GraphNode"), (SELECT count(*) FROM "GraphEdge"),
      (SELECT count(*) FROM "FieldCoverage"), (SELECT max("updatedAt") FROM "FieldCoverage"),
      (SELECT count(*) FROM "ExpansionProposal"), (SELECT max("updatedAt") FROM "ExpansionProposal"),
      (SELECT count(*) FROM "IngestionRun"), (SELECT count(*) FROM "DiscoveryQuery"), (SELECT count(*) FROM "UploadHistory")
    ) AS f`;
  return rows[0]!.f;
}

beforeAll(async () => {
  await resetDb();
  await flushRedis();
  await seedTaxonomy();
  alice = await signUp("alice.agent@atlas.test");
  bob = await signUp("bob.agent@atlas.test");
  const p = await approved({ kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL, aliases: [] }], maxVideosPerChannel: 15, includeTranscripts: false }, alice.user);
  await ingestion.ingestChannel({ auth: authOf(p), lane: "interactive", youtubeId: FIXTURE_CHANNEL }, ctlFor(p.jobIds[0]!));
  channel = await db.channel.findUniqueOrThrow({ where: { youtubeId: FIXTURE_CHANNEL }, select: { id: true, youtubeId: true } });
  video = await db.video.findFirstOrThrow({ where: { channelId: channel.id }, select: { id: true, youtubeId: true } });
  ingestRunId = (await db.ingestionRun.findFirstOrThrow({ where: { proposalId: p.id } })).id;
  // No workers here: run the downstream steps the read tools look at.
  await extractTopics((await db.video.findMany({ where: { channelId: channel.id }, select: { id: true } })).map((v) => v.id));
  await rebuildAll();
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nThis private note says ${SECRET}.\n`;
  const up = await transcriptRoute.POST(req(`/api/videos/${video.youtubeId}/transcript`, { method: "POST", cookie: alice.cookie, body: { text: vtt, filename: "n.vtt" } }), ctx({ id: video.youtubeId }));
  expect(up.status).toBe(201);
}, 120_000);
afterAll(async () => teardown());

describe("agent tokens", () => {
  it("are shown once, stored hashed, and listed without secrets", async () => {
    const { token, record } = await mint(alice);
    expect(token).toMatch(/^atl_[A-Za-z0-9_-]{43}$/);
    const row = await db.agentToken.findUniqueOrThrow({ where: { id: record.id } });
    expect(row.tokenHash).not.toContain(token);
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const list = JSON.stringify((await body(await tokensRoute.GET(req("/api/me/agent-tokens", { cookie: alice.cookie }), ctx({})))).data);
    expect(list).not.toContain(token);
    expect(list).not.toContain(row.tokenHash);
  });

  it("are required: missing, malformed, unknown, revoked and expired tokens get 401", async () => {
    expect((await call(null, "atlas_get_overview")).status).toBe(401);
    expect((await call("not-a-token", "atlas_get_overview")).status).toBe(401);
    expect((await call(`atl_${"x".repeat(43)}`, "atlas_get_overview")).status).toBe(401);
    const { token, record } = await mint(alice, ["read"], "temp");
    expect((await call(token, "atlas_get_overview")).status).toBe(200);
    const del = await tokenRoute.DELETE(req(`/api/me/agent-tokens/${record.id}`, { method: "DELETE", cookie: alice.cookie }), ctx({ id: record.id }));
    expect(del.status).toBe(200);
    expect((await call(token, "atlas_get_overview")).status).toBe(401);
    const exp = await mint(alice, ["read"], "expiring");
    await db.agentToken.update({ where: { id: exp.record.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call(exp.token, "atlas_get_overview")).status).toBe(401);
  });

  it("cannot be revoked by another user (404)", async () => {
    const { token, record } = await mint(alice, ["read"], "alice-only");
    const r = await tokenRoute.DELETE(req(`/api/me/agent-tokens/${record.id}`, { method: "DELETE", cookie: bob.cookie }), ctx({ id: record.id }));
    expect(r.status).toBe(404);
    expect((await call(token, "atlas_get_overview")).status).toBe(200);
  });

  it("agent routes ignore browser sessions (a cookie alone is not an agent credential)", async () => {
    const r = await toolRoute.POST(req("/api/agent/tools/atlas_get_overview", { method: "POST", cookie: alice.cookie, body: {} }), ctx({ name: "atlas_get_overview" }));
    expect(r.status).toBe(401);
    const list = await toolsRoute.GET(req("/api/agent/tools", { cookie: alice.cookie }), ctx({}));
    expect(list.status).toBe(401);
  });
});

describe("read-only enforcement", () => {
  it("blocks every write inside a read-only scope", async () => {
    await expect(readOnly("t", () => db.channel.update({ where: { id: channel.id }, data: { title: "hacked" } }))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(readOnly("t", () => db.expansionProposal.updateMany({ data: { status: "APPROVED" } }))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(readOnly("t", () => db.$executeRaw`UPDATE "Channel" SET title = 'x'`)).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(readOnly("t", () => db.$queryRawUnsafe(`UPDATE "Channel" SET title = 'x' RETURNING id`))).rejects.toBeInstanceOf(ReadOnlyViolation);
    await expect(readOnly("t", () => db.$transaction(async (tx) => tx.channel.deleteMany({})))).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect((await db.channel.findUniqueOrThrow({ where: { id: channel.id } })).title).not.toBe("hacked");
    // Reads still work.
    expect(await readOnly("t", () => db.channel.count())).toBe(1);
  });

  it("every read tool runs without mutating the corpus or governance tables", async () => {
    const { token } = await mint(alice, ["read"], "reader");
    const before = await fingerprint();
    const inputs: Record<string, unknown> = {
      atlas_get_overview: {},
      atlas_inspect_coverage: { scope: "channel", id: channel.youtubeId },
      atlas_get_channel: { id: channel.youtubeId },
      atlas_get_niche: { id: "ai-ml" },
      atlas_get_topic: { id: (await db.topic.findFirstOrThrow({ select: { slug: true } })).slug },
      atlas_search_existing: { q: "machine learning", mode: "hybrid" },
      atlas_get_graph_neighborhood: { nodeId: `channel:${channel.youtubeId}`, depth: 1 },
      atlas_explain_relationship: { from: `channel:${channel.youtubeId}`, to: `video:${video.youtubeId}` },
      atlas_list_proposals: {},
      atlas_get_ingestion_run: { id: ingestRunId },
      atlas_estimate_expansion: { scope: { kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL }], maxVideosPerChannel: 10 } },
    };
    for (const t of TOOLS.filter((x) => x.access === "read" && x.name !== "atlas_get_proposal_status")) {
      expect(inputs, `missing test input for ${t.name}`).toHaveProperty(t.name);
      const r = await call(token, t.name, inputs[t.name]);
      expect(r.status, `${t.name}: ${JSON.stringify((await body(r.clone())).error)}`).toBe(200);
    }
    expect(await fingerprint()).toBe(before);
  });

  it("labels relationships as FACT or INFERRED and flags redundant expansions", async () => {
    const { token } = await mint(alice, ["read"], "labels");
    const ex = (await body(await call(token, "atlas_explain_relationship", { from: `channel:${channel.youtubeId}`, to: `video:${video.youtubeId}` }))).data as { edges: { kind: string; provenance: { label: string } }[] };
    expect(ex.edges[0]).toMatchObject({ kind: "PUBLISHED", provenance: { label: "FACT" } });
    const nb = (await body(await call(token, "atlas_get_graph_neighborhood", { nodeId: `channel:${channel.youtubeId}` }))).data as { edges: { kind: string; provenance: { label: string } }[] };
    for (const e of nb.edges) expect(["FACT", "INFERRED"]).toContain(e.provenance.label);
    const est = (await body(await call(token, "atlas_estimate_expansion", { scope: { kind: "ADD_CHANNELS", channels: [{ youtubeId: FIXTURE_CHANNEL }], maxVideosPerChannel: 10 } }))).data as { redundancy: { redundant: boolean; alreadyPresent: string[] }; estimate: { isEstimate: boolean } };
    expect(est.redundancy).toMatchObject({ redundant: true, alreadyPresent: [FIXTURE_CHANNEL] });
    expect(est.estimate.isEstimate).toBe(true);
  });
});

describe("proposals from Claude", () => {
  let proposal: ProposalDTO;
  const scope = { kind: "BACKFILL_HISTORY", channelYoutubeId: FIXTURE_CHANNEL, maxPages: 2, maxVideos: 40 };

  it("a propose-scoped token creates a PENDING proposal with source CLAUDE that runs nothing", async () => {
    const { token } = await mint(alice, ["read", "propose"]);
    const r = await call(token, "atlas_create_expansion_proposal", { scope, reason: "Older uploads are missing", coverageGap: "upload history incomplete" });
    expect(r.status).toBe(200);
    proposal = ((await body(r)).data as { proposal: ProposalDTO }).proposal;
    expect(proposal).toMatchObject({ status: "PENDING", source: "CLAUDE", createdByUserId: alice.user.id, canDecide: false });
    const row = await db.expansionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    expect(row.jobIds).toEqual([]);
    expect(row.approvedByUserId).toBeNull();
  });

  it("a read-only token cannot propose", async () => {
    const { token } = await mint(alice, ["read"], "no-propose");
    const r = await call(token, "atlas_create_expansion_proposal", { scope, reason: "x" });
    expect(r.status).toBe(403);
  });

  it("there is no approve/reject/cancel tool, and unknown tools 404", async () => {
    expect(TOOLS.map((t) => t.name).filter((n) => /approve|reject|cancel|decide/.test(n))).toEqual([]);
    const { token } = await mint(alice);
    for (const name of ["atlas_approve_proposal", "atlas_reject_proposal", "atlas_cancel_proposal"]) expect((await call(token, name, { id: proposal.id })).status).toBe(404);
    await expect(runTool("atlas_approve_proposal", { id: proposal.id }, { userId: alice.user.id, scopes: ["read", "propose"], tokenId: "t" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an agent can never approve — not through the service, not with a bearer token on the approval route", async () => {
    await expect(approveProposal(proposal.id, { kind: "agent", userId: alice.user.id }, proposal.scopeHash)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { token } = await mint(alice);
    const r = await approveRoute.POST(req(`/api/expansions/${proposal.id}/approve`, { method: "POST", body: { scopeHash: proposal.scopeHash }, headers: { authorization: `Bearer ${token}` } }), ctx({ id: proposal.id }));
    expect(r.status).toBe(401);
    expect((await db.expansionProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe("PENDING");
  });

  it("other users' agents cannot see the proposal or its runs", async () => {
    const { token } = await mint(bob);
    expect((await call(token, "atlas_get_proposal_status", { id: proposal.id })).status).toBe(404);
    expect((await call(token, "atlas_get_ingestion_run", { id: ingestRunId })).status).toBe(404);
    expect((await body(await call(token, "atlas_list_proposals", {}))).data).toEqual([]);
  });

  it("the signed-in owner approves it in Atlas, and the agent can then follow its status", async () => {
    const r = await approveRoute.POST(req(`/api/expansions/${proposal.id}/approve`, { method: "POST", cookie: alice.cookie, body: { scopeHash: proposal.scopeHash } }), ctx({ id: proposal.id }));
    expect(r.status).toBe(200);
    const { token } = await mint(alice, ["read"], "follow");
    const s = (await body(await call(token, "atlas_get_proposal_status", { id: proposal.id }))).data as ProposalDTO;
    expect(["APPROVED", "RUNNING"]).toContain(s.status);
    expect(s.approvedByUserId).toBe(alice.user.id);
  });
});

describe("private transcripts through agent search", () => {
  const find = async (token: string) => ((await body(await call(token, "atlas_search_existing", { q: "marzipan heliotrope", mode: "keyword", types: ["transcript"] }))).data as { items: unknown[] }).items;

  it("are hidden unless the owner's token has the private-transcripts scope", async () => {
    expect(await find((await mint(alice, ["read"], "plain")).token)).toHaveLength(0);
    expect(await find((await mint(alice, ["read", "private-transcripts"], "private")).token)).toHaveLength(1);
    expect(await find((await mint(bob, ["read", "private-transcripts"], "bob-private")).token)).toHaveLength(0);
  });
});
