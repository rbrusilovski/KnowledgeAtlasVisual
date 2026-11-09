/**
 * Dynamic taxonomy (replaces the fixed demo taxonomy when TAXONOMY_MODE=dynamic).
 *
 *   approved ingestion → embeddings/topics → taxonomy-classify (this service)
 *     → nearest dynamic subniche (REUSE) or growth pool → new subniche / niche when the pool has corpus support
 *     → VideoNiche evidence (authoritative) → ChannelNiche projection → graph dirty set → graph.delta → UI
 *
 * Only ALREADY-COLLECTED videos are classified. Nothing here calls YouTube or enqueues collection: creating a
 * category never triggers discovery (corpus expansion stays behind approved proposals). Category creation is
 * serialized by a Postgres advisory lock, deduplicated by centroid cosine + trigram name similarity, and every
 * row carries provenance (run id, decision, evidence, taxonomy/prompt version).
 */
import { db, Prisma } from "@/server/db";
import { env } from "@/server/env";
import { enqueue } from "@/server/jobs";
import { log } from "@/server/logger";
import { parseVector, setVector } from "@/server/db/vector";
import { embeddingModelId } from "@/server/services/embeddings";
import { slugify, trigramSimilarity, normalizePhrase } from "@/server/services/topics";
import { allowed as policyAllows } from "@/server/youtube/policy";
import { kmeans, enforceSupport, agglomerate, termChannelStats, corpusRatios, leaderClusters, nearest, meanNormalized, dot, clusterTerms, nameFromTerms, type Vec, type NamingDoc } from "./clustering";

export * from "./clustering";

/** Defaults tuned on the first real corpus (12 channels / 2.1k videos, MiniLM-L6 384d). Raw cosine unless noted. */
export const TAXONOMY_CONFIG = {
  version: 1,
  promptVersion: "ctfidf@1",
  /**
   * Incremental decisions compare MEAN-CENTERED vectors (video − corpus mean, renormalized). Raw MiniLM cosines share a
   * large common component: on the first live test, chess and history videos scored 0.46–0.54 raw against unrelated
   * categories (overlapping real members, p10 0.52) but ≤ 0.28 centered (members: p10 0.31, median 0.53).
   */
  /** A video joins an existing subniche when centered cos(video, centroid) ≥ this (≈ members' 10th percentile). */
  reuseCentered: 0.32,
  /** Growth pool: videos within this centered cosine of a forming group's centroid join it. */
  poolCentered: 0.45,
  /**
   * A new subniche attaches to an existing niche when centered cos(group, niche) ≥ this. Measured on the live corpus:
   * subniche→own parent median 0.70 (p10 0.34); subniche→any other parent max 0.40. At 0.30, unrelated history and
   * health groups (0.35 / 0.33) attached under a just-created "Chess" niche; 0.45 clears every wrong-parent score.
   */
  parentCentered: 0.45,
  /** A forming group whose centered centroid cos to an existing subniche is ≥ this is that subniche (no duplicate). */
  dupCentered: 0.8,
  /** Bootstrap: secondary labels need at least this raw cosine. */
  secondaryMinCos: 0.45,
  /** Two subniches whose centroids are ≥ this are duplicates (never create; merge in bootstrap). */
  dupCos: 0.9,
  /** Two category names with trigram similarity ≥ this under the same parent are duplicates. */
  dupName: 0.8,
  /** Corpus support required to create categories incrementally. */
  minNewSubSupport: 4,
  minNewTopSupport: 10,
  /** Bootstrap: minimum videos per generated subniche, and the corpus size below which categories are flagged bootstrap. */
  minBootstrapSupport: 8,
  bootstrapFlagBelow: 200,
  /** Minimum embedded videos before a first taxonomy is generated at all. */
  minCorpus: 30,
  /** Secondary video label when within this cosine of the primary. */
  secondaryWithin: 0.015,
  /** Channel projection: share of a channel's videos needed for membership (≤ 3 labels, best always kept). */
  channelShare: 0.12,
} as const;

const LOCK_KEY = 0x7a7a0001;
/** ChannelNiche.classifier for labels projected from video evidence. */
export const PROJECTION_CLASSIFIER = "taxonomy-projection@1";

export const dynamicMode = () => env.TAXONOMY_MODE === "dynamic";

/** cos → 0..1 confidence (MiniLM: unrelated ≈ 0.1–0.2, typical member 0.6–0.8, near-duplicate ≥ 0.9). */
export const confidenceFromCos = (cos: number) => +Math.max(0, Math.min(1, (cos - 0.2) / 0.7)).toFixed(4);

interface VideoRow {
  id: string;
  youtubeId: string;
  channelId: string;
  title: string;
  tags: string[];
  vec: Vec;
}

async function loadVideos(where: Prisma.Sql = Prisma.sql`TRUE`, limit = 50_000, client: Pick<Tx, "$queryRaw"> = db): Promise<VideoRow[]> {
  const rows = await client.$queryRaw<{ id: string; youtubeId: string; channelId: string; title: string; tags: string[]; e: string }[]>`
    SELECT id, "youtubeId", "channelId", title, tags, embedding::text AS e FROM "Video"
    WHERE embedding IS NOT NULL AND "isAvailable" AND ${where} ORDER BY id LIMIT ${limit}`;
  return rows.map((r) => ({ id: r.id, youtubeId: r.youtubeId, channelId: r.channelId, title: r.title, tags: r.tags, vec: parseVector(r.e)! }));
}

