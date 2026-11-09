/**
 * Pure, deterministic taxonomy math (no DB): spherical k-means, agglomerative merging, support enforcement,
 * leader clustering for the growth pool, and c-TF-IDF naming. Vectors are assumed L2-normalized.
 */
import { ngrams, normalizePhrase, STOPWORDS, BOILERPLATE, trigramSimilarity } from "@/server/services/topics";

export type Vec = number[];

export function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function meanNormalized(vs: Vec[]): Vec {
  const d = vs[0]?.length ?? 0;
  const m = new Array<number>(d).fill(0);
  for (const v of vs) for (let i = 0; i < d; i++) m[i]! += v[i]!;
  const n = Math.hypot(...m) || 1;
  return m.map((x) => x / n);
}

/** Deterministic PRNG (mulberry32) so the same corpus yields the same taxonomy. */
export function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spherical k-means with k-means++ seeding. Returns assignment per point and centroids. */
export function kmeans(points: Vec[], k: number, opts: { seed?: number; iterations?: number } = {}): { assign: number[]; centroids: Vec[] } {
  const n = points.length;
  k = Math.max(1, Math.min(k, n));
  const rand = rng(opts.seed ?? 42);
  const centroids: Vec[] = [points[Math.floor(rand() * n)]!];
  const dist = new Array<number>(n).fill(Infinity);
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1]!;
    let total = 0;
    for (let i = 0; i < n; i++) {
      dist[i] = Math.min(dist[i]!, Math.max(0, 1 - dot(points[i]!, last)));
      total += dist[i]! ** 2;
    }
    if (total === 0) break;
    let r = rand() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      r -= dist[i]! ** 2;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(points[pick]!);
  }
  const assign = new Array<number>(n).fill(0);
  for (let it = 0; it < (opts.iterations ?? 30); it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const best = nearest(points[i]!, centroids).index;
      if (best !== assign[i]) moved++;
      assign[i] = best;
    }
    for (let c = 0; c < centroids.length; c++) {
      const members = points.filter((_, i) => assign[i] === c);
      if (members.length) centroids[c] = meanNormalized(members);
    }
    if (it > 0 && moved === 0) break;
  }
  return { assign, centroids };
}

export function nearest(v: Vec, centroids: Vec[], exclude = -1): { index: number; cos: number } {
  let index = -1;
  let cos = -Infinity;
  for (let c = 0; c < centroids.length; c++) {
    if (c === exclude) continue;
    const s = dot(v, centroids[c]!);
    if (s > cos) [index, cos] = [c, s];
  }
  return { index, cos };
}

/**
 * Relabels clusters so every surviving cluster has ≥ minSupport members (small ones are dissolved into their
 * members' next-nearest surviving cluster) and clusters whose centroids are near-duplicates (≥ dupCos) merge.
 * Returns compact cluster ids 0..m-1.
 */
export function enforceSupport(points: Vec[], assign: number[], minSupport: number, dupCos: number): { assign: number[]; centroids: Vec[] } {
  let a = [...assign];
  for (let guard = 0; guard < 100; guard++) {
    const ids = [...new Set(a)];
    const cents = new Map(ids.map((id) => [id, meanNormalized(points.filter((_, i) => a[i] === id))]));
    const sizes = new Map(ids.map((id) => [id, a.filter((x) => x === id).length]));
    // 1. merge the most similar duplicate pair
    let pair: [number, number] | null = null;
    let bestCos = dupCos;
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const s = dot(cents.get(ids[i]!)!, cents.get(ids[j]!)!);
        if (s >= bestCos) [bestCos, pair] = [s, [ids[i]!, ids[j]!]];
      }
    if (pair) {
      a = a.map((x) => (x === pair![1] ? pair![0] : x));
      continue;
    }
    // 2. dissolve the smallest under-supported cluster
    const small = ids.filter((id) => sizes.get(id)! < minSupport).sort((x, y) => sizes.get(x)! - sizes.get(y)!)[0];
    if (small === undefined || ids.length === 1) break;
    const others = ids.filter((id) => id !== small);
    const oc = others.map((id) => cents.get(id)!);
    a = a.map((x, i) => (x === small ? others[nearest(points[i]!, oc).index]! : x));
  }
  const ids = [...new Set(a)].sort((x, y) => x - y);
  const remap = new Map(ids.map((id, i) => [id, i]));
  const out = a.map((x) => remap.get(x)!);
  return { assign: out, centroids: ids.map((_, c) => meanNormalized(points.filter((__, i) => out[i] === c))) };
}

/**
 * Average-linkage agglomeration of cluster centroids into `target` groups (stops early when the best pair is
 * below `minCos`). Weighted by member counts. Returns group index per input centroid.
 */
