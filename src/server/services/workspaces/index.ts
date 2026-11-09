/**
 * Personal layer: workspaces → collections → items, saved views, pinned layouts. EVERY query is scoped by owner;
 * resources owned by someone else are reported as NOT_FOUND (no existence leak).
 */
import { db, Prisma } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { enqueue } from "@/server/jobs";
import { log } from "@/server/logger";
import type { ViewState } from "@/shared/contracts/workspaces";

// ── Ownership guards ───────────────────────────────────────────────────────

export async function ownWorkspace(userId: string, workspaceId: string) {
  const ws = await db.workspace.findFirst({ where: { id: workspaceId, ownerId: userId }, select: { id: true } });
  if (!ws) throw notFound("Workspace");
  return ws.id;
}

export async function ownCollection(userId: string, collectionId: string) {
  const c = await db.collection.findFirst({ where: { id: collectionId, workspace: { ownerId: userId } }, select: { id: true, workspaceId: true } });
  if (!c) throw notFound("Collection");
  return c;
}

export async function ownView(userId: string, viewId: string) {
  const v = await db.savedView.findFirst({ where: { id: viewId, workspace: { ownerId: userId } }, select: { id: true } });
  if (!v) throw notFound("View");
  return v.id;
}

// ── Workspaces ─────────────────────────────────────────────────────────────

const wsSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { collections: true, savedViews: true, layouts: true } },
} satisfies Prisma.WorkspaceSelect;

export async function listWorkspaces(userId: string) {
  let rows = await db.workspace.findMany({ where: { ownerId: userId }, orderBy: { createdAt: "asc" }, select: wsSelect });
  if (!rows.length) {
    // Safety net: the signup hook creates one, but never leave a user without a workspace.
    await db.workspace.create({ data: { ownerId: userId, name: "My atlas", collections: { create: { name: "Favorites", icon: "star" } } } });
    rows = await db.workspace.findMany({ where: { ownerId: userId }, orderBy: { createdAt: "asc" }, select: wsSelect });
  }
  return rows;
}

export async function createWorkspace(userId: string, data: { name: string; description?: string }) {
  if ((await db.workspace.count({ where: { ownerId: userId } })) >= 50) throw new AppError("CONFLICT", "Workspace limit reached (50)");
  return db.workspace.create({ data: { ownerId: userId, ...data }, select: wsSelect });
}

export async function getWorkspace(userId: string, id: string) {
  await ownWorkspace(userId, id);
  return db.workspace.findUniqueOrThrow({
    where: { id },
    select: { ...wsSelect, collections: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: collectionSelect }, savedViews: { orderBy: { createdAt: "desc" }, select: viewSelect } },
  });
}

export async function updateWorkspace(userId: string, id: string, data: { name?: string; description?: string | null }) {
  await ownWorkspace(userId, id);
  return db.workspace.update({ where: { id }, data, select: wsSelect });
}

export async function deleteWorkspace(userId: string, id: string) {
  await ownWorkspace(userId, id);
  if ((await db.workspace.count({ where: { ownerId: userId } })) <= 1) throw new AppError("CONFLICT", "You must keep at least one workspace");
  const nodeIds = await memberNodeIds({ workspaceId: id });
  await db.workspace.delete({ where: { id } });
  await retier(nodeIds);
}

// ── Collections ────────────────────────────────────────────────────────────

const collectionSelect = {
  id: true,
  workspaceId: true,
  name: true,
  description: true,
  color: true,
  icon: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
} satisfies Prisma.CollectionSelect;

