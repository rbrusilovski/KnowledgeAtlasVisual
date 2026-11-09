/**
 * pnpm db:seed — taxonomy (+ centroid embeddings), demo user, and (fixture mode) ingest of the demo dataset
 * through the REAL pipeline (in-process BullMQ workers, drained before exit).
 *   --no-ingest   skip the fixture ingest
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const { env } = await import("@/server/env");
const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { auth } = await import("@/server/auth");
const { seedTaxonomy } = await import("@/server/services/classification");
const { embedEntities } = await import("@/server/services/embeddings");
const { enqueue, getQueue, QUEUES, closeQueues } = await import("@/server/jobs");
const { startWorkers } = await import("@/worker/processors");

const log = (...a: unknown[]) => console.log("[seed]", ...a);

async function drainAll(timeoutMs = 30 * 60_000) {
  const names = Object.values(QUEUES).filter((q) => q !== "scheduler" && q !== "compliance");
  const t0 = Date.now();
  let quiet = 0;
  let lastPrint = 0;
  while (Date.now() - t0 < timeoutMs) {
    let busy = 0;
    const parts: string[] = [];
    for (const q of names) {
      const c = await getQueue(q).getJobCounts("waiting", "active", "prioritized", "delayed");
      const n = (c.waiting ?? 0) + (c.active ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0);
      busy += n;
      if (n) parts.push(`${q}:${n}`);
    }
    if (Date.now() - lastPrint > 5_000 && parts.length) {
      log("working…", parts.join(" "));
      lastPrint = Date.now();
    }
    quiet = busy === 0 ? quiet + 1 : 0;
    if (quiet >= 4) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("pipeline did not drain in time");
}

async function main() {
  const t0 = Date.now();
  const toEmbed = await seedTaxonomy();
  if (toEmbed.length) await embedEntities("niche", toEmbed);
  log(`taxonomy: ${await db.niche.count()} niches (${toEmbed.length} centroids embedded)`);
  const { buildDirty } = await import("@/server/services/graph");
  const nicheRows = await db.niche.findMany({ select: { slug: true, depth: true } });
  await buildDirty(nicheRows.map((n) => `${n.depth === 0 ? "niche" : "subniche"}:${n.slug}`));

  const demoEmail = "demo@atlas.local";
  if (!(await db.user.findUnique({ where: { email: demoEmail } }))) {
    await auth.api.signUpEmail({ body: { email: demoEmail, password: process.env.DEMO_USER_PASSWORD ?? "atlas-demo-1234", name: "Demo" } });
    log(`demo user created: ${demoEmail} (password from DEMO_USER_PASSWORD, see .env.example)`);
  }

  if (process.argv.includes("--no-ingest") || env.YOUTUBE_MODE !== "fixture") {
    log(env.YOUTUBE_MODE === "live" ? "live mode: skipping fixture ingest" : "skipping ingest");
    return;
  }
  const indexFile = path.join(process.cwd(), "fixtures", "youtube", "index.json");
  if (!existsSync(indexFile)) throw new Error("fixtures missing — run `pnpm fixtures:generate`");
  const index = JSON.parse(readFileSync(indexFile, "utf8")) as { channels: { id: string; title: string }[] };
  const workers = startWorkers();
  try {
    const ci = process.argv.indexOf("--channels");
    const limit = ci >= 0 ? Number(process.argv[ci + 1]) : index.channels.length;
    // --channels N ingests the first N (in subniche order, so several niches are covered); the rest stay discoverable.
    const pick = index.channels.slice(0, limit);
    for (const c of pick) await enqueue.ingest({ youtubeId: c.id, lane: "background" });
    log(`enqueued ${pick.length} fictional demo channels`);
    await drainAll();
  } finally {
    await Promise.all(workers.map((w) => w.close()));
  }
  const [channels, videos, topics, nodes, edges] = await Promise.all([db.channel.count(), db.video.count(), db.topic.count({ where: { videoCount: { gte: 2 } } }), db.graphNode.count(), db.graphEdge.count()]);
  log(`done in ${Math.round((Date.now() - t0) / 1000)}s: ${channels} channels, ${videos} videos, ${topics} topics, graph ${nodes} nodes / ${edges} edges`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueues();
    await redis.quit();
    await db.$disconnect();
    process.exit();
  });
