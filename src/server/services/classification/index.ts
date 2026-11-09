/**
 * Niche classification (spec §7.5): per (channel, subniche)
 *   0.55·embedding_cosine(channel, centroid) + 0.25·keyword_score + 0.20·topicCategory_match
 * Multi-label (≤ 3 above CLASSIFY_MIN_CONFIDENCE), the best is always kept (flagged low-confidence if below).
 * MANUAL assignments always win and survive reclassification. Centroids drift as a running mean of confident members.
 */
import { db, type ClassMethod } from "@/server/db";
import { env } from "@/server/env";
import { redis, key } from "@/server/redis";
import { enqueue } from "@/server/jobs";
import { log } from "@/server/logger";
import { getVector, setVector, normalize, toVectorLiteral } from "@/server/db/vector";
import { normalizePhrase, tokenize, singularize } from "@/server/services/topics";
import { aiEnabled, rerankNiche } from "@/server/services/ai";
import { TAXONOMY } from "@/server/taxonomy";

export const WEIGHTS = { embedding: 0.55, keyword: 0.25, topic: 0.2 } as const;
const MAX_LABELS = 3;
/** Seed descriptions count as this many members in the running-mean centroid. */
const SEED_WEIGHT = 3;

/** Wikipedia topic URL → top-level niche slugs (config table derived from the taxonomy). */
export const TOPIC_CATEGORY_MAP: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const n of TAXONOMY) for (const url of n.topicCategories) m.set(url, [...(m.get(url) ?? []), n.slug]);
  return m;
})();

/** Rescale MiniLM cosine (related text ≈ 0.15–0.6) onto 0..1. */
export function rescaleCosine(cos: number): number {
  return Math.max(0, Math.min(1, (cos - 0.12) / 0.48));
}

export interface SubnicheProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  parentSlug: string;
  keywords: string[]; // normalized
}

/** BM25-ish keyword score per subniche over the channel's text, saturated to 0..1. */
export function keywordScores(text: string, subs: SubnicheProfile[]): Map<string, { score: number; matched: string[] }> {
  const toks = tokenize(text).map(singularize);
  const doc = ` ${toks.join(" ")} `;
  const len = toks.length || 1;
  const k1 = 1.2;
  const b = 0.5;
  const avgLen = 600;
  const sf = new Map<string, number>();
  for (const s of subs) for (const k of new Set(s.keywords)) sf.set(k, (sf.get(k) ?? 0) + 1);
  const S = subs.length;
  const out = new Map<string, { score: number; matched: string[] }>();
  for (const s of subs) {
    let raw = 0;
    const matched: string[] = [];
    for (const k of new Set(s.keywords)) {
      if (!k) continue;
      let tf = 0;
      let i = doc.indexOf(` ${k} `);
      while (i !== -1) {
        tf++;
        i = doc.indexOf(` ${k} `, i + k.length + 1);
      }
      if (!tf) continue;
      matched.push(k);
      const idf = Math.log(1 + (S - (sf.get(k) ?? 0) + 0.5) / ((sf.get(k) ?? 0) + 0.5));
      raw += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgLen))) * (k.includes(" ") ? 1.3 : 1);
    }
    out.set(s.id, { score: raw / (raw + 6), matched });
  }
  return out;
}

export function combine(parts: { embedding: number; keyword: number; topic: number }): number {
  return +(WEIGHTS.embedding * parts.embedding + WEIGHTS.keyword * parts.keyword + WEIGHTS.topic * parts.topic).toFixed(4);
}

export interface Assignment {
  nicheId: string;
  slug: string;
  confidence: number;
  method: ClassMethod;
  lowConfidence: boolean;
  rationale: string;
}

/** Pick ≤ 3 labels above threshold; always keep the best (flag low-confidence). */
export function selectLabels<T extends { confidence: number }>(ranked: T[], threshold: number): (T & { lowConfidence: boolean })[] {
  const sorted = [...ranked].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (!best) return [];
  const out = [{ ...best, lowConfidence: best.confidence < threshold }];
  for (const r of sorted.slice(1)) {
    if (out.length >= MAX_LABELS) break;
    if (r.confidence >= threshold && r.confidence >= best.confidence * 0.7) out.push({ ...r, lowConfidence: false });
  }
  return out;
}

let profileCache: { at: number; subs: SubnicheProfile[] } | null = null;
async function subnicheProfiles(): Promise<SubnicheProfile[]> {
  if (profileCache && Date.now() - profileCache.at < 60_000) return profileCache.subs;
  const rows = await db.niche.findMany({ where: { depth: 1 }, select: { id: true, slug: true, name: true, description: true, keywords: true, parent: { select: { slug: true } } } });
  const subs = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    parentSlug: r.parent?.slug ?? "",
    keywords: [...new Set([...r.keywords, r.name].map(normalizePhrase).filter(Boolean))],
  }));
  profileCache = { at: Date.now(), subs };
  return subs;
}