async function namingDocs(videos: VideoRow[]): Promise<Map<string, NamingDoc>> {
  const topics = await db.videoTopic.findMany({ where: { videoId: { in: videos.map((v) => v.id) }, weight: { gte: 0.2 } }, select: { videoId: true, topic: { select: { label: true } } } });
  const byVideo = new Map<string, string[]>();
  for (const t of topics) byVideo.set(t.videoId, [...(byVideo.get(t.videoId) ?? []), t.topic.label]);
  return new Map(videos.map((v) => [v.id, { title: v.title, tags: v.tags, topics: byVideo.get(v.id) ?? [] }]));
}

/** Channel names/handles + per-channel boilerplate never name a category; also returns channels-per-term. */
async function namingContext(videos: VideoRow[], docs: Map<string, NamingDoc>): Promise<{ excluded: Set<string>; namesOnly: Set<string>; termChannels: Map<string, number> }> {
  const ch = await db.channel.findMany({ select: { title: true, handle: true } });
  const names = new Set(ch.flatMap((c) => [normalizePhrase(c.title), normalizePhrase((c.handle ?? "").replace(/^@/, ""))]).filter(Boolean));
  const byChannel = new Map<string, NamingDoc[]>();
  for (const v of videos) byChannel.set(v.channelId, [...(byChannel.get(v.channelId) ?? []), docs.get(v.id)!]);
  const stats = termChannelStats(byChannel, names);
  return { excluded: new Set([...names, ...stats.boilerplate]), namesOnly: names, termChannels: stats.channels };
}

// ── Bootstrap / shadow ─────────────────────────────────────────────────────

export interface ProposedCategory {
  key: string;
  name: string;
  slug: string;
  keywords: string[];
  videoIds: string[];
  channelSpread: Record<string, number>;
  sampleTitles: string[];
  centroid: Vec;
  cohesion: number;
}
export interface ProposedNiche extends Omit<ProposedCategory, "videoIds"> {
  children: ProposedCategory[];
  videoCount: number;
}
export interface TaxonomyPlan {
  corpus: { videos: number; embedded: number; channels: number };
  niches: ProposedNiche[];
  assignments: { videoId: string; subKey: string; cos: number; secondary?: { subKey: string; cos: number } }[];
  quality: { meanCohesion: number; minSubSize: number; maxSubSize: number; maxSiblingCos: number; nameCollisions: string[] };
}

function uniqueSlug(base: string, taken: Set<string>): string {
  const b = slugify(base.toLowerCase()).slice(0, 60) || "category";
  let s = b;
  for (let i = 2; taken.has(s); i++) s = `${b}-${i}`;
  taken.add(s);
  return s;
}

