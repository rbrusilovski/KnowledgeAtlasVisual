import "dotenv/config";
const { db } = await import("@/server/db");
const { weightedJaccard } = await import("@/server/services/graph");
const rows = await db.$queryRaw<{ c: string; slug: string; w: number }[]>`
  SELECT v."channelId" c, t.slug, sum(vt.weight)::float w FROM "VideoTopic" vt JOIN "Video" v ON v.id=vt."videoId" JOIN "Topic" t ON t.id=vt."topicId"
  WHERE t."videoCount">=2 GROUP BY 1,2`;
const by = new Map<string, Map<string, number>>();
for (const r of rows) { let m = by.get(r.c); if (!m) by.set(r.c, (m = new Map())); m.set(r.slug, r.w); }
for (const [c, m] of by) { const top = [...m].sort((a,b)=>b[1]-a[1]).slice(0,15); const mx = top[0]![1]; by.set(c, new Map(top.map(([k,w])=>[k,w/mx]))); }
const best: number[] = [];
for (const [a, ma] of by) { let b = 0; for (const [c, mc] of by) if (c !== a) b = Math.max(b, weightedJaccard(ma, mc).score); best.push(b); }
best.sort((x,y)=>y-x);
console.log("channels", by.size, "max per channel jaccard:", best.map(x=>x.toFixed(2)).join(" "));
await db.$disconnect();
