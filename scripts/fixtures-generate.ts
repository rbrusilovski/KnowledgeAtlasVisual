/**
 * Generates the clearly-fictional demo dataset in fixtures/youtube/ (seeded, deterministic).
 * Output is API-shaped JSON so the real ingestion pipeline runs unchanged in fixture mode.
 *
 *   pnpm fixtures:generate [--seed 1337] [--channels 60]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TAXONOMY, type NicheSeed, type SubnicheSeed } from "../src/server/taxonomy";

const args = process.argv.slice(2);
const arg = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const SEED = arg("seed", 1337);
const CHANNEL_COUNT = arg("channels", 60);
/** Fixed "generation date": videos after this are scheduled and appear as real time passes. */
const BASE = Date.parse("2026-11-08T00:00:00Z");
const DAY = 86_400_000;
const OUT = path.join(process.cwd(), "fixtures", "youtube");

// ── Seeded RNG ────────────────────────────────────────────────────────────
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
function sample<T>(xs: readonly T[], n: number): T[] {
  const copy = [...xs];
  const out: T[] = [];
  while (copy.length && out.length < n) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]!);
  return out;
}
function logNormal(median: number, sigma: number) {
  const u = Math.max(1e-9, rand());
  const v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(sigma * z);
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const rid = (n: number) => Array.from({ length: n }, () => B64[Math.floor(rand() * 64)]).join("");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

// ── Name parts (generic, fictional) ───────────────────────────────────────
const PREFIXES = ["Quiet", "Copperleaf", "Northbeam", "Lumen", "Fernway", "Halcyon", "Brightwater", "Ember", "Saltmarsh", "Kestrel", "Juniper", "Tidewell", "Granite", "Velvet", "Hollow Oak", "Marrow", "Pale Moon", "Sundial", "Wrenfield", "Ironbark", "Glasshouse", "Larkspur", "Driftwood", "Orbit", "Paper Crane", "Bluefern", "Cinder", "Meadowlark", "Slate", "Waypoint"];
const SUFFIX: Record<string, string[]> = {
  technology: ["Lab", "Labs", "Dev", "Systems", "Bytes", "Academy", "Workbench"],
  "science-education": ["Explained", "Lectures", "Academy", "Studio", "Notebook", "Institute"],
  "finance-business": ["Money", "Capital", "Ledger", "Finance", "Notes", "Brief"],
  gaming: ["Plays", "Gaming", "Arcade", "Quest", "Controller", "Save Point"],
  "health-fitness": ["Fitness", "Training", "Movement", "Strong", "Coach", "Method"],
  food: ["Kitchen", "Table", "Bakery", "Pantry", "Cooks", "Bites"],
  creative: ["Studio", "Atelier", "Sessions", "Works", "Frames", "Sketchbook"],
  lifestyle: ["Living", "Journal", "Notes", "Wanderer", "Days", "Edit"],
  "diy-trades": ["Workshop", "Garage", "Builds", "Shop", "Homestead", "Fixes"],
  entertainment: ["Show", "Takes", "Theatre", "Hour", "Talks", "Reel"],
  sports: ["Sports", "Tactics", "Breakdown", "Arena", "Outdoors", "Corner"],
};

const TITLE_TEMPLATES = [
  "How {kw} actually works",
  "{Kw} explained in {n} minutes",
  "I tried {kw} for {d} days — here's what happened",
  "The beginner's guide to {kw}",
  "{n} {kw} mistakes everyone makes",
  "Why {kw} is harder than you think",
  "{Kw} vs {kw2}: which one should you pick?",
  "Building a {kw} project from scratch",
  "The surprising history of {kw}",
  "{Kw} deep dive (part {p})",
  "What nobody tells you about {kw}",
  "Testing {kw} myths so you don't have to",
  "{Kw}: a complete walkthrough",
  "My {kw} setup in {y}",
  "{Kw} Q&A — your questions answered",
  "The one {kw} trick that changed everything",
  "{Kw} and {kw2}, finally connected",
  "A slow, honest look at {kw}",
  "Is {kw} still worth it in {y}?",
  "From zero to {kw}: week {p}",
];
const SHORT_TEMPLATES = ["{Kw} in 60 seconds", "One {kw} tip you need", "Quick {kw} fix", "{Kw}? Watch this first"];

const SENTENCES = [
  "So today we're looking at {kw}, and specifically how it connects to {kw2}.",
  "The first thing to understand about {kw} is that it's not as simple as it looks.",
  "If you watched the last video on {kw2}, this builds directly on that.",
  "A lot of people get {kw} wrong because they skip the fundamentals.",
  "Let's start with a quick example so this stays concrete.",
  "Here's where {kw} gets genuinely interesting.",
  "Notice how the {kw2} changes once we adjust the setup.",
  "That's really the key idea: {kw} rewards patience.",
  "Before we go further, a quick note on {kw3}.",
  "I tested this three different ways and the results surprised me.",
  "Most guides on {kw} stop here, but there's one more step.",
  "You can see the difference immediately when you compare it with {kw3}.",
  "Okay, let's put all of that together.",
  "If you only remember one thing about {kw}, make it this.",
  "This is the part where most people give up, so stick with me.",
  "A viewer asked about {kw2} last week, so let's answer that properly.",
  "We'll come back to {kw3} in a later episode.",
  "Thanks for watching, and tell me in the comments how {kw} works for you.",
];

const COUNTRIES = ["US", "GB", "CA", "AU", "DE", "NL", "SE", "IN", "NZ", "IE"];

// ── Build channel plan ────────────────────────────────────────────────────
interface Plan {
  id: string;
  niche: NicheSeed;
  sub: SubnicheSeed;
  secondary?: { niche: NicheSeed; sub: SubnicheSeed };
  title: string;
  handle: string;
  username?: string;
}

const subs = TAXONOMY.flatMap((n) => n.children.map((s) => ({ niche: n, sub: s })));
const assignments = [...subs];
while (assignments.length < CHANNEL_COUNT) assignments.push(pick(subs));
assignments.length = CHANNEL_COUNT;

const usedTitles = new Set<string>();
const usedHandles = new Set<string>();
const plans: Plan[] = assignments.map(({ niche, sub }) => {
  const roots = sub.keywords.filter((k) => !k.includes(" ") && k.length > 3 && k.length < 13);
  let title = "";
  for (let i = 0; i < 50 && (!title || usedTitles.has(title)); i++) {
    const root = titleCase(pick(roots.length ? roots : sub.keywords));
    const style = int(0, 2);
    title =
      style === 0
        ? `${pick(PREFIXES)} ${pick(SUFFIX[niche.slug]!)}`
        : style === 1
          ? `${pick(PREFIXES)} ${root}`
          : `${root} ${pick(SUFFIX[niche.slug]!)}`;
  }
  usedTitles.add(title);
  let handle = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  while (usedHandles.has(handle)) handle = `${handle.slice(0, 22)}${int(10, 99)}`;
  usedHandles.add(handle);
  const secondary = chance(0.25)
    ? (() => {
        const other = pick(subs.filter((s) => s.sub.slug !== sub.slug));
        return { niche: other.niche, sub: other.sub };
      })()
    : undefined;
  return {
    id: `UC${rid(22)}`,
    niche,
    sub,
    secondary,
    title,
    handle,
    username: chance(0.2) ? `${handle.slice(0, 16)}${int(1, 9)}` : undefined,
  };
});

// ── Generate ──────────────────────────────────────────────────────────────
function vocab(p: Plan) {
  const primary = [...p.sub.keywords];
  const secondary = p.secondary ? p.secondary.sub.keywords : [];
  return () => (secondary.length && chance(0.25) ? pick(secondary) : chance(0.12) ? pick(p.niche.keywords) : pick(primary));
}

function fill(t: string, kw: () => string) {
  const k1 = kw();
  let k2 = kw();
  if (k2 === k1) k2 = kw();
  const k3 = kw();
  return t
    .replaceAll("{Kw}", cap(k1))
    .replaceAll("{kw}", k1)
    .replaceAll("{kw2}", k2)
    .replaceAll("{kw3}", k3)
    .replaceAll("{n}", String(int(3, 12)))
    .replaceAll("{d}", String(pick([7, 14, 30, 60, 100])))
    .replaceAll("{p}", String(int(1, 6)))
    .replaceAll("{y}", String(pick([2025, 2026])));
}

function iso(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

function vttTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function transcript(kw: () => string, durationSec: number) {
  const cues: string[] = ["WEBVTT", "Kind: captions", "Language: en", ""];
  let t = 0.5;
  const end = Math.min(durationSec, int(240, 600));
  let i = 1;
  while (t < end) {
    const len = 3 + rand() * 4;
    cues.push(String(i++), `${vttTime(t)} --> ${vttTime(Math.min(end, t + len))}`, fill(pick(SENTENCES), kw), "");
    t += len + rand() * 0.4;
  }
  return cues.join("\n");
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, "channels"), { recursive: true });

let totalVideos = 0;
let totalTranscripts = 0;
const index: { id: string; handle: string; title: string; subniche: string; username?: string; videos: number }[] = [];

for (const p of plans) {
  const kw = vocab(p);
  const subscribers = Math.round(Math.min(9_000_000, Math.max(800, logNormal(90_000, 1.4))));
  const createdAt = BASE - int(3 * 365, 14 * 365) * DAY;
  const nVideos = int(20, 60);
  const cadenceDays = int(3, 21);
  const videos: unknown[] = [];
  const transcripts: Record<string, string> = {};
  let totalViews = 0;
  // A couple of scheduled (future) uploads per channel so incremental sync has something to find later.
  let cursor = BASE + int(1, 2) * cadenceDays * DAY;
  for (let i = 0; i < nVideos; i++) {
    const id = rid(11);
    const isShort = chance(0.15);
    const duration = isShort ? int(15, 59) : Math.round(Math.min(3 * 3600, Math.max(180, logNormal(14 * 60, 0.7))));
    const title = fill(isShort ? pick(SHORT_TEMPLATES) : pick(TITLE_TEMPLATES), kw).slice(0, 100);
    const tags = [...new Set([...sample(p.sub.keywords, int(3, 7)), ...sample(p.niche.keywords, int(1, 3)), ...(p.secondary && chance(0.4) ? sample(p.secondary.sub.keywords, 2) : [])])];
    const ageFactor = Math.max(0.05, Math.min(1, (BASE - cursor) / (365 * DAY)));
    const views = Math.max(0, Math.round(subscribers * (0.05 + rand() * 0.6) * (0.3 + ageFactor) * (isShort ? 1.6 : 1)));
    totalViews += views;
    const chapters = isShort
      ? ""
      : `\n\nChapters:\n00:00 Intro\n${vttTime(int(30, 90)).slice(3, 8)} ${cap(kw())}\n${vttTime(int(120, 300)).slice(3, 8)} ${cap(kw())}\n${vttTime(int(330, Math.max(331, duration - 30))).slice(3, 8)} Wrap-up`;
    const description = `${fill(pick(SENTENCES), kw)} ${fill(pick(SENTENCES), kw)} In this video: ${tags.slice(0, 4).join(", ")}.${chapters}\n\n(Fictional demo content generated for Atlas — not a real creator.)`;
    const publishedAt = new Date(cursor - int(0, 20) * 3_600_000).toISOString();
    videos.push({
      kind: "youtube#video",
      etag: `fx-${rid(10)}`,
      id,
      snippet: {
        publishedAt,
        channelId: p.id,
        title,
        description,
        thumbnails: { medium: { url: `/api/placeholder/thumb/${id}` }, high: { url: `/api/placeholder/thumb/${id}` } },
        channelTitle: p.title,
        tags,
        categoryId: pick(["22", "24", "26", "27", "28", "20", "17"]),
        defaultLanguage: "en",
      },
      contentDetails: { duration: iso(duration), caption: "false" },
      statistics: {
        viewCount: String(views),
        likeCount: String(Math.round(views * (0.015 + rand() * 0.04))),
        commentCount: String(Math.round(views * (0.0008 + rand() * 0.004))),
      },
    });
    if (!isShort && chance(0.3)) {
      transcripts[id] = transcript(kw, duration);
      totalTranscripts++;
    }
    cursor -= cadenceDays * DAY * (0.5 + rand());
    if (cursor < createdAt) cursor = createdAt + int(1, 30) * DAY;
  }
  totalVideos += videos.length;

  // Featured channels: mostly same subniche/niche, sometimes cross-niche.
  const sameSub = plans.filter((o) => o !== p && o.sub.slug === p.sub.slug);
  const sameNiche = plans.filter((o) => o !== p && o.niche.slug === p.niche.slug && o.sub.slug !== p.sub.slug);
  const featured = [...sample(sameSub, int(0, 2)), ...sample(sameNiche, int(0, 2)), ...(chance(0.15) ? sample(plans.filter((o) => o.niche !== p.niche), 1) : [])].map((o) => o.id);

  const keywords = [...sample(p.sub.keywords, int(5, 9)), ...sample(p.niche.keywords, 2)].map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" ");
  const channel = {
    kind: "youtube#channel",
    etag: `fx-${rid(10)}`,
    id: p.id,
    snippet: {
      title: p.title,
      description: `${p.title} is a fictional demo channel about ${p.sub.name.toLowerCase()}. ${p.sub.description} ${p.secondary ? `We also cover ${p.secondary.sub.name.toLowerCase()} from time to time. ` : ""}New videos every ${cadenceDays} days.\n\n(Generated for the Atlas demo dataset — not a real creator.)`,
      customUrl: `@${p.handle}`,
      publishedAt: new Date(createdAt).toISOString(),
      country: pick(COUNTRIES),
      thumbnails: {
        default: { url: `/api/placeholder/avatar/${p.id}` },
        medium: { url: `/api/placeholder/avatar/${p.id}` },
        high: { url: `/api/placeholder/avatar/${p.id}` },
      },
    },
    statistics: {
      viewCount: String(totalViews),
      subscriberCount: String(subscribers),
      hiddenSubscriberCount: chance(0.04),
      videoCount: String(videos.length),
    },
    contentDetails: { relatedPlaylists: { uploads: `UU${p.id.slice(2)}` } },
    brandingSettings: { channel: { keywords } },
    topicDetails: { topicCategories: sample([...p.niche.topicCategories, ...(p.secondary?.niche.topicCategories ?? [])], int(1, 2)) },
  };
  const sections = featured.length
    ? [{ kind: "youtube#channelSection", snippet: { type: "multipleChannels", title: "Friends of the channel" }, contentDetails: { channels: featured } }]
    : [];

  writeFileSync(path.join(OUT, "channels", `${p.id}.json`), JSON.stringify({ channel, username: p.username, sections, videos, transcripts }));
  index.push({ id: p.id, handle: p.handle, title: p.title, subniche: p.sub.slug, username: p.username, videos: videos.length });
}

writeFileSync(
  path.join(OUT, "index.json"),
  JSON.stringify({ note: "Fictional demo dataset for Atlas. Not real creators.", seed: SEED, generatedFor: new Date(BASE).toISOString(), channels: index }, null, 2),
);
console.log(`Generated ${plans.length} fictional channels, ${totalVideos} videos, ${totalTranscripts} transcripts → ${path.relative(process.cwd(), OUT)}`);