export async function listCollections(userId: string, workspaceId: string) {
  await ownWorkspace(userId, workspaceId);
  return db.collection.findMany({ where: { workspaceId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: collectionSelect });
}

export async function createCollection(userId: string, workspaceId: string, data: { name: string; description?: string; color?: string; icon?: string }) {
  await ownWorkspace(userId, workspaceId);
  const max = await db.collection.aggregate({ where: { workspaceId }, _max: { sortOrder: true } });
  return db.collection.create({ data: { workspaceId, ...data, sortOrder: (max._max.sortOrder ?? -1) + 1 }, select: collectionSelect });
}

export interface ItemDTO {
  id: string;
  nodeId: string;
  note: string | null;
  tags: string[];
  addedAt: Date;
  node: { type: string; label: string; attrs: Record<string, unknown> } | null;
}

export async function getCollection(userId: string, id: string) {
  await ownCollection(userId, id);
  const c = await db.collection.findUniqueOrThrow({ where: { id }, select: { ...collectionSelect, items: { orderBy: { addedAt: "desc" }, select: { id: true, nodeId: true, note: true, tags: true, addedAt: true } } } });
  const nodes = await db.graphNode.findMany({ where: { id: { in: c.items.map((i) => i.nodeId) } }, select: { id: true, type: true, label: true, attrs: true } });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const items: ItemDTO[] = c.items.map((i) => {
    const n = byId.get(i.nodeId);
    return { ...i, node: n ? { type: n.type, label: n.label, attrs: (n.attrs ?? {}) as Record<string, unknown> } : null };
  });
  return { ...c, items };
}

export async function updateCollection(userId: string, id: string, data: { name?: string; description?: string | null; color?: string; icon?: string; sortOrder?: number }) {
  await ownCollection(userId, id);
  return db.collection.update({ where: { id }, data, select: collectionSelect });
}

export async function deleteCollection(userId: string, id: string) {
  await ownCollection(userId, id);
  const nodeIds = await memberNodeIds({ collectionId: id });
  await db.collection.delete({ where: { id } });
  await retier(nodeIds);
}

// ── Items ──────────────────────────────────────────────────────────────────

export async function addItems(userId: string, collectionId: string, items: { nodeId: string; note?: string; tags?: string[] }[]) {
  await ownCollection(userId, collectionId);
  const existing = await db.graphNode.findMany({ where: { id: { in: items.map((i) => i.nodeId) } }, select: { id: true } });
  const known = new Set(existing.map((n) => n.id));
  const unknown = items.filter((i) => !known.has(i.nodeId)).map((i) => i.nodeId);
  if (unknown.length) throw new AppError("VALIDATION_ERROR", "Unknown node id(s)", { unknown });
  const res = await db.collectionItem.createMany({
    data: items.map((i) => ({ collectionId, nodeId: i.nodeId, note: i.note, tags: normalizeTags(i.tags ?? []) })),
    skipDuplicates: true,
  });
  await retier(items.map((i) => i.nodeId));
  return { added: res.count, skipped: items.length - res.count };
}

export async function removeItems(userId: string, collectionId: string, sel: { nodeIds?: string[]; itemIds?: string[] }) {
  await ownCollection(userId, collectionId);
  const where: Prisma.CollectionItemWhereInput = { collectionId, OR: [{ nodeId: { in: sel.nodeIds ?? [] } }, { id: { in: sel.itemIds ?? [] } }] };
  const nodes = (await db.collectionItem.findMany({ where, select: { nodeId: true } })).map((i) => i.nodeId);
  const res = await db.collectionItem.deleteMany({ where });
  await retier(nodes);
  return { removed: res.count };
}

export async function updateItem(userId: string, collectionId: string, itemId: string, data: { note?: string | null; tags?: string[] }) {
  await ownCollection(userId, collectionId);
  const item = await db.collectionItem.findFirst({ where: { id: itemId, collectionId }, select: { id: true } });
  if (!item) throw notFound("Item");
  return db.collectionItem.update({ where: { id: itemId }, data: { note: data.note, tags: data.tags ? normalizeTags(data.tags) : undefined }, select: { id: true, nodeId: true, note: true, tags: true, addedAt: true } });
}

export function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40)).filter(Boolean))].slice(0, 20);
}

/** Node IDs in any of the user's collections (for the "collection membership" filter). */
export async function membership(userId: string, workspaceId: string) {
  await ownWorkspace(userId, workspaceId);
  const rows = await db.collectionItem.findMany({ where: { collection: { workspaceId } }, select: { nodeId: true, collectionId: true } });
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.nodeId] ??= []).push(r.collectionId);
  return out;
}