/** Computes a taxonomy over the whole embedded corpus. Pure planning: writes nothing. */
export async function planTaxonomy(opts: { seed?: number; replaceDynamic?: boolean } = {}): Promise<TaxonomyPlan> {
  const videos = await loadVideos();
  const [total, channels] = await Promise.all([db.video.count({ where: { isAvailable: true } }), db.channel.count()]);
  const empty: TaxonomyPlan = { corpus: { videos: total, embedded: videos.length, channels }, niches: [], assignments: [], quality: { meanCohesion: 0, minSubSize: 0, maxSubSize: 0, maxSiblingCos: 0, nameCollisions: [] } };
  if (videos.length < TAXONOMY_CONFIG.minCorpus) return empty;
  const pts = videos.map((v) => v.vec);
  const kSub = Math.max(3, Math.min(60, Math.round(Math.sqrt(videos.length / 2.5))));
  const km = kmeans(pts, kSub, { seed: opts.seed ?? 42 });
  const minSupport = Math.min(TAXONOMY_CONFIG.minBootstrapSupport, Math.max(2, Math.floor(videos.length / (kSub * 3))));
  const { assign, centroids } = enforceSupport(pts, km.assign, minSupport, TAXONOMY_CONFIG.dupCos);
  const sizes = centroids.map((_, c) => assign.filter((a) => a === c).length);
  const kTop = Math.max(2, Math.min(12, Math.round(Math.sqrt(centroids.length) * 1.1)));
  const top = agglomerate(centroids, sizes, kTop);

  const docs = await namingDocs(videos);
  const { excluded, namesOnly, termChannels } = await namingContext(videos, docs);
  const subDocs = centroids.map((_, c) => videos.filter((_, i) => assign[i] === c).map((v) => docs.get(v.id)!));
  const topIds = [...new Set(top)].sort((a, b) => a - b);
  const topDocs = topIds.map((t) => videos.filter((_, i) => top[assign[i]!] === t).map((v) => docs.get(v.id)!));
  // When one channel IS the theme, its recurring terms are both boilerplate and the subject: if nothing
  // survives the boilerplate filter, name the cluster with only channel names excluded.
  const withFallback = (primary: ReturnType<typeof clusterTerms>, fallback: () => ReturnType<typeof clusterTerms>) => {
    if (primary.every((t) => t.length)) return primary;
    const fb = fallback();
    return primary.map((t, i) => (t.length ? t : fb[i]!));
  };
  const topTerms = withFallback(clusterTerms(topDocs, excluded, 6, termChannels), () => clusterTerms(topDocs, namesOnly, 6, termChannels));
  // Subniches are named against their siblings (a word every sibling shares, e.g. "physics", is not distinctive)
  // and never reuse their parent's leading term.
  const corpusRatio = corpusRatios([...docs.values()], excluded);
  const subOpts = { termChannels, corpusRatio, broadAbove: 0.12 };
  const globalSub = withFallback(clusterTerms(subDocs, excluded, 6, subOpts), () => clusterTerms(subDocs, namesOnly, 6, subOpts));
  const subTerms = globalSub.map((t) => t);
  topIds.forEach((t, ti) => {
    const kids = centroids.map((_, c) => c).filter((c) => top[c] === t);
    if (kids.length < 2) return;
    const parentWords = new Set((topTerms[ti]![0]?.term ?? "").split(" ").filter(Boolean));
    const ex = new Set([...excluded, ...(topTerms[ti]![0] ? [topTerms[ti]![0]!.term] : [])]);
    const local = clusterTerms(kids.map((c) => subDocs[c]!), ex, 6, subOpts);
    kids.forEach((c, j) => {
      const l = local[j]!.filter((x) => !x.term.split(" ").every((w) => parentWords.has(w)));
      if (l.length) subTerms[c] = l;
    });
  });
  const chTitle = new Map((await db.channel.findMany({ select: { id: true, title: true } })).map((c) => [c.id, c.title]));
  // Rebuilds/shadows of a replacement reuse current dynamic slugs, so node ids (pins, links) stay stable.
  const taken = new Set((await db.niche.findMany({ where: opts.replaceDynamic ? { NOT: { origin: "DYNAMIC", channels: { none: { method: "MANUAL" } } } } : {}, select: { slug: true } })).map((n) => n.slug));

  const subs: ProposedCategory[] = centroids.map((cent, c) => {
    const members = videos.filter((_, i) => assign[i] === c);
    const spread: Record<string, number> = {};
    for (const m of members) spread[chTitle.get(m.channelId) ?? m.channelId] = (spread[chTitle.get(m.channelId) ?? m.channelId] ?? 0) + 1;
    const name = nameFromTerms(subTerms[c]!, "");
    const byCos = [...members].sort((a, b) => dot(b.vec, cent) - dot(a.vec, cent));
    return { key: `s${c}`, name, slug: "", keywords: subTerms[c]!.map((t) => t.term), videoIds: members.map((m) => m.id), channelSpread: spread, sampleTitles: byCos.slice(0, 5).map((m) => m.title), centroid: cent, cohesion: +(members.reduce((s, m) => s + dot(m.vec, cent), 0) / members.length).toFixed(3) };
  });
  const niches: ProposedNiche[] = topIds.map((t, ti) => {
    const children = subs.filter((_, c) => top[c] === t);
    const centroid = meanNormalized(children.flatMap((ch) => ch.videoIds.map((id) => videos.find((v) => v.id === id)!.vec)));
    const name = nameFromTerms(topTerms[ti]!.slice(0, 1), children[0]?.name ?? `Niche ${ti + 1}`);
    const spread: Record<string, number> = {};
    for (const ch of children) for (const [k, v] of Object.entries(ch.channelSpread)) spread[k] = (spread[k] ?? 0) + v;
    return { key: `n${ti}`, name, slug: "", keywords: topTerms[ti]!.map((x) => x.term), channelSpread: spread, sampleTitles: children.flatMap((c) => c.sampleTitles.slice(0, 1)).slice(0, 5), centroid, cohesion: 0, children, videoCount: children.reduce((s, c) => s + c.videoIds.length, 0) };
  });
  // Colliding top-level names take their next distinctive term ("Science" ×2 → "Science & Algorithm").
  for (const n of niches) if (niches.filter((m) => m.name.toLowerCase() === n.name.toLowerCase()).length > 1 && n.keywords.length > 1) n.name = nameFromTerms(n.keywords.map((term) => ({ term })), n.name);
  // Unnameable subniches (every term was boilerplate) are the parent's general bucket.
  for (const n of niches) for (const c of n.children) if (!c.name) c.name = `General ${n.name}`;
  // A subniche must not share its parent's exact name; disambiguate with its next term.
  for (const n of niches) {
    for (const c of n.children) {
      if (trigramSimilarity(c.name.toLowerCase(), n.name.toLowerCase()) >= TAXONOMY_CONFIG.dupName && c.keywords.length > 1) c.name = nameFromTerms(c.keywords.slice(1).map((term) => ({ term })), c.name);
    }
  }
  for (const n of niches) {
    n.slug = uniqueSlug(n.name, taken);
    for (const c of n.children) c.slug = uniqueSlug(c.name, taken);
  }
  const assignments = videos.map((v, i) => {
    const primary = assign[i]!;
    const sec = nearest(v.vec, centroids, primary);
    const cos = dot(v.vec, centroids[primary]!);
    return { videoId: v.id, subKey: `s${primary}`, cos, ...(sec.index >= 0 && cos - sec.cos <= TAXONOMY_CONFIG.secondaryWithin && sec.cos >= TAXONOMY_CONFIG.secondaryMinCos ? { secondary: { subKey: `s${sec.index}`, cos: sec.cos } } : {}) };
  });
  let maxSiblingCos = 0;
  for (const n of niches) for (let i = 0; i < n.children.length; i++) for (let j = i + 1; j < n.children.length; j++) maxSiblingCos = Math.max(maxSiblingCos, dot(n.children[i]!.centroid, n.children[j]!.centroid));
  const allNames = [...niches.map((n) => n.name), ...subs.map((s) => s.name)].map((x) => x.toLowerCase());
  const nameCollisions = [...new Set(allNames.filter((x, i) => allNames.indexOf(x) !== i))];
  return {
    corpus: empty.corpus,
    niches,
    assignments,
    quality: { meanCohesion: +(subs.reduce((s, c) => s + c.cohesion, 0) / subs.length).toFixed(3), minSubSize: Math.min(...sizes), maxSubSize: Math.max(...sizes), maxSiblingCos: +maxSiblingCos.toFixed(3), nameCollisions },
  };
}

