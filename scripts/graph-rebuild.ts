/** pnpm graph:rebuild [--topics] — full rebuild of the materialized graph (optionally re-extract all topics first). */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { closeQueues } = await import("@/server/jobs");
const { rebuildAll, computeCommunities } = await import("@/server/services/graph");
const { extractTopics } = await import("@/server/services/topics");

try {
  if (process.argv.includes("--topics")) {
    const ids = (await db.video.findMany({ select: { id: true } })).map((v) => v.id);
    for (let i = 0; i < ids.length; i += 200) {
      await extractTopics(ids.slice(i, i + 200));
      process.stdout.write(`\rtopics ${Math.min(ids.length, i + 200)}/${ids.length}`);
    }
    console.log();
  }
  let last = 0;
  const stats = await rebuildAll((done, total) => {
    if (Date.now() - last > 1000) {
      process.stdout.write(`\rgraph ${done}/${total}`);
      last = Date.now();
    }
  });
  console.log("\nrebuild:", stats);
  console.log("communities:", await computeCommunities());
  console.log("totals:", { nodes: await db.graphNode.count(), edges: await db.graphEdge.count() });
} finally {
  await closeQueues();
  await redis.quit();
  await db.$disconnect();
  process.exit(process.exitCode ?? 0); // onnxruntime threads would otherwise keep the process alive
}
