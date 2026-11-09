/**
 * Relationship + classification quality evaluation (prompt §9.3, deferred D8). Measures before tuning: thresholds are
 * only worth changing with these numbers in hand.
 *
 * Ground truth: in fixture mode, the fictional dataset's subniche labels (fixtures/youtube/index.json); otherwise the
 * channels a human labelled manually (ChannelNiche.method = MANUAL). Channels without a gold label are ignored.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { db, type EdgeKind } from "@/server/db";
import { redis, key } from "@/server/redis";
import { ALL_SUBNICHES } from "@/server/taxonomy";
import { fixtureDir } from "@/server/youtube/fixture";
import { youtubeMode } from "@/server/youtube";
import { semanticAvailable } from "@/server/services/embeddings";
import { EDGE_PROVENANCE } from "./provenance";

const KINDS: EdgeKind[] = ["SIMILAR", "CO_TOPIC", "CO_DISCOVERED", "FEATURED"];
const THRESHOLDS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const MAX_SWEEP_CHANNELS = 1_500;

export interface KindQuality {
  kind: EdgeKind;
  label: "FACT" | "INFERRED";
  edges: number;
  /** Fraction of edges whose endpoints share the gold subniche / parent niche. */
  precision: number | null;
  precisionParent: number | null;
  /** Fraction of same-subniche channel pairs connected by this kind. */
  recall: number | null;
  meanWeight: number | null;
  /** Precision of the stronger vs weaker half of edges (is weight a useful confidence?). */
  calibration: { strongHalf: number | null; weakHalf: number | null };
  /** Fraction of edges carrying evidence beyond bookkeeping. */
  evidenceRate: number | null;
  /** Jaccard of this kind's edge set vs the previous evaluation (null on the first run). */
  stability: number | null;
}

export interface QualityReport {
  goldSource: "fixture-labels" | "manual-labels";
  labelledChannels: number;
  sameSubnichePairs: number;
  kinds: KindQuality[];
  /** SIMILAR: precision/recall of "cosine ≥ t" over all labelled pairs (independent of top-k). */
  similarSweep: { threshold: number; pairs: number; precision: number | null; recall: number | null }[] | null;
  classification: { evaluated: number; top1: number | null; anyLabel: number | null; parentTop1: number | null };
  generatedAt: string;
}

const ratio = (a: number, b: number) => (b ? +(a / b).toFixed(4) : null);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

async function goldLabels(): Promise<{ source: QualityReport["goldSource"]; byYt: Map<string, string> }> {
  if (youtubeMode() === "fixture") {
    const idx = JSON.parse(readFileSync(path.join(fixtureDir(), "index.json"), "utf8")) as { channels: { id: string; subniche: string }[] };
    return { source: "fixture-labels", byYt: new Map(idx.channels.map((c) => [c.id, c.subniche])) };
  }
  const rows = await db.channelNiche.findMany({ where: { method: "MANUAL" }, orderBy: { confidence: "desc" }, select: { channel: { select: { youtubeId: true } }, niche: { select: { slug: true } } } });
  const byYt = new Map<string, string>();
  for (const r of rows) if (!byYt.has(r.channel.youtubeId)) byYt.set(r.channel.youtubeId, r.niche.slug);
  return { source: "manual-labels", byYt };
}