export async function scoreChannel(channelId: string) {
  const c = await db.channel.findUnique({
    where: { id: channelId },
    select: { id: true, youtubeId: true, title: true, description: true, keywords: true, topicCategories: true },
  });
  if (!c) return null;
  const recent = await db.video.findMany({ where: { channelId }, orderBy: { publishedAt: "desc" }, take: 30, select: { title: true, tags: true } });
  const text = [c.title, c.description, c.keywords.join(" . "), ...recent.map((r) => `${r.title} . ${r.tags.join(" . ")}`)].join(" . ");
  const subs = await subnicheProfiles();
  const kw = keywordScores(text, subs);
  const vec = await getVector("Channel", channelId);
  const cos = new Map<string, number>();
  if (vec) {
    const rows = await db.$queryRaw<{ id: string; cos: number }[]>`
      SELECT id, 1 - (centroid <=> ${toVectorLiteral(vec)}::vector) AS cos FROM "Niche" WHERE depth = 1 AND centroid IS NOT NULL`;
    for (const r of rows) cos.set(r.id, r.cos);
  }
  const channelNiches = new Set(c.topicCategories.flatMap((u) => TOPIC_CATEGORY_MAP.get(u) ?? []));
  const ranked = subs.map((s) => {
    const parts = { embedding: rescaleCosine(cos.get(s.id) ?? 0), keyword: kw.get(s.id)?.score ?? 0, topic: channelNiches.has(s.parentSlug) ? 1 : 0 };
    return { sub: s, parts, confidence: combine(parts), matched: kw.get(s.id)?.matched ?? [], rawCos: cos.get(s.id) ?? 0 };
  });
  return { channel: c, ranked, hasEmbedding: Boolean(vec), recentTitles: recent.map((r) => r.title), vec };
}

async function updateCentroid(nicheId: string, channelId: string, vec: number[]) {
  const added = await redis.sadd(key("centroid", "contrib", nicheId), channelId);
  if (!added) return;
  const row = await db.niche.findUnique({ where: { id: nicheId }, select: { centroidCount: true } });
  const current = await getVector("Niche", nicheId);
  if (!row || !current) return;
  const w = row.centroidCount + SEED_WEIGHT;
  const next = normalize(current.map((x, i) => x * w + vec[i]!));
  await setVector("Niche", nicheId, next);
  await db.niche.update({ where: { id: nicheId }, data: { centroidCount: { increment: 1 } } });
}

export async function recomputeNicheCounts() {
  await db.$executeRaw`
    UPDATE "Niche" n SET "channelCount" = COALESCE((
      SELECT count(DISTINCT cn."channelId")::int FROM "ChannelNiche" cn JOIN "Niche" s ON s.id = cn."nicheId"
      WHERE s.id = n.id OR s."parentId" = n.id), 0)`;
}

export async function classifyChannel(channelId: string): Promise<{ assignments: Assignment[]; manual: boolean } | null> {
  const manual = await db.channelNiche.findMany({ where: { channelId, method: "MANUAL" }, select: { nicheId: true } });
  const ch = await db.channel.findUnique({ where: { id: channelId }, select: { youtubeId: true } });
  if (!ch) return null;
  const before = await db.channelNiche.findMany({ where: { channelId }, select: { niche: { select: { slug: true } } } });
  if (manual.length) {
    // Manual overrides win: drop any automatic labels.
    await db.channelNiche.deleteMany({ where: { channelId, NOT: { method: "MANUAL" } } });
    await recomputeNicheCounts();
    await enqueue.graph([`channel:${ch.youtubeId}`, ...before.map((b) => `subniche:${b.niche.slug}`)]);
    return { assignments: [], manual: true };
  }
  const scored = await scoreChannel(channelId);
  if (!scored) return null;
  const threshold = env.CLASSIFY_MIN_CONFIDENCE;
  const method: ClassMethod = scored.hasEmbedding ? "EMBEDDING" : "RULES";
  let picks = selectLabels(scored.ranked, threshold).map<Assignment>((r) => ({
    nicheId: r.sub.id,
    slug: r.sub.slug,
    confidence: r.confidence,
    method,
    lowConfidence: r.lowConfidence,
    rationale: `embedding ${r.rawCos.toFixed(2)} · keywords ${r.parts.keyword.toFixed(2)}${r.matched.length ? ` (${r.matched.slice(0, 4).join(", ")})` : ""}${r.parts.topic ? " · topic category match" : ""}`,
  }));

  if (aiEnabled() && picks[0]?.lowConfidence) {
    const candidates = [...scored.ranked].sort((a, b) => b.confidence - a.confidence).slice(0, 6).map((r) => r.sub);
    try {
      const ai = await rerankNiche({ title: scored.channel.title, description: scored.channel.description, keywords: scored.channel.keywords, recentTitles: scored.recentTitles }, candidates);
      if (ai) {
        const sub = candidates.find((c) => c.slug === ai.slug)!;
        picks = [{ nicheId: sub.id, slug: sub.slug, confidence: Math.max(ai.confidence, picks[0]!.confidence), method: "AI", lowConfidence: ai.confidence < threshold, rationale: ai.rationale }];
      }
    } catch (err) {
      log().warn({ err, channelId }, "AI niche re-rank failed; keeping embedding result");
    }
  }

  await db.$transaction([
    db.channelNiche.deleteMany({ where: { channelId } }),
    db.channelNiche.createMany({
      data: picks.map((p) => ({ channelId, nicheId: p.nicheId, confidence: p.confidence, method: p.method, lowConfidence: p.lowConfidence, rationale: p.rationale })),
    }),
  ]);
  if (scored.vec) {
    for (const p of picks) if (!p.lowConfidence && p.confidence >= threshold + 0.1) await updateCentroid(p.nicheId, channelId, scored.vec);
  }
  await recomputeNicheCounts();
  await enqueue.graph([`channel:${ch.youtubeId}`, ...new Set([...before.map((b) => `subniche:${b.niche.slug}`), ...picks.map((p) => `subniche:${p.slug}`)])]);
  return { assignments: picks, manual: false };
}