export function agglomerate(centroids: Vec[], weights: number[], target: number, minCos = -1): number[] {
  type G = { members: number[]; c: Vec; w: number };
  let groups: G[] = centroids.map((c, i) => ({ members: [i], c, w: weights[i] ?? 1 }));
  while (groups.length > Math.max(1, target)) {
    // Ward-style cost on the sphere: (wi·wj / (wi+wj)) · (1 − cos). Balances sizes; avoids average-link chaining.
    let bi = -1;
    let bj = -1;
    let bestCost = Infinity;
    let bestCos = -Infinity;
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const s = dot(groups[i]!.c, groups[j]!.c);
        const cost = ((groups[i]!.w * groups[j]!.w) / (groups[i]!.w + groups[j]!.w)) * (1 - s);
        if (cost < bestCost) [bestCost, bestCos, bi, bj] = [cost, s, i, j];
      }
    if (bestCos < minCos) break;
    const gi = groups[bi]!;
    const gj = groups[bj]!;
    const w = gi.w + gj.w;
    const c = gi.c.map((x, k) => x * gi.w + gj.c[k]! * gj.w);
    const n = Math.hypot(...c) || 1;
    groups = groups.filter((_, k) => k !== bi && k !== bj).concat({ members: [...gi.members, ...gj.members], c: c.map((x) => x / n), w });
  }
  const out = new Array<number>(centroids.length).fill(0);
  groups.forEach((g, gi) => g.members.forEach((m) => (out[m] = gi)));
  return out;
}

/** Greedy leader clustering for the unassigned growth pool: a point joins the first group whose centroid ≥ cos. */
export function leaderClusters(points: Vec[], minCos: number): number[][] {
  const groups: { idx: number[]; c: Vec }[] = [];
  points.forEach((p, i) => {
    const hit = groups.find((g) => dot(g.c, p) >= minCos);
    if (hit) {
      hit.idx.push(i);
      hit.c = meanNormalized(hit.idx.map((k) => points[k]!));
    } else groups.push({ idx: [i], c: p });
  });
  return groups.map((g) => g.idx).sort((a, b) => b.length - a.length);
}

// ── Naming (c-TF-IDF) ───────────────────────────────────────────────────────

export interface NamingDoc {
  title: string;
  tags: string[];
  topics: string[];
}

const GENERIC = new Set(["video", "videos", "episode", "part", "official", "full", "explained", "introduction", "intro", "lecture", "live", "stream", "shorts", "short", "new", "best", "top", "vs", "ft", "feat", "update", "q&a", "faq", "channel", "trailer", "teaser", "review", "reaction", "special", "bonus", "podcast", "chapter", "lesson", "tutorial", "pt", "ep", "vol", "ch"]);
/** Credits and calls to action describe who/where, not what. */
const CREDIT = /\b(university|institute|laboratory|college|patreon|sponsor|subscribe|merch|discord|twitter|instagram|tiktok|support|available|thank|credit|edit(ing|ed)?|animat(ion|ed)|music by|research)\b/;

/** Terms of one document → weight (curated tags/topics 1.5, title n-grams 1). */
export function docTerms(d: NamingDoc, excluded: Set<string>): Map<string, number> {
  const out = new Map<string, number>();
  const add = (p: string, w = 1) => {
    const t = normalizePhrase(p);
    if (!t || t.length < 3 || excluded.has(t)) return;
    const words = t.split(" ");
    if (words.every((w) => STOPWORDS.has(w) || BOILERPLATE.has(w) || GENERIC.has(w) || /^\d+$/.test(w))) return;
    if (GENERIC.has(words[0]!) || GENERIC.has(words[words.length - 1]!)) return;
    if (CREDIT.test(t)) return;
    out.set(t, Math.max(out.get(t) ?? 0, w));
  };
  for (const g of ngrams(d.title, 2)) add(g);
  for (const t of d.tags.slice(0, 15)) if (t.split(/\s+/).length <= 3) add(t, 1.5);
  for (const t of d.topics) add(t, 1.5);
  return out;
}

/**
 * Class-based TF-IDF: per cluster, terms frequent inside it and rare across clusters. Requires a term to appear in
 * ≥ max(2, 8%) of a cluster's documents so a single video cannot name a category.
 */
export interface TermOptions {
  /** channels using each term (multi-channel terms describe subjects; single-channel ones are often credits) */
  termChannels?: Map<string, number>;
  /** corpus document frequency ratio per term; terms above `broadAbove` are down-weighted (for subniche names) */
  corpusRatio?: Map<string, number>;
  broadAbove?: number;
}