export async function evaluateQuality(opts: { remember?: boolean } = {}): Promise<QualityReport> {
  const gold = await goldLabels();
  const parentOf = new Map(ALL_SUBNICHES.map((s) => [s.slug, s.parent.slug]));
  const channels = await db.channel.findMany({ where: { youtubeId: { in: [...gold.byYt.keys()] } }, select: { id: true, youtubeId: true } });
  const label = new Map(channels.map((c) => [`channel:${c.youtubeId}`, gold.byYt.get(c.youtubeId)!]));
  const nodes = [...label.keys()];

  const bySub = new Map<string, number>();
  for (const l of label.values()) bySub.set(l, (bySub.get(l) ?? 0) + 1);
  const samePairs = [...bySub.values()].reduce((a, n) => a + (n * (n - 1)) / 2, 0);

  const kinds: KindQuality[] = [];
  for (const kind of KINDS) {
    const edges = await db.graphEdge.findMany({ where: { kind, sourceId: { in: nodes }, targetId: { in: nodes } }, select: { id: true, sourceId: true, targetId: true, weight: true, evidence: true } });
    const pairs = new Map<string, { w: number; same: boolean; parent: boolean; ev: boolean }>();
    for (const e of edges) {
      const a = label.get(e.sourceId)!;
      const b = label.get(e.targetId)!;
      const ev = Object.keys((e.evidence ?? {}) as object).some((k) => k !== "from");
      const k = pairKey(e.sourceId, e.targetId);
      const prev = pairs.get(k);
      pairs.set(k, { w: Math.max(prev?.w ?? 0, e.weight), same: a === b, parent: parentOf.get(a) === parentOf.get(b), ev: ev || Boolean(prev?.ev) });
    }
    const list = [...pairs.values()].sort((x, y) => y.w - x.w);
    const same = list.filter((p) => p.same).length;
    const half = Math.ceil(list.length / 2);
    const strong = list.slice(0, half);
    const weak = list.slice(half);
    let stability: number | null = null;
    const snapKey = key("graph", "eval", "edges", kind);
    const prevIds = await redis.smembers(snapKey);
    if (prevIds.length || (await redis.exists(key("graph", "eval", "ran")))) {
      const prev = new Set(prevIds);
      const cur = new Set(edges.map((e) => e.id));
      const inter = [...cur].filter((id) => prev.has(id)).length;
      const union = new Set([...cur, ...prev]).size;
      stability = union ? +(inter / union).toFixed(4) : 1;
    }
    if (opts.remember !== false) {
      const multi = redis.multi().del(snapKey);
      if (edges.length) multi.sadd(snapKey, ...edges.map((e) => e.id));
      await multi.exec();
    }
    kinds.push({
      kind,
      label: EDGE_PROVENANCE[kind].label,
      edges: list.length,
      precision: ratio(same, list.length),
      precisionParent: ratio(list.filter((p) => p.parent).length, list.length),
      recall: ratio(same, samePairs),
      meanWeight: list.length ? +(list.reduce((a, p) => a + p.w, 0) / list.length).toFixed(4) : null,
      calibration: { strongHalf: ratio(strong.filter((p) => p.same).length, strong.length), weakHalf: ratio(weak.filter((p) => p.same).length, weak.length) },
      evidenceRate: ratio(list.filter((p) => p.ev).length, list.length),
      stability,
    });
  }
  if (opts.remember !== false) await redis.set(key("graph", "eval", "ran"), "1");

  // Threshold sweep for SIMILAR from raw pairwise cosine (only when vectors share one model).
  let similarSweep: QualityReport["similarSweep"] = null;
  if (channels.length >= 2 && channels.length <= MAX_SWEEP_CHANNELS && (await semanticAvailable())) {
    const ids = channels.map((c) => c.id);
    const ytOf = new Map(channels.map((c) => [c.id, `channel:${c.youtubeId}`]));
    const rows = await db.$queryRaw<{ a: string; b: string; sim: number }[]>`
      SELECT x.id AS a, y.id AS b, 1 - (x.embedding <=> y.embedding) AS sim FROM "Channel" x JOIN "Channel" y ON x.id < y.id
      WHERE x.id = ANY(${ids}) AND y.id = ANY(${ids}) AND x.embedding IS NOT NULL AND y.embedding IS NOT NULL`;
    similarSweep = THRESHOLDS.map((t) => {
      const above = rows.filter((r) => r.sim >= t);
      const same = above.filter((r) => label.get(ytOf.get(r.a)!) === label.get(ytOf.get(r.b)!)).length;
      return { threshold: t, pairs: above.length, precision: ratio(same, above.length), recall: ratio(same, samePairs) };
    });
  }

  // Classification: is the best automatic label the gold subniche?
  const assigned = await db.channelNiche.findMany({ where: { channelId: { in: channels.map((c) => c.id) }, NOT: { method: "MANUAL" } }, orderBy: { confidence: "desc" }, select: { channelId: true, niche: { select: { slug: true } } } });
  const byChannel = new Map<string, string[]>();
  for (const a of assigned) byChannel.set(a.channelId, [...(byChannel.get(a.channelId) ?? []), a.niche.slug]);
  let top1 = 0;
  let any = 0;
  let parentTop1 = 0;
  for (const c of channels) {
    const labels = byChannel.get(c.id);
    if (!labels?.length) continue;
    const g = gold.byYt.get(c.youtubeId)!;
    if (labels[0] === g) top1++;
    if (labels.includes(g)) any++;
    if (parentOf.get(labels[0]!) === parentOf.get(g)) parentTop1++;
  }
  const evaluated = channels.filter((c) => byChannel.get(c.id)?.length).length;

  const report: QualityReport = {
    goldSource: gold.source,
    labelledChannels: channels.length,
    sameSubnichePairs: samePairs,
    kinds,
    similarSweep,
    classification: { evaluated, top1: ratio(top1, evaluated), anyLabel: ratio(any, evaluated), parentTop1: ratio(parentTop1, evaluated) },
    generatedAt: new Date().toISOString(),
  };
  if (opts.remember !== false) await redis.set(key("graph", "eval", "last"), JSON.stringify(report));
  return report;
}