/** JSON-friendly plan summary (drops vectors / id lists). */
export function summarizePlan(p: TaxonomyPlan) {
  return {
    corpus: p.corpus,
    quality: p.quality,
    niches: p.niches.map((n) => ({
      name: n.name,
      slug: n.slug,
      videos: n.videoCount,
      channels: n.channelSpread,
      subniches: n.children.map((c) => ({ name: c.name, slug: c.slug, videos: c.videoIds.length, cohesion: c.cohesion, keywords: c.keywords, channels: c.channelSpread, samples: c.sampleTitles.slice(0, 3) })),
    })),
  };
}

/**
 * Generates the dynamic taxonomy over all embedded videos.
 *   shadow: plan + audit row only (no taxonomy writes).
 *   apply:  writes DYNAMIC niches + VideoNiche evidence, projects ChannelNiche, marks graph dirty.
 * Refuses to apply when DYNAMIC categories already exist unless `rebuild` (which replaces only DYNAMIC
 * categories that no user has assigned manually; MANUAL/SEED categories are never touched).
 */
export async function bootstrapTaxonomy(opts: { shadow: boolean; rebuild?: boolean; seed?: number }) {
  if (!policyAllows("derived-data")) return { skipped: "derived-data policy gate is off" as const };
  const run = await db.taxonomyRun.create({ data: { kind: opts.shadow ? "SHADOW" : "BOOTSTRAP", params: { ...TAXONOMY_CONFIG, rebuild: !!opts.rebuild, seed: opts.seed ?? 42 } } });
  try {
    const hasDynamic = (await db.niche.count({ where: { origin: "DYNAMIC" } })) > 0;
    const plan = await planTaxonomy({ seed: opts.seed, replaceDynamic: hasDynamic && (opts.shadow || opts.rebuild) });
    const summary = summarizePlan(plan);
    if (opts.shadow || !plan.niches.length) {
      await db.taxonomyRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), stats: summary as unknown as Prisma.InputJsonValue } });
      return { runId: run.id, applied: false, plan: summary };
    }
    const result = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
        const existing = await tx.niche.findMany({ where: { origin: "DYNAMIC" }, select: { id: true, slug: true, depth: true, channels: { where: { method: "MANUAL" }, select: { channelId: true } } } });
        if (existing.length && !opts.rebuild) throw new Error("Dynamic taxonomy already exists; use incremental classification or --rebuild");
        const removable = existing.filter((n) => !n.channels.length);
        if (removable.length) await tx.niche.deleteMany({ where: { id: { in: removable.map((n) => n.id) } } });
        const flag = plan.corpus.embedded < TAXONOMY_CONFIG.bootstrapFlagBelow;
        const subIds = new Map<string, string>();
        const centroids: { id: string; v: Vec; n: number }[] = [];
        for (const n of plan.niches) {
          const parent = await tx.niche.create({ data: { slug: n.slug, name: n.name, description: describe(n.videoCount, n.channelSpread), keywords: n.keywords, discoveryQueries: n.keywords.slice(0, 3), depth: 0, origin: "DYNAMIC", status: "ACTIVE", createdByRunId: run.id, bootstrap: flag }, select: { id: true } });
          centroids.push({ id: parent.id, v: n.centroid, n: n.videoCount });
          for (const c of n.children) {
            const row = await tx.niche.create({ data: { slug: c.slug, name: c.name, description: describe(c.videoIds.length, c.channelSpread), keywords: c.keywords, discoveryQueries: c.keywords.slice(0, 3), depth: 1, parentId: parent.id, origin: "DYNAMIC", status: "ACTIVE", createdByRunId: run.id, bootstrap: flag }, select: { id: true } });
            subIds.set(c.key, row.id);
            centroids.push({ id: row.id, v: c.centroid, n: c.videoIds.length });
          }
        }
        const rows: Prisma.VideoNicheCreateManyInput[] = [];
        for (const a of plan.assignments) {
          rows.push(vnRow(a.videoId, subIds.get(a.subKey)!, a.cos, "CREATE", run.id, `founding member (cos ${a.cos.toFixed(2)})`));
          if (a.secondary) rows.push(vnRow(a.videoId, subIds.get(a.secondary.subKey)!, a.secondary.cos, "REUSE", run.id, `secondary label (cos ${a.secondary.cos.toFixed(2)})`));
        }
        await tx.videoNiche.deleteMany({ where: { videoId: { in: plan.assignments.map((a) => a.videoId) }, decision: { not: "MANUAL" }, niche: { origin: "DYNAMIC" } } });
        for (let i = 0; i < rows.length; i += 2_000) await tx.videoNiche.createMany({ data: rows.slice(i, i + 2_000), skipDuplicates: true });
        return { centroids, removed: removable.map((n) => `${n.depth === 0 ? "niche" : "subniche"}:${n.slug}`), created: subIds.size + plan.niches.length };
      },
      { timeout: 120_000 },
    );
    for (const c of result.centroids) {
      await setVector("Niche", c.id, c.v, { model: embeddingModelId() });
      await db.niche.update({ where: { id: c.id }, data: { centroidCount: c.n } });
    }
    const channels = await projectChannels();
    await recomputeTaxonomyCounts();
    const nodeIds = (await db.niche.findMany({ where: { origin: "DYNAMIC", status: "ACTIVE" }, select: { slug: true, depth: true } })).map((n) => `${n.depth === 0 ? "niche" : "subniche"}:${n.slug}`);
    const dirty = [...nodeIds, ...result.removed, ...channels.dirty];
    await db.taxonomyRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), stats: { ...summary, created: result.created, removed: result.removed.length, channelsProjected: channels.channels } as unknown as Prisma.InputJsonValue } });
    log().info({ runId: run.id, created: result.created }, "dynamic taxonomy applied");
    return { runId: run.id, applied: true, created: result.created, removed: result.removed, dirty, plan: summary };
  } catch (err) {
    await db.taxonomyRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: String(err) } });
    throw err;
  }
}

