/** pnpm embeddings:reindex — re-embed niches, topics, videos, chunks and channels with the current provider. */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { closeQueues } = await import("@/server/jobs");
const { reindexAll, getProvider } = await import("@/server/services/embeddings");

console.log(`[reindex] provider ${getProvider().name} (${getProvider().dimensions}d)`);
let last = "";
await reindexAll((entity, n) => {
  const line = `${entity} ${n}`;
  if (line !== last) process.stdout.write(`\r[reindex] ${line}        `);
  last = line;
});
console.log("\n[reindex] done — run `pnpm graph:rebuild` to refresh SIMILAR edges");
await closeQueues();
await redis.quit();
await db.$disconnect();
process.exit(0);
