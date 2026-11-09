import { db } from "@/server/db";
import { notFound } from "@/server/errors";
import type { RelatedCreator } from "@/shared/contracts/graph";
import { EDGE_PROVENANCE } from "./provenance";

const KIND_FACTOR: Record<string, number> = { FEATURED: 1, SIMILAR: 0.9, CO_TOPIC: 0.8, CO_DISCOVERED: 0.3 };

/** Merge FEATURED / SIMILAR / CO_TOPIC / CO_DISCOVERED into one ranked list with human-readable reasons. */
export async function relatedCreators(channelYoutubeId: string, limit = 20): Promise<RelatedCreator[]> {
  const self = await db.channel.findUnique({ where: { youtubeId: channelYoutubeId }, select: { title: true, featuredChannelIds: true } });
  if (!self) throw notFound("Channel");
  const nodeId = `channel:${channelYoutubeId}`;
  const edges = await db.graphEdge.findMany({
    where: { kind: { in: ["FEATURED", "SIMILAR", "CO_TOPIC", "CO_DISCOVERED"] }, OR: [{ sourceId: nodeId }, { targetId: nodeId }] },
    select: { sourceId: true, targetId: true, kind: true, weight: true, evidence: true },
  });
  const acc = new Map<string, { score: number; reasons: RelatedCreator["reasons"] }>();
  for (const e of edges) {
    const other = e.sourceId === nodeId ? e.targetId : e.sourceId;
    if (!other.startsWith("channel:")) continue;
    const ev = (e.evidence ?? {}) as { shared?: string[]; similarity?: number; query?: string; by?: string };
    let text: string;
    switch (e.kind) {
      case "FEATURED":
        text = e.sourceId === nodeId ? `Featured by ${self.title}` : `Features ${self.title}`;
        break;
      case "SIMILAR":
        text = `Semantic similarity ${(ev.similarity ?? e.weight).toFixed(2)}`;
        break;
      case "CO_TOPIC":
        text = `Shares topics: ${(ev.shared ?? []).slice(0, 3).join(", ") || "several"}`;
        break;
      default:
        text = ev.query ? `Found together in discovery for “${ev.query}”` : "Found together in discovery";
    }
    const r = acc.get(other) ?? { score: 0, reasons: [] };
    r.score += e.weight * (KIND_FACTOR[e.kind] ?? 0.5);
    r.reasons.push({ kind: e.kind, text, weight: +e.weight.toFixed(3), label: EDGE_PROVENANCE[e.kind].label, basis: EDGE_PROVENANCE[e.kind].basis });
    acc.set(other, r);
  }
  const ids = [...acc.keys()].map((id) => id.slice(8));
  const channels = await db.channel.findMany({ where: { youtubeId: { in: ids } }, select: { youtubeId: true, title: true, thumbnailUrl: true, subscriberCount: true } });
  const out: RelatedCreator[] = channels.map((c) => {
    const r = acc.get(`channel:${c.youtubeId}`)!;
    return {
      nodeId: `channel:${c.youtubeId}`,
      youtubeId: c.youtubeId,
      title: c.title,
      thumbnailUrl: c.thumbnailUrl,
      subscriberCount: c.subscriberCount === null ? null : Number(c.subscriberCount),
      inAtlas: true,
      score: +r.score.toFixed(4),
      reasons: r.reasons.sort((a, b) => (KIND_FACTOR[b.kind] ?? 0) * b.weight - (KIND_FACTOR[a.kind] ?? 0) * a.weight),
    };
  });
  // Featured channels not yet in the atlas: suggest them (one click to add).
  const known = new Set(channels.map((c) => c.youtubeId));
  const inDb = new Set((await db.channel.findMany({ where: { youtubeId: { in: self.featuredChannelIds } }, select: { youtubeId: true } })).map((c) => c.youtubeId));
  for (const yt of self.featuredChannelIds) {
    if (known.has(yt) || inDb.has(yt)) continue;
    out.push({ nodeId: `channel:${yt}`, youtubeId: yt, title: yt, thumbnailUrl: null, subscriberCount: null, inAtlas: false, score: 0.5, reasons: [{ kind: "FEATURED", text: `Featured by ${self.title} (not in atlas yet)`, weight: 1, label: "FACT", basis: "youtube-fact" }] });
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