function describe(videos: number, spread: Record<string, number>) {
  const top = Object.entries(spread).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return `Atlas-inferred category generated from ${videos} video${videos === 1 ? "" : "s"}${top.length ? ` (mostly ${top.join(", ")})` : ""}.`;
}

function vnRow(videoId: string, nicheId: string, cos: number, decision: string, runId: string | null, rationale: string, evidence: Prisma.InputJsonValue = { cosine: +cos.toFixed(4) }): Prisma.VideoNicheCreateManyInput {
  return { videoId, nicheId, confidence: confidenceFromCos(cos), decision, rationale, evidence, model: env.EMBEDDING_MODEL, promptVersion: TAXONOMY_CONFIG.promptVersion, taxonomyVersion: TAXONOMY_CONFIG.version, runId };
}

// ── Incremental classification + growth ────────────────────────────────────

/** Corpus mean of video embeddings (pgvector avg) — the shared component removed before incremental comparisons. */
async function corpusMean(client: Pick<Tx, "$queryRaw"> = db): Promise<Vec | null> {
  const r = await client.$queryRaw<{ m: string | null }[]>`SELECT avg(embedding)::text AS m FROM "Video" WHERE embedding IS NOT NULL`;
  return r[0]?.m ? parseVector(r[0].m) : null;
}

export function centerVec(v: Vec, mean: Vec | null): Vec {
  if (!mean) return v;
  const c = v.map((x, i) => x - mean[i]!);
  const n = Math.hypot(...c) || 1;
  return c.map((x) => x / n);
}

async function activeSubs() {
  const rows = await db.$queryRaw<{ id: string; slug: string; name: string; parentId: string; centroidCount: number; c: string }[]>`
    SELECT id, slug, name, "parentId", "centroidCount", centroid::text AS c FROM "Niche"
    WHERE depth = 1 AND origin = 'DYNAMIC' AND status = 'ACTIVE' AND centroid IS NOT NULL ORDER BY id`;
  return rows.map((r) => ({ ...r, v: parseVector(r.c)! }));
}
async function activeTops() {
  const rows = await db.$queryRaw<{ id: string; slug: string; name: string; c: string }[]>`
    SELECT id, slug, name, centroid::text AS c FROM "Niche" WHERE depth = 0 AND origin = 'DYNAMIC' AND status = 'ACTIVE' AND centroid IS NOT NULL ORDER BY id`;
  return rows.map((r) => ({ ...r, v: parseVector(r.c)! }));
}

export interface ClassifyResult {
  classified: number;
  reused: number;
  pooled: number;
  createdSubniches: string[];
  createdNiches: string[];
  bootstrapped?: boolean;
  skipped?: string;
}

/**
 * Classifies already-collected videos (worker stage `taxonomy-classify`). Videos that fit no existing category
 * wait in the growth pool; a pool group with enough corpus support becomes a new subniche (and, with stronger
 * support and no fitting parent, a new niche).
 */
export async function classifyVideos(videoIds: string[]): Promise<ClassifyResult> {
  const out: ClassifyResult = { classified: 0, reused: 0, pooled: 0, createdSubniches: [], createdNiches: [] };
  if (!dynamicMode()) return { ...out, skipped: "TAXONOMY_MODE is not dynamic" };
  if (!policyAllows("derived-data")) return { ...out, skipped: "derived-data policy gate is off" };
  if (!(await db.niche.count({ where: { origin: "DYNAMIC", status: "ACTIVE" } }))) {
    if ((await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Video" WHERE embedding IS NOT NULL`)[0]!.n < TAXONOMY_CONFIG.minCorpus) return { ...out, skipped: "corpus too small for a first taxonomy" };
    const r = await bootstrapTaxonomy({ shadow: false });
    if ("dirty" in r && r.dirty) await enqueue.graph(r.dirty);
    return { ...out, bootstrapped: true, classified: "plan" in r && r.plan ? r.plan.corpus.embedded : 0 };
  }
  const run = await db.taxonomyRun.create({ data: { kind: "INCREMENTAL", params: { videoIds: videoIds.length } } });
  const dirty = new Set<string>();
  const touchedChannels = new Set<string>();
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
        const subs = await activeSubs();
        const mean = await corpusMean(tx);
        const subsC = subs.map((s) => centerVec(s.v, mean));
        const vids = videoIds.length ? await loadVideos(Prisma.sql`id = ANY(${videoIds})`) : [];
        const already = new Set((await tx.videoNiche.findMany({ where: { videoId: { in: vids.map((v) => v.id) }, decision: "MANUAL" }, select: { videoId: true } })).map((r) => r.videoId));
        const rows: Prisma.VideoNicheCreateManyInput[] = [];
        const centroidAdds = new Map<string, Vec[]>();
        for (const v of vids) {
          if (already.has(v.id)) continue;
          const hit = nearest(centerVec(v.vec, mean), subsC);
          if (hit.index >= 0 && hit.cos >= TAXONOMY_CONFIG.reuseCentered) {
            const s = subs[hit.index]!;
            const raw = dot(v.vec, s.v);
            rows.push(vnRow(v.id, s.id, raw, "REUSE", run.id, `nearest category ${s.name} (centered cos ${hit.cos.toFixed(2)})`, { cosine: +raw.toFixed(4), centeredCosine: +hit.cos.toFixed(4) }));
            centroidAdds.set(s.id, [...(centroidAdds.get(s.id) ?? []), v.vec]);
            dirty.add(`subniche:${s.slug}`);
            touchedChannels.add(v.channelId);
            out.reused++;
          } else out.pooled++;
        }
        await tx.videoNiche.deleteMany({ where: { videoId: { in: vids.filter((v) => !already.has(v.id)).map((v) => v.id) }, decision: { not: "MANUAL" } } });
        if (rows.length) await tx.videoNiche.createMany({ data: rows, skipDuplicates: true });
        out.classified = rows.length;
        // Running-mean centroid drift (cross-owner aggregation: a shared centroid combines many owners' videos).
        if (policyAllows("cross-owner-aggregation")) {
          for (const [id, vs] of centroidAdds) {
            const s = subs.find((x) => x.id === id)!;
            const w = Math.max(1, s.centroidCount);
            const next = meanNormalized([s.v.map((x) => x * w), ...vs]);
            await tx.$executeRaw`UPDATE "Niche" SET centroid = ${`[${next.join(",")}]`}::vector, "embeddingModel" = ${embeddingModelId()}, "centroidCount" = "centroidCount" + ${vs.length} WHERE id = ${id}`;
          }
        }
        await grow(tx, subs, mean, run.id, out, dirty, touchedChannels);
      },
      { timeout: 120_000 },
    );
    if (touchedChannels.size) for (const d of (await projectChannels([...touchedChannels])).dirty) dirty.add(d);
    await recomputeTaxonomyCounts();
    if (dirty.size) await enqueue.graph([...dirty]);
    await db.taxonomyRun.update({ where: { id: run.id }, data: { status: "COMPLETED", finishedAt: new Date(), stats: out as unknown as Prisma.InputJsonValue } });
    return out;
  } catch (err) {
    await db.taxonomyRun.update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: String(err) } });
    throw err;
  }
}