async function memberNodeIds(scope: { workspaceId?: string; collectionId?: string }) {
  const rows = await db.collectionItem.findMany({
    where: scope.collectionId ? { collectionId: scope.collectionId } : { collection: { workspaceId: scope.workspaceId } },
    select: { nodeId: true },
  });
  return rows.map((r) => r.nodeId);
}

/** Collection membership affects sync tier (HOT). */
async function retier(nodeIds: string[]) {
  const yts = [...new Set(nodeIds.filter((n) => n.startsWith("channel:")).map((n) => n.slice(8)))];
  if (!yts.length) return;
  const { updateTier } = await import("@/server/services/ingestion");
  const chans = await db.channel.findMany({ where: { youtubeId: { in: yts } }, select: { id: true } });
  for (const c of chans) await updateTier(c.id).catch((err) => log().warn({ err }, "retier failed"));
}

// ── Export ─────────────────────────────────────────────────────────────────

export async function exportCollection(userId: string, id: string, format: "json" | "csv") {
  const c = await getCollection(userId, id);
  const rows = c.items.map((i) => ({
    nodeId: i.nodeId,
    type: i.node?.type ?? i.nodeId.split(":")[0]!.toUpperCase(),
    label: i.node?.label ?? "",
    url: youtubeUrl(i.nodeId),
    note: i.note ?? "",
    tags: i.tags.join(" "),
    addedAt: i.addedAt.toISOString(),
  }));
  if (format === "json") return { contentType: "application/json", body: JSON.stringify({ collection: { id: c.id, name: c.name, description: c.description }, items: rows }, null, 2), filename: `${slug(c.name)}.json` };
  const header = ["nodeId", "type", "label", "url", "note", "tags", "addedAt"];
  const csv = [header.join(","), ...rows.map((r) => header.map((h) => csvCell(String(r[h as keyof typeof r]))).join(","))].join("\r\n");
  return { contentType: "text/csv; charset=utf-8", body: csv, filename: `${slug(c.name)}.csv` };
}

export function csvCell(v: string) {
  // Neutralize spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) || safe !== v ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection";

export function youtubeUrl(nodeId: string): string {
  const [t, ref] = [nodeId.slice(0, nodeId.indexOf(":")), nodeId.slice(nodeId.indexOf(":") + 1)];
  if (t === "channel") return `https://www.youtube.com/channel/${ref}`;
  if (t === "video") return `https://www.youtube.com/watch?v=${ref}`;
  return "";
}

// ── Saved views ────────────────────────────────────────────────────────────

const viewSelect = { id: true, workspaceId: true, name: true, state: true, createdAt: true } satisfies Prisma.SavedViewSelect;

export async function listViews(userId: string, workspaceId: string) {
  await ownWorkspace(userId, workspaceId);
  return db.savedView.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, select: viewSelect });
}
export async function createView(userId: string, workspaceId: string, data: { name: string; state: ViewState }) {
  await ownWorkspace(userId, workspaceId);
  return db.savedView.create({ data: { workspaceId, name: data.name, state: data.state as Prisma.InputJsonValue }, select: viewSelect });
}
export async function updateView(userId: string, id: string, data: { name?: string; state?: ViewState }) {
  await ownView(userId, id);
  return db.savedView.update({ where: { id }, data: { name: data.name, state: data.state as Prisma.InputJsonValue | undefined }, select: viewSelect });
}
export async function deleteView(userId: string, id: string) {
  await ownView(userId, id);
  await db.savedView.delete({ where: { id } });
}

// ── Layouts ────────────────────────────────────────────────────────────────

export async function getLayout(userId: string, workspaceId: string) {
  await ownWorkspace(userId, workspaceId);
  return db.nodeLayout.findMany({ where: { workspaceId }, select: { nodeId: true, x: true, y: true, pinned: true } });
}

