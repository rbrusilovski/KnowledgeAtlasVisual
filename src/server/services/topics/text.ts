/** Keyphrase candidate extraction & normalization (no AI). Pure functions — unit tested. */

export const STOPWORDS = new Set(
  `a about above after again against all almost also am an and any are aren't as at be because been before being below between both but by can can't cannot could did do does doing don't down during each even ever every few for from further get gets got had has have having he her here hers herself him himself his how i i'm if in into is isn't it it's its itself just let's like make made many me more most much must my myself no nor not now of off on once only or other our ours ourselves out over own really same she should so some such than that that's the their theirs them themselves then there these they this those through to too under until up us very was we were what when where which while who whom why will with without would you your yours yourself yourselves via vs versus per yet ok okay oh yeah hey hi so well way thing things lot lots`.split(/\s+/),
);

/** Generic YouTube/title boilerplate that never makes a good topic. */
export const BOILERPLATE = new Set(
  `video videos channel subscribe subscribed like comment comments share watch watching today episode ep part full new latest official live stream streaming link links description below chapter chapters intro outro wrap up wrap-up thanks thank viewer viewers question questions answered answer q a qa minute minutes second seconds hour hours day days week weeks month months year years time first last next one two three four five six seven eight nine ten trick tricks tip tips changed change everything everyone nobody tells tell harder hard think actually work works working complete walkthrough beginner beginners beginner's guide mistake mistakes make makes tried try trying happened happen history surprising testing test tests myth myths deep dive setup honest look slow worth still finally connected building build scratch zero explained explain explaining pick better best worst quick fix need needs know want go going come coming see seen show shows shorts short vlog update updates review reviews reaction react series season shown said says say will got gonna wanna let lets start started starting end ending real really big small good great bad simple simply easy hard way ways part case thing stuff remember only stick most point put together compare difference example examples note notice step steps interesting genuinely directly specifically comments watched adjust immediately different properly key idea concrete surprised result results patience reward fundamental fundamentals people give back viewer asked`.split(/\s+/),
);

const KEEP_S = new Set(["series", "species", "news", "physics", "mathematics", "economics", "analytics", "gymnastics", "kubernetes", "devops", "aws", "ios", "windows", "data", "always", "chaos", "bias", "lens", "gas", "dynamics", "electronics", "robotics", "logistics", "genetics", "statistics", "ethics", "esports", "jeans", "glasses", "basics", "graphics", "mechanics", "politics", "linux", "atlas", "plus", "status", "virus", "focus", "campus", "corpus", "nexus", "thesis", "analysis", "basis", "crisis", "axis"]);

export function singularize(w: string): string {
  if (w.length <= 3 || KEEP_S.has(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

const TOKEN = /[a-z0-9][a-z0-9+#]*(?:[-'][a-z0-9]+)*/g;

export function tokenize(segment: string): string[] {
  return (segment.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(TOKEN) ?? []).map((t) => t.replace(/'s$/, ""));
}

export function normalizePhrase(p: string): string {
  return tokenize(p).map(singularize).join(" ").trim();
}

const isStop = (w: string) => STOPWORDS.has(w) || BOILERPLATE.has(w) || /^\d+$/.test(w) || w.length < 2;

/** 1–3-grams within punctuation-delimited segments; no stopword at either edge. */
export function ngrams(text: string, maxN = 3): string[] {
  const out: string[] = [];
  for (const seg of text.split(/[.,;:!?()[\]{}"“”|/\\\n\r\t–—•]+|\s-\s/)) {
    const toks = tokenize(seg).map(singularize);
    for (let i = 0; i < toks.length; i++) {
      for (let n = 1; n <= maxN && i + n <= toks.length; n++) {
        const gram = toks.slice(i, i + n);
        if (isStop(gram[0]!) || isStop(gram[gram.length - 1]!)) continue;
        if (n === 1 && gram[0]!.length < 3) continue;
        out.push(gram.join(" "));
      }
    }
  }
  return out;
}

export interface CandidateInput {
  title: string;
  tags: string[];
  description: string;
  transcript?: string[];
}

/** Weighted term frequencies per candidate phrase for one document. */
export function candidateFrequencies(doc: CandidateInput): Map<string, number> {
  const tf = new Map<string, number>();
  const add = (p: string, w: number) => tf.set(p, (tf.get(p) ?? 0) + w);
  for (const g of ngrams(doc.title)) add(g, 3);
  for (const tag of doc.tags) {
    const p = normalizePhrase(tag);
    const words = p.split(" ");
    if (p && words.length <= 4 && !words.every(isStop)) add(p, 2.5);
  }
  // Drop chapter timestamps, URLs and the fixture/demo disclaimer from descriptions.
  const desc = doc.description
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s.*$/gm, " ")
    .replace(/\(fictional demo content[^)]*\)/gi, " ");
  for (const g of ngrams(desc.slice(0, 3000))) add(g, 1);
  for (const chunk of (doc.transcript ?? []).slice(0, 8)) for (const g of ngrams(chunk)) add(g, 0.4);
  return tf;
}

export interface Scored {
  phrase: string;
  score: number;
}

/** Phrases in more than this share of documents are corpus boilerplate (sklearn-style max_df). */
export const MAX_DF_RATIO = 0.08;
/** max_df only applies once the corpus is big enough for document frequencies to mean something. */
export const MAX_DF_MIN_DOCS = 200;

/** TF-IDF with n-gram length bonus; drops corpus-boilerplate phrases; prunes unigrams subsumed by a strong containing phrase. */
export function topPhrases(tf: Map<string, number>, df: (p: string) => number, nDocs: number, k = 8): Scored[] {
  const scored: Scored[] = [];
  for (const [phrase, f] of tf) {
    if (nDocs >= MAX_DF_MIN_DOCS && df(phrase) / nDocs > MAX_DF_RATIO) continue;
    const n = phrase.split(" ").length;
    const idf = Math.log((nDocs + 1) / (df(phrase) + 1)) + 1;
    const bonus = n === 1 ? 1 : n === 2 ? 1.35 : 1.5;
    scored.push({ phrase, score: Math.log1p(f) * idf * bonus });
  }
  scored.sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
  const kept: Scored[] = [];
  for (const s of scored) {
    if (kept.length >= k) break;
    const words = s.phrase.split(" ");
    const subsumedBy = kept.find((x) => x.phrase !== s.phrase && (` ${x.phrase} `.includes(` ${s.phrase} `) || (words.length > 1 && ` ${s.phrase} `.includes(` ${x.phrase} `) && x.score >= s.score * 1.4)));
    if (subsumedBy && subsumedBy.score >= s.score * 0.7) continue;
    kept.push(s);
  }
  return kept;
}

/** Character-trigram similarity (same definition as pg_trgm) for in-memory checks. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const set = new Set<string>();
    for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const p = `  ${w} `;
      for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
    }
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

export const slugify = (label: string) =>
  label.replace(/\+/g, "plus").replace(/#/g, "sharp").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "topic";