type Tx = Prisma.TransactionClient;

/** Turns supported growth-pool groups into new categories (caller holds the advisory lock). */
async function grow(tx: Tx, subs: Awaited<ReturnType<typeof activeSubs>>, mean: Vec | null, runId: string, out: ClassifyResult, dirty: Set<string>, touched: Set<string>) {
  const pool = await loadVideos(Prisma.sql`NOT EXISTS (SELECT 1 FROM "VideoNiche" vn WHERE vn."videoId" = "Video".id)`, 3_000, tx);
  if (pool.length < TAXONOMY_CONFIG.minNewSubSupport) return;
  const poolC = pool.map((p) => centerVec(p.vec, mean));
  const groups = leaderClusters(poolC, TAXONOMY_CONFIG.poolCentered).filter((g) => g.length >= TAXONOMY_CONFIG.minNewSubSupport);
  if (!groups.length) return;
  const tops = await activeTops();
  const docs = await namingDocs(pool);
  const sample = await loadVideos(Prisma.sql`TRUE`, 5_000, tx);
  const { excluded, namesOnly, termChannels } = await namingContext(sample, await namingDocs(sample));
  const taken = new Set((await tx.niche.findMany({ select: { slug: true } })).map((n) => n.slug));
  const subVecsC = subs.map((s) => centerVec(s.v, mean));
  const topsC = tops.map((t) => centerVec(t.v, mean));
  for (const g of groups) {
    const members = g.map((i) => pool[i]!);
    // c (raw) is what gets stored as the centroid; cc (centered) is what decisions compare.
    const c = meanNormalized(members.map((m) => m.vec));
    const cc = meanNormalized(g.map((i) => poolC[i]!));
    const dup = nearest(cc, subVecsC);
    const groupDocs = [members.map((m) => docs.get(m.id)!), pool.filter((p) => !g.includes(pool.indexOf(p))).map((p) => docs.get(p.id)!)];
    let [terms] = clusterTerms(groupDocs, excluded, 6, termChannels);
    if (!terms?.length) [terms] = clusterTerms(groupDocs, namesOnly, 6, termChannels);
    const name = nameFromTerms(terms ?? [], `Emerging cluster`);
    const nameDup = subs.find((s) => trigramSimilarity(s.name.toLowerCase(), name.toLowerCase()) >= TAXONOMY_CONFIG.dupName);
    let target: { id: string; slug: string; decision: string; why: string };
    if (dup.index >= 0 && dup.cos >= TAXONOMY_CONFIG.dupCentered) {
      const s = subs[dup.index]!;
      target = { id: s.id, slug: s.slug, decision: "REUSE", why: `semantic duplicate of ${s.name} (centroid cos ${dup.cos.toFixed(2)})` };
    } else if (nameDup) {
      target = { id: nameDup.id, slug: nameDup.slug, decision: "REUSE", why: `name duplicate of ${nameDup.name}` };
    } else {
      const near = tops.length ? nearest(cc, topsC) : { index: -1, cos: -1 };
      let parent = near.index >= 0 && near.cos >= TAXONOMY_CONFIG.parentCentered ? tops[near.index]! : null;
      if (!parent && members.length < TAXONOMY_CONFIG.minNewTopSupport) continue; // no fitting niche, not enough support for one: stay pooled
      if (!parent) {
        const topName = nameFromTerms((terms ?? []).slice(0, 1), name);
        const slug = taken.has(slugify(topName.toLowerCase())) ? `${slugify(topName.toLowerCase())}-${taken.size}` : slugify(topName.toLowerCase());
        taken.add(slug);
        const row = await tx.niche.create({ data: { slug, name: topName, description: describe(members.length, {}), keywords: (terms ?? []).map((t) => t.term), discoveryQueries: [], depth: 0, origin: "DYNAMIC", status: "ACTIVE", createdByRunId: runId, centroidCount: members.length }, select: { id: true } });
        await tx.$executeRaw`UPDATE "Niche" SET centroid = ${`[${c.join(",")}]`}::vector, "embeddingModel" = ${embeddingModelId()} WHERE id = ${row.id}`;
        parent = { id: row.id, slug, name: topName, c: "", v: c };
        tops.push(parent);
        topsC.push(cc);
        out.createdNiches.push(slug);
        dirty.add(`niche:${slug}`);
      }
      if (!parent) continue;
      let slug = slugify(name.toLowerCase()) || "category";
      for (let i = 2; taken.has(slug); i++) slug = `${slugify(name.toLowerCase())}-${i}`;
      taken.add(slug);
      const row = await tx.niche.create({
        data: { slug, name, description: describe(members.length, {}), keywords: (terms ?? []).map((t) => t.term), discoveryQueries: [], depth: 1, parentId: parent.id, origin: "DYNAMIC", status: "ACTIVE", createdByRunId: runId, centroidCount: members.length },
        select: { id: true },
      });
      await tx.$executeRaw`UPDATE "Niche" SET centroid = ${`[${c.join(",")}]`}::vector, "embeddingModel" = ${embeddingModelId()} WHERE id = ${row.id}`;
      subs.push({ id: row.id, slug, name, parentId: parent.id, centroidCount: members.length, c: "", v: c });
      subVecsC.push(cc);
      out.createdSubniches.push(slug);
      dirty.add(`niche:${parent.slug}`);
      target = { id: row.id, slug, decision: "CREATE", why: `founding member of new category ${name}` };
    }
    await tx.videoNiche.createMany({
      data: members.map((m) => vnRow(m.id, target.id, dot(m.vec, c), target.decision, runId, target.why, { cosine: +dot(m.vec, c).toFixed(4), groupSize: members.length, terms: (terms ?? []).map((t) => t.term) })),
      skipDuplicates: true,
    });
    for (const m of members) touched.add(m.channelId);
    dirty.add(`subniche:${target.slug}`);
    out.classified += members.length;
    out.pooled -= Math.min(out.pooled, members.length);
  }
}

