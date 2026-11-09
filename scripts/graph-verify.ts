/**
 * pnpm graph:verify [--repair] — check the materialized graph against canonical rows (D5): missing/orphan nodes,
 * dangling, non-canonical or malformed edges, the pending dirty set and version drift. `--repair` rebuilds the
 * affected nodes and deletes edges that still don't resolve (tombstoned, so open atlases receive the delta).
 * Exit code 0 = consistent (or repaired), 2 = inconsistent.
 */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { closeQueues } = await import("@/server/jobs");
const { verifyGraph } = await import("@/server/services/graph");

const repair = process.argv.includes("--repair");
let code = 0;
try {
  const r = await verifyGraph({ repair });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok && repair) {
    const again = await verifyGraph();
    console.log(again.ok ? "[graph:verify] repaired — graph is consistent" : "[graph:verify] still inconsistent after repair (see report)");
    code = again.ok ? 0 : 2;
  } else {
    console.log(r.ok ? "[graph:verify] consistent" : "[graph:verify] INCONSISTENT — run with --repair (or pnpm graph:rebuild)");
    code = r.ok ? 0 : 2;
  }
} finally {
  await closeQueues();
  await redis.quit();
  await db.$disconnect();
}
process.exit(code);