export function clusterTerms(clusters: NamingDoc[][], excluded: Set<string>, k = 6, opts: TermOptions | Map<string, number> = {}): { term: string; score: number; support: number }[][] {
  const o: TermOptions = opts instanceof Map ? { termChannels: opts } : opts;
  const termChannels = o.termChannels;
  const perCluster = clusters.map((docs) => {
    const tf = new Map<string, { n: number; w: number }>();
    for (const d of docs) for (const [t, w] of docTerms(d, excluded)) {
      const cur = tf.get(t) ?? { n: 0, w: 0 };
      tf.set(t, { n: cur.n + 1, w: cur.w + w });
    }
    return tf;
  });
  // BERTopic-style class IDF: log(1 + mean cluster size / documents containing the term across all clusters).
  const df = new Map<string, number>();
  for (const tf of perCluster) for (const [t, c] of tf) df.set(t, (df.get(t) ?? 0) + c.n);
  const meanN = clusters.reduce((s, c) => s + c.length, 0) / (clusters.length || 1);
  return perCluster.map((tf, ci) => {
    const n = clusters[ci]!.length || 1;
    const minSupport = Math.max(2, Math.ceil(n * 0.08));
    const scored = [...tf]
      .filter(([, c]) => c.n >= Math.min(minSupport, n))
      .map(([term, c]) => ({ term, support: c.n, score: (c.w / n) * Math.log(1 + meanN / df.get(term)!) * (term.includes(" ") ? 1.25 : 1) * channelFactor(termChannels?.get(term)) * (o.broadAbove !== undefined && (o.corpusRatio?.get(term) ?? 0) > o.broadAbove ? 0.25 : 1) }))
      .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
    // drop terms subsumed by a better-scoring term ("neural" when "neural network" ranks higher)
    const picked: typeof scored = [];
    for (const s of scored) {
      const i = picked.findIndex((p) => p.term.includes(s.term) || s.term.includes(p.term) || trigramSimilarity(p.term, s.term) >= 0.6);
      if (i >= 0) {
        // prefer the fuller phrase ("black hole" over "hole") when it is nearly as well supported
        const p = picked[i]!;
        if (s.term.includes(p.term) && s.term.length > p.term.length && s.support >= p.support * 0.6) picked[i] = { ...s, score: p.score };
        continue;
      }
      picked.push(s);
      if (picked.length >= k) break;
    }
    return picked;
  });
}

/**
 * Channel boilerplate: terms a single channel repeats on most of its uploads (its name, sponsor/Patreon lines,
 * the same tag list) say who made a video, not what it is about. A term is boilerplate when ≥ 20% of one (multiword: ≥ 4%)
 * channel's documents carry it and that channel accounts for ≥ 90% of the term's uses.
 */
export function channelBoilerplate(docsByChannel: Map<string, NamingDoc[]>, excluded = new Set<string>()): Set<string> {
  return termChannelStats(docsByChannel, excluded).boilerplate;
}

/** Boilerplate set + number of channels using each term (multi-channel terms make better category names). */
export function termChannelStats(docsByChannel: Map<string, NamingDoc[]>, excluded = new Set<string>()): { boilerplate: Set<string>; channels: Map<string, number> } {
  const total = new Map<string, number>();
  const per = new Map<string, Map<string, number>>();
  for (const [ch, docs] of docsByChannel) {
    const m = new Map<string, number>();
    for (const d of docs) for (const t of docTerms(d, excluded).keys()) m.set(t, (m.get(t) ?? 0) + 1);
    per.set(ch, m);
    for (const [t, n] of m) total.set(t, (total.get(t) ?? 0) + n);
  }
  const out = new Set<string>();
  const channels = new Map<string, number>();
  for (const [ch, m] of per) {
    const n = docsByChannel.get(ch)!.length;
    for (const [t, c] of m) {
      if (c >= 2) channels.set(t, (channels.get(t) ?? 0) + 1);
      if (n >= 5 && c >= 3 && c / n >= 0.04 && c / total.get(t)! >= 0.9 && t.includes(" ")) out.add(t); // multiword names/credits
      else if (n >= 5 && c / n >= 0.2 && c / total.get(t)! >= 0.9) out.add(t);
    }
  }
  return { boilerplate: out, channels };
}

/** Terms only one channel uses are often names/credits; terms several channels use describe subject matter. */
const channelFactor = (n: number | undefined) => (n === undefined ? 1 : n <= 1 ? 0.45 : 1 + 0.25 * Math.log2(n));

/** Corpus document-frequency ratio per term (for the broad-term penalty). */
export function corpusRatios(docs: NamingDoc[], excluded: Set<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of docs) for (const t of docTerms(d, excluded).keys()) m.set(t, (m.get(t) ?? 0) + 1);
  for (const [t, n] of m) m.set(t, n / (docs.length || 1));
  return m;
}

export const titleCase = (s: string) =>
  s
    .split(" ")
    .map((w) => (w.length <= 3 && /^(ai|ml|gpt|llm|cpu|gpu|dna|rna|nasa|usa|uk|eu|3d|2d|api|sql)$/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");

/** "Prime Numbers & Number Theory" from the top 1-2 distinct terms; fallback when there are none. */
export function nameFromTerms(terms: { term: string }[], fallback: string): string {
  const first = terms[0];
  if (!first) return fallback;
  const w = new Set(first.term.split(" "));
  // second term must add information (no shared words: not "Prime Number & Number Theory")
  const second = terms.slice(1, 4).find((x) => !x.term.split(" ").some((y) => w.has(y)));
  const t = [first, ...(second ? [second] : [])].map((x) => titleCase(x.term));
  return t.length ? t.join(" & ") : fallback;
}