// ── Projection, counts, status ─────────────────────────────────────────────

/**
 * ChannelNiche = aggregate of a channel's video evidence: subniches holding ≥ channelShare of its classified
 * videos (≤ 3, best always kept). Channels with MANUAL assignments are left alone.
 */
export async function projectChannels(channelIds?: string[]): Promise<{ channels: number; dirty: string[] }> {
  const where = channelIds ? Prisma.sql`v."channelId" = ANY(${channelIds})` : Prisma.sql`TRUE`;
  const rows = await db.$queryRaw<{ channelId: string; nicheId: string; slug: string; n: number; total: number }[]>`
    WITH primary_label AS (
      SELECT DISTINCT ON (vn."videoId") vn."videoId", vn."nicheId" FROM "VideoNiche" vn
      JOIN "Niche" n ON n.id = vn."nicheId" AND n.status = 'ACTIVE' AND n.origin <> 'SEED'
      ORDER BY vn."videoId", (vn.decision = 'MANUAL') DESC, vn.confidence DESC
    )
    SELECT v."channelId", p."nicheId", n.slug, count(*)::int AS n,
      -- share of ALL the channel's videos: unclassified (pooled) videos must not inflate a channel's membership
      (SELECT count(*)::int FROM "Video" t WHERE t."channelId" = v."channelId" AND t."isAvailable" AND t.embedding IS NOT NULL) AS total
    FROM primary_label p JOIN "Video" v ON v.id = p."videoId" JOIN "Niche" n ON n.id = p."nicheId"
    WHERE ${where} GROUP BY v."channelId", p."nicheId", n.slug`;
  const byChannel = new Map<string, typeof rows>();
  for (const r of rows) byChannel.set(r.channelId, [...(byChannel.get(r.channelId) ?? []), r]);
  const manual = new Set((await db.channelNiche.findMany({ where: { method: "MANUAL", ...(channelIds ? { channelId: { in: channelIds } } : {}) }, select: { channelId: true } })).map((r) => r.channelId));
  const dirty = new Set<string>();
  const ids = channelIds ?? [...byChannel.keys()];
  const chans = await db.channel.findMany({ where: { id: { in: ids } }, select: { id: true, youtubeId: true, niches: { select: { niche: { select: { slug: true, depth: true } } } } } });
  let n = 0;
  for (const ch of chans) {
    if (manual.has(ch.id)) continue;
    const ranked = (byChannel.get(ch.id) ?? []).map((r) => ({ ...r, confidence: +(r.n / r.total).toFixed(4) }));
    const picks = ranked.sort((a, b) => b.confidence - a.confidence).filter((r, i) => i === 0 || r.confidence >= TAXONOMY_CONFIG.channelShare).slice(0, 3);
    for (const b of ch.niches) dirty.add(`subniche:${b.niche.slug}`);
    await db.$transaction([
      db.channelNiche.deleteMany({ where: { channelId: ch.id } }),
      db.channelNiche.createMany({ data: picks.map((p) => ({ channelId: ch.id, nicheId: p.nicheId, confidence: p.confidence, method: "EMBEDDING" as const, lowConfidence: p.confidence < 0.2, rationale: `${p.n} of ${p.total} videos (${Math.round(p.confidence * 100)}%)`, classifier: PROJECTION_CLASSIFIER, evidence: { origin: "atlas-inferred", classifier: PROJECTION_CLASSIFIER, videos: p.n, channelVideos: p.total, share: p.confidence, taxonomyVersion: TAXONOMY_CONFIG.version, embeddingModel: env.EMBEDDING_MODEL, classifiedAt: new Date().toISOString() } })) }),
    ]);
    for (const p of picks) dirty.add(`subniche:${p.slug}`);
    dirty.add(`channel:${ch.youtubeId}`);
    n++;
  }
  return { channels: n, dirty: [...dirty] };
}