export async function putLayout(userId: string, workspaceId: string, positions: { nodeId: string; x: number; y: number; pinned: boolean }[], remove: string[] = []) {
  await ownWorkspace(userId, workspaceId);
  if (positions.length) {
    const values = Prisma.join(positions.map((p) => Prisma.sql`(${workspaceId}, ${p.nodeId}, ${p.x}, ${p.y}, ${p.pinned})`));
    await db.$executeRaw`
      INSERT INTO "NodeLayout" ("workspaceId", "nodeId", x, y, pinned) VALUES ${values}
      ON CONFLICT ("workspaceId", "nodeId") DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, pinned = EXCLUDED.pinned`;
  }
  if (remove.length) await db.nodeLayout.deleteMany({ where: { workspaceId, nodeId: { in: remove } } });
  return { saved: positions.length, removed: remove.length };
}

// ── Account export / deletion ──────────────────────────────────────────────

export async function exportUserData(userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true, image: true, role: true, createdAt: true, reducedMotion: true, defaultLayout: true } });
  const workspaces = await db.workspace.findMany({
    where: { ownerId: userId },
    select: { id: true, name: true, description: true, createdAt: true, collections: { select: { id: true, name: true, description: true, color: true, icon: true, items: { select: { nodeId: true, note: true, tags: true, addedAt: true } } } }, savedViews: { select: { name: true, state: true, createdAt: true } }, layouts: { select: { nodeId: true, x: true, y: true, pinned: true } } },
  });
  const discovery = await db.discoveryQuery.findMany({ where: { userId }, select: { query: true, nicheId: true, resultChannelIds: true, createdAt: true } });
  const uploads = await db.transcript.findMany({ where: { uploadedById: userId }, select: { video: { select: { youtubeId: true, title: true } }, fetchedAt: true, language: true } });
  const yt = await db.youTubeConnection.findUnique({ where: { userId }, select: { channelIds: true, scope: true, createdAt: true } });
  return { exportedAt: new Date().toISOString(), user, workspaces, discoveryQueries: discovery, transcriptUploads: uploads, youtubeConnection: yt };
}

/** Deletes the user and ALL personal data (cascades), plus data obtained through their YouTube connection. */
export async function deleteAccount(userId: string) {
  const nodes = await db.collectionItem.findMany({ where: { collection: { workspace: { ownerId: userId } } }, select: { nodeId: true } });
  const yt = await db.youTubeConnection.findUnique({ where: { userId }, select: { channelIds: true } });
  if (yt) await purgeYouTubeConnectionData(userId, yt.channelIds);
  // Uploaded transcripts are personal contributions: remove them.
  const uploaded = await db.transcript.findMany({ where: { uploadedById: userId }, select: { id: true, videoId: true } });
  if (uploaded.length) {
    await db.transcript.deleteMany({ where: { id: { in: uploaded.map((u) => u.id) } } });
    await db.video.updateMany({ where: { id: { in: uploaded.map((u) => u.videoId) } }, data: { hasTranscript: false } });
  }
  await db.discoveryQuery.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } }); // sessions, accounts, workspaces → collections/items/views/layouts cascade
  await retier(nodes.map((n) => n.nodeId));
  log().info({ userId }, "account deleted");
}

/** Revoking the YouTube connection deletes owner-caption transcripts obtained through it. */
export async function purgeYouTubeConnectionData(userId: string, channelIds: string[]) {
  const tx = await db.transcript.findMany({ where: { source: "OWNER_CAPTIONS", video: { channel: { youtubeId: { in: channelIds } } } }, select: { id: true, videoId: true } });
  if (tx.length) {
    await db.transcript.deleteMany({ where: { id: { in: tx.map((t) => t.id) } } });
    await db.video.updateMany({ where: { id: { in: tx.map((t) => t.videoId) } }, data: { hasTranscript: false } });
    const vids = await db.video.findMany({ where: { id: { in: tx.map((t) => t.videoId) } }, select: { id: true } });
    await enqueue.topics(vids.map((v) => v.id));
  }
  await db.youTubeConnection.deleteMany({ where: { userId } });
}
