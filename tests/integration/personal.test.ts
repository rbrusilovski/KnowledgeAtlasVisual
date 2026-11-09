import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/server/db";
import { auth } from "@/server/auth";
import * as ws from "@/server/services/workspaces";
import { checkRateLimit } from "@/server/http/rateLimit";
import { resetDb, flushRedis, teardown } from "./helpers";

const ORIGIN = "http://localhost:3000";

async function signUp(email: string) {
  const res = await auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: email.split("@")[0]! }, asResponse: true });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  return { user, cookie };
}

function req(url: string, init: { method?: string; cookie?: string; body?: unknown } = {}) {
  return new NextRequest(new URL(url, ORIGIN), {
    method: init.method ?? "GET",
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.body !== undefined ? { "content-type": "application/json", origin: ORIGIN } : init.method && init.method !== "GET" ? { origin: ORIGIN } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

let alice: Awaited<ReturnType<typeof signUp>>;
let bob: Awaited<ReturnType<typeof signUp>>;
let node: string;

beforeAll(async () => {
  await resetDb();
  await flushRedis();
  alice = await signUp("alice@atlas.test");
  bob = await signUp("bob@atlas.test");
  node = "niche:test-niche";
  await db.graphNode.create({ data: { id: node, type: "NICHE", refId: "test-niche", label: "Test", version: 1n } });
});
afterAll(async () => teardown());
beforeEach(async () => {
  // Rate-limit windows are per test file; keep them clean between tests.
  const { redis, key } = await import("@/server/redis");
  const keys = await redis.keys(key("rl", "*"));
  if (keys.length) await redis.del(...keys);
});

describe("workspaces + collections", () => {
  it("auto-creates a first workspace with a collection on signup", async () => {
    const list = await ws.listWorkspaces(alice.user.id);
    expect(list).toHaveLength(1);
    expect(list[0]!._count.collections).toBe(1);
  });

  it("supports collection items with notes/tags, layouts and saved views", async () => {
    const [w] = await ws.listWorkspaces(alice.user.id);
    const c = await ws.createCollection(alice.user.id, w!.id, { name: "Research" });
    expect(await ws.addItems(alice.user.id, c.id, [{ nodeId: node, note: "hello", tags: ["Big Idea", "big idea"] }])).toEqual({ added: 1, skipped: 0 });
    expect(await ws.addItems(alice.user.id, c.id, [{ nodeId: node }])).toEqual({ added: 0, skipped: 1 });
    const full = await ws.getCollection(alice.user.id, c.id);
    expect(full.items[0]!.tags).toEqual(["big-idea"]);
    expect(full.items[0]!.node?.label).toBe("Test");
    await ws.putLayout(alice.user.id, w!.id, [{ nodeId: node, x: 1.5, y: -2, pinned: true }]);
    expect(await ws.getLayout(alice.user.id, w!.id)).toEqual([{ nodeId: node, x: 1.5, y: -2, pinned: true }]);
    const v = await ws.createView(alice.user.id, w!.id, { name: "My view", state: { mode: "local", focus: node, filters: { nodeTypes: ["CHANNEL"] } } });
    expect((await ws.listViews(alice.user.id, w!.id))[0]!.id).toBe(v.id);
    await expect(ws.addItems(alice.user.id, c.id, [{ nodeId: "channel:UCdoesnotexist000000000" }])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("exports CSV safely (formula injection neutralized)", async () => {
    expect(ws.csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(ws.csvCell('a "b", c')).toBe(`"a ""b"", c"`);
    const [w] = await ws.listWorkspaces(alice.user.id);
    const c = (await ws.listCollections(alice.user.id, w!.id)).find((x) => x.name === "Research")!;
    const f = await ws.exportCollection(alice.user.id, c.id, "csv");
    expect(f.body.split("\r\n")[0]).toBe("nodeId,type,label,url,note,tags,addedAt");
  });
});

describe("IDOR: every personal resource is owner-scoped", () => {
  it("service layer rejects cross-user access with NOT_FOUND", async () => {
    const [w] = await ws.listWorkspaces(alice.user.id);
    const c = (await ws.listCollections(alice.user.id, w!.id))[0]!;
    const v = await ws.createView(alice.user.id, w!.id, { name: "secret", state: { mode: "global", filters: {} } });
    const item = (await ws.addItems(alice.user.id, c.id, [{ nodeId: node }]), (await ws.getCollection(alice.user.id, c.id)).items[0]!);
    const nf = { code: "NOT_FOUND" };
    await expect(ws.getWorkspace(bob.user.id, w!.id)).rejects.toMatchObject(nf);
    await expect(ws.updateWorkspace(bob.user.id, w!.id, { name: "pwned" })).rejects.toMatchObject(nf);
    await expect(ws.deleteWorkspace(bob.user.id, w!.id)).rejects.toMatchObject(nf);
    await expect(ws.listCollections(bob.user.id, w!.id)).rejects.toMatchObject(nf);
    await expect(ws.createCollection(bob.user.id, w!.id, { name: "x" })).rejects.toMatchObject(nf);
    await expect(ws.getCollection(bob.user.id, c.id)).rejects.toMatchObject(nf);
    await expect(ws.updateCollection(bob.user.id, c.id, { name: "x" })).rejects.toMatchObject(nf);
    await expect(ws.deleteCollection(bob.user.id, c.id)).rejects.toMatchObject(nf);
    await expect(ws.addItems(bob.user.id, c.id, [{ nodeId: node }])).rejects.toMatchObject(nf);
    await expect(ws.removeItems(bob.user.id, c.id, { nodeIds: [node] })).rejects.toMatchObject(nf);
    await expect(ws.updateItem(bob.user.id, c.id, item.id, { note: "x" })).rejects.toMatchObject(nf);
    await expect(ws.exportCollection(bob.user.id, c.id, "json")).rejects.toMatchObject(nf);
    await expect(ws.listViews(bob.user.id, w!.id)).rejects.toMatchObject(nf);
    await expect(ws.createView(bob.user.id, w!.id, { name: "x", state: { mode: "global", filters: {} } })).rejects.toMatchObject(nf);
    await expect(ws.updateView(bob.user.id, v.id, { name: "x" })).rejects.toMatchObject(nf);
    await expect(ws.deleteView(bob.user.id, v.id)).rejects.toMatchObject(nf);
    await expect(ws.getLayout(bob.user.id, w!.id)).rejects.toMatchObject(nf);
    await expect(ws.putLayout(bob.user.id, w!.id, [{ nodeId: node, x: 0, y: 0, pinned: true }])).rejects.toMatchObject(nf);
    await expect(ws.membership(bob.user.id, w!.id)).rejects.toMatchObject(nf);
    // Bob's item update via a collection he owns can't touch Alice's item id either.
    const [bw] = await ws.listWorkspaces(bob.user.id);
    const bc = (await ws.listCollections(bob.user.id, bw!.id))[0]!;
    await expect(ws.updateItem(bob.user.id, bc.id, item.id, { note: "x" })).rejects.toMatchObject(nf);
    // Nothing of Alice's changed.
    expect((await ws.getCollection(alice.user.id, c.id)).name).toBe(c.name);
  });

  it("HTTP routes enforce auth and ownership", async () => {
    const [w] = await ws.listWorkspaces(alice.user.id);
    const c = (await ws.listCollections(alice.user.id, w!.id))[0]!;
    const wsRoute = await import("@/app/api/workspaces/[id]/route");
    const colRoute = await import("@/app/api/collections/[id]/route");
    const itemsRoute = await import("@/app/api/collections/[id]/items/route");
    const layoutRoute = await import("@/app/api/workspaces/[id]/layout/route");
    const exportRoute = await import("@/app/api/collections/[id]/export/route");

    expect((await wsRoute.GET(req(`/api/workspaces/${w!.id}`), ctx({ id: w!.id }))).status).toBe(401);
    expect((await wsRoute.GET(req(`/api/workspaces/${w!.id}`, { cookie: alice.cookie }), ctx({ id: w!.id }))).status).toBe(200);
    expect((await wsRoute.GET(req(`/api/workspaces/${w!.id}`, { cookie: bob.cookie }), ctx({ id: w!.id }))).status).toBe(404);
    expect((await colRoute.PATCH(req(`/api/collections/${c.id}`, { method: "PATCH", cookie: bob.cookie, body: { name: "x" } }), ctx({ id: c.id }))).status).toBe(404);
    expect((await colRoute.DELETE(req(`/api/collections/${c.id}`, { method: "DELETE", cookie: bob.cookie }), ctx({ id: c.id }))).status).toBe(404);
    expect((await itemsRoute.POST(req(`/api/collections/${c.id}/items`, { method: "POST", cookie: bob.cookie, body: { items: [{ nodeId: node }] } }), ctx({ id: c.id }))).status).toBe(404);
    expect((await layoutRoute.PUT(req(`/api/workspaces/${w!.id}/layout`, { method: "PUT", cookie: bob.cookie, body: { positions: [] } }), ctx({ id: w!.id }))).status).toBe(404);
    expect((await exportRoute.GET(req(`/api/collections/${c.id}/export?format=csv`, { cookie: bob.cookie }), ctx({ id: c.id }))).status).toBe(404);
    const ok = await exportRoute.GET(req(`/api/collections/${c.id}/export?format=csv`, { cookie: alice.cookie }), ctx({ id: c.id }));
    expect(ok.headers.get("content-disposition")).toMatch(/attachment/);
  });

  it("rejects cross-origin mutations", async () => {
    const [w] = await ws.listWorkspaces(alice.user.id);
    const wsRoute = await import("@/app/api/workspaces/[id]/route");
    const r = new NextRequest(new URL(`/api/workspaces/${w!.id}`, ORIGIN), { method: "PATCH", headers: { cookie: alice.cookie, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    const res = await wsRoute.PATCH(r, ctx({ id: w!.id }));
    expect(res.status).toBe(403);
  });

  it("validates bodies with the error envelope", async () => {
    const [w] = await ws.listWorkspaces(alice.user.id);
    const route = await import("@/app/api/workspaces/[id]/collections/route");
    const res = await route.POST(req(`/api/workspaces/${w!.id}/collections`, { method: "POST", cookie: alice.cookie, body: { name: "", color: "red" } }), ctx({ id: w!.id }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("rate limiting", () => {
  it("sliding window allows `limit` then rejects with retry-after", async () => {
    const spec = { name: "test-rl", limit: 5, windowSec: 60 };
    for (let i = 0; i < 5; i++) expect((await checkRateLimit(spec, "s1")).allowed).toBe(true);
    const r = await checkRateLimit(spec, "s1");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    expect((await checkRateLimit(spec, "s2")).allowed).toBe(true);
  });

  it("routes return 429 + Retry-After when the anonymous limit is exceeded", async () => {
    const health = await import("@/app/api/niches/route");
    const limit = Number(process.env.RATE_LIMIT_ANON_PER_MIN ?? 60);
    let last: Response | null = null;
    for (let i = 0; i <= limit; i++) last = await health.GET(new NextRequest(new URL("/api/niches", ORIGIN), { headers: { "x-forwarded-for": "203.0.113.9" } }), ctx({}));
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await last!.json()).error.code).toBe("RATE_LIMITED");
  });
});

describe("account deletion", () => {
  it("deletes the user and cascades all personal data", async () => {
    const carol = await signUp("carol@atlas.test");
    const [w] = await ws.listWorkspaces(carol.user.id);
    const c = (await ws.listCollections(carol.user.id, w!.id))[0]!;
    await ws.addItems(carol.user.id, c.id, [{ nodeId: node }]);
    await ws.createView(carol.user.id, w!.id, { name: "v", state: { mode: "global", filters: {} } });
    await ws.putLayout(carol.user.id, w!.id, [{ nodeId: node, x: 1, y: 1, pinned: true }]);
    const exported = await ws.exportUserData(carol.user.id);
    expect(exported.workspaces[0]!.collections[0]!.items).toHaveLength(1);

    const me = await import("@/app/api/me/route");
    const res = await me.DELETE(req("/api/me", { method: "DELETE", cookie: carol.cookie }), ctx({}));
    expect(res.status).toBe(200);
    expect(await db.user.findUnique({ where: { id: carol.user.id } })).toBeNull();
    expect(await db.workspace.count({ where: { ownerId: carol.user.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: carol.user.id } })).toBe(0);
    expect(await db.collection.count({ where: { id: c.id } })).toBe(0);
    expect(await db.nodeLayout.count({ where: { workspaceId: w!.id } })).toBe(0);
    // The old cookie no longer authenticates.
    const after = await me.GET(req("/api/me", { cookie: carol.cookie }), ctx({}));
    expect(after.status).toBe(401);
  });
});