/**
 * Drops the non-manual taxonomy labels of the given videos (so they can be reclassified) and prunes generated
 * categories left with no videos, no children and no manual channel assignment. Never touches SEED/MANUAL niches.
 */
export async function resetVideoLabels(videoIds: string[]): Promise<{ labelsRemoved: number; pruned: string[] }> {
  const removed = await db.videoNiche.deleteMany({ where: { videoId: { in: videoIds }, decision: { not: "MANUAL" } } });
  const pruned: string[] = [];
  for (const depth of [1, 0]) {
    const empty = await db.niche.findMany({ where: { origin: "DYNAMIC", depth, videos: { none: {} }, children: { none: {} }, channels: { none: { method: "MANUAL" } } }, select: { id: true, slug: true } });
    if (empty.length) await db.niche.deleteMany({ where: { id: { in: empty.map((n) => n.id) } } });
    pruned.push(...empty.map((n) => `${depth === 0 ? "niche" : "subniche"}:${n.slug}`));
  }
  return { labelsRemoved: removed.count, pruned };
}

export async function recomputeTaxonomyCounts() {
  await db.$executeRaw`
    UPDATE "Niche" n SET
      "channelCount" = COALESCE((SELECT count(DISTINCT cn."channelId")::int FROM "ChannelNiche" cn JOIN "Niche" s ON s.id = cn."nicheId" WHERE s.id = n.id OR s."parentId" = n.id), 0),
      "videoCount" = COALESCE((SELECT count(DISTINCT vn."videoId")::int FROM "VideoNiche" vn JOIN "Niche" s ON s.id = vn."nicheId" WHERE s.id = n.id OR s."parentId" = n.id), 0)`;
}

/** Videos that have an embedding but no taxonomy label yet (backfill / reconciliation input). */
export async function unclassifiedVideoIds(limit = 50_000): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Video" v WHERE embedding IS NOT NULL AND "isAvailable"
      AND NOT EXISTS (SELECT 1 FROM "VideoNiche" vn JOIN "Niche" n ON n.id = vn."nicheId" WHERE vn."videoId" = v.id AND n.origin <> 'SEED')
    ORDER BY id LIMIT ${limit}`;
  return rows.map((r) => r.id);
}

export async function taxonomyStatus() {
  const [byOrigin, videos, embedded, labelled, channels, projected, runs] = await Promise.all([
    db.niche.groupBy({ by: ["origin", "status", "depth"], _count: true }),
    db.video.count({ where: { isAvailable: true } }),
    db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Video" WHERE embedding IS NOT NULL`,
    db.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT vn."videoId")::int AS n FROM "VideoNiche" vn JOIN "Niche" n ON n.id = vn."nicheId" WHERE n.origin <> 'SEED' AND n.status = 'ACTIVE'`,
    db.channel.count(),
    db.$queryRaw<{ n: number }[]>`SELECT count(DISTINCT cn."channelId")::int AS n FROM "ChannelNiche" cn JOIN "Niche" n ON n.id = cn."nicheId" WHERE n.origin <> 'SEED'`,
    db.taxonomyRun.findMany({ orderBy: { startedAt: "desc" }, take: 5, select: { id: true, kind: true, status: true, startedAt: true, finishedAt: true, error: true } }),
  ]);
  return {
    mode: env.TAXONOMY_MODE,
    niches: byOrigin.map((g) => ({ origin: g.origin, status: g.status, depth: g.depth, count: g._count })),
    videos: { total: videos, embedded: embedded[0]!.n, classified: labelled[0]!.n },
    channels: { total: channels, projected: projected[0]!.n },
    recentRuns: runs,
  };
}

/** Evidence for one category: the videos that put it there and why. */
export async function nicheEvidence(nicheIdOrSlug: string, limit = 50) {
  const n = await db.niche.findFirst({ where: { OR: [{ id: nicheIdOrSlug }, { slug: nicheIdOrSlug.replace(/^(sub)?niche:/, "") }] }, select: { id: true, slug: true, name: true, origin: true, status: true, bootstrap: true, createdByRunId: true, createdAt: true, depth: true, children: { select: { id: true } } } });
  if (!n) return null;
  const ids = n.depth === 0 ? n.children.map((c) => c.id) : [n.id];
  const rows = await db.videoNiche.findMany({
    where: { nicheId: { in: ids } },
    orderBy: { confidence: "desc" },
    take: limit,
    select: { confidence: true, decision: true, rationale: true, evidence: true, model: true, promptVersion: true, taxonomyVersion: true, runId: true, video: { select: { youtubeId: true, title: true, channel: { select: { title: true, youtubeId: true } } } } },
  });
  return { niche: n, videos: rows.map((r) => ({ ...r, video: { ...r.video, nodeId: `video:${r.video.youtubeId}` } })) };
}

export { planSeedCleanup, executeSeedCleanup, SEED_MANIFEST, type SeedCleanupPlan } from "./cleanup";