/** PATCH /api/channels/:id/niches — replace manual assignments (empty → clear and reclassify). */
export async function setManualNiches(channelId: string, nicheIdsOrSlugs: string[], userId: string) {
  const ch = await db.channel.findUniqueOrThrow({ where: { id: channelId }, select: { youtubeId: true } });
  const niches = await db.niche.findMany({ where: { depth: 1, OR: [{ id: { in: nicheIdsOrSlugs } }, { slug: { in: nicheIdsOrSlugs } }] }, select: { id: true, slug: true } });
  if (niches.length !== new Set(nicheIdsOrSlugs).size) {
    const { AppError } = await import("@/server/errors");
    throw new AppError("VALIDATION_ERROR", "Unknown subniche id/slug", { known: niches.map((n) => n.slug) });
  }
  const before = await db.channelNiche.findMany({ where: { channelId }, select: { niche: { select: { slug: true } } } });
  if (!niches.length) {
    await db.channelNiche.deleteMany({ where: { channelId, method: "MANUAL" } });
    await classifyChannel(channelId);
  } else {
    await db.$transaction([
      db.channelNiche.deleteMany({ where: { channelId } }),
      db.channelNiche.createMany({ data: niches.map((n) => ({ channelId, nicheId: n.id, confidence: 1, method: "MANUAL" as const, rationale: `Set manually by user ${userId}` })) }),
    ]);
    await recomputeNicheCounts();
  }
  await enqueue.graph([`channel:${ch.youtubeId}`, ...before.map((b) => `subniche:${b.niche.slug}`), ...niches.map((n) => `subniche:${n.slug}`)]);
  return db.channelNiche.findMany({ where: { channelId }, select: { confidence: true, method: true, lowConfidence: true, rationale: true, niche: { select: { id: true, slug: true, name: true } } } });
}

/** Upsert taxonomy rows (seed). Returns niche ids that need a centroid embedding. */
export async function seedTaxonomy(): Promise<string[]> {
  const needEmbedding: string[] = [];
  for (const n of TAXONOMY) {
    const parent = await db.niche.upsert({
      where: { slug: n.slug },
      create: { slug: n.slug, name: n.name, description: n.description, keywords: n.keywords, discoveryQueries: n.discoveryQueries, depth: 0 },
      update: { name: n.name, description: n.description, keywords: n.keywords, discoveryQueries: n.discoveryQueries, depth: 0, parentId: null },
      select: { id: true },
    });
    for (const s of n.children) {
      const row = await db.niche.upsert({
        where: { slug: s.slug },
        create: { slug: s.slug, name: s.name, description: s.description, keywords: s.keywords, discoveryQueries: s.discoveryQueries, depth: 1, parentId: parent.id },
        update: { name: s.name, description: s.description, keywords: s.keywords, discoveryQueries: s.discoveryQueries, depth: 1, parentId: parent.id },
        select: { id: true },
      });
      needEmbedding.push(row.id);
    }
    needEmbedding.push(parent.id);
  }
  const withCentroid = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "Niche" WHERE centroid IS NOT NULL`;
  const have = new Set(withCentroid.map((r) => r.id));
  profileCache = null;
  return needEmbedding.filter((id) => !have.has(id));
}


// ── Suggested subniches ────────────────────────────────────────────────────

export { suggestSubniches, dismissSuggestion, suggestionId, type SubnicheSuggestion, type SuggestOptions } from "./suggestions";
import { acceptSuggestion, type AcceptInput } from "./suggestions";

export async function acceptSubnicheSuggestion(input: AcceptInput) {
  const niche = await acceptSuggestion(
    input,
    (id) => classifyChannel(id),
    async (channelId, nicheId) => (await scoreChannel(channelId))?.ranked.find((r) => r.sub.id === nicheId)?.confidence ?? 0,
    () => {
      profileCache = null;
    },
  );
  await recomputeNicheCounts();
  return niche;
}
