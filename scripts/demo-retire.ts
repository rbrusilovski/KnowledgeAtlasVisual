/**
 * pnpm demo:retire [--yes] — remove the fictional fixture dataset (Channel.dataOrigin = FIXTURE) from a database
 * that is switching to real YouTube data. Dry run unless --yes. Never touches users, workspaces, collections,
 * saved views, layouts, discovery history, proposals or ingestion runs. Prints what it will do / did.
 */
import "dotenv/config";

const { env } = await import("@/server/env");
const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { closeQueues } = await import("@/server/jobs");
const { retireFixtureData } = await import("@/server/services/ingestion");
const { buildFromDirtySet } = await import("@/server/services/graph");
const { recomputeNicheCounts } = await import("@/server/services/classification");

const yes = process.argv.includes("--yes");
try {
  if (env.YOUTUBE_MODE === "fixture" && !process.argv.includes("--force")) {
    console.error("YOUTUBE_MODE=fixture: the demo dataset is the intended data here. Use --force to retire it anyway.");
    process.exitCode = 2;
  } else {
    const r = await retireFixtureData({ dryRun: !yes });
    console.log(JSON.stringify(r, null, 2));
    if (!yes) console.log(r.channels ? "\nDry run. Re-run with --yes to retire these records (back up first: pg_dump)." : "\nNo demo records present.");
    else if (r.channels) {
      let built = 0;
      for (let s = await buildFromDirtySet(); s && built < 5; s = await buildFromDirtySet()) built++;
      await recomputeNicheCounts();
      console.log(`graph rebuilt from dirty set (${built} pass(es)); remaining nodes: ${await db.graphNode.count()} · edges: ${await db.graphEdge.count()}`);
    }
  }
} finally {
  await closeQueues();
  await redis.quit();
  await db.$disconnect();
  process.exit(process.exitCode ?? 0);
}
