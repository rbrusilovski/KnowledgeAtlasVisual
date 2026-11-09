/**
 * pnpm embeddings:reindex [--all] — re-embed rows whose vector came from another model (or have none) (D4).
 *
 * Resumable: progress is the rows' own `embeddingModel`, so an interrupted run picks up where it stopped.
 * Refuses when a vector column's dimension differs from EMBEDDING_DIM (that needs a schema migration first).
 * While stale vectors remain, semantic search, SIMILAR edges and embedding-based classification are disabled rather
 * than comparing vectors from different models. `--all` re-embeds every row with the current model.
 */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { closeQueues } = await import("@/server/jobs");
const { reindexEmbeddings, embeddingSpace } = await import("@/server/services/embeddings");

const all = process.argv.includes("--all");
const before = await embeddingSpace({ fresh: true });
console.log(`[reindex] model ${before.model} · columns ${JSON.stringify(before.columns)}`);
console.log(`[reindex] stale ${JSON.stringify(before.stale)} · missing ${JSON.stringify(before.missing)}${all ? " · --all" : ""}`);
let code = 0;
try {
  let last = "";
  const r = await reindexEmbeddings({
    all,
    onProgress: (entity, done) => {
      const line = `${entity} ${done}`;
      if (line !== last) process.stdout.write(`\r[reindex] ${line}        `);
      last = line;
    },
  });
  console.log(`\n[reindex] done ${JSON.stringify(r.totals)} — ${r.space.blocked ? `still blocked: ${r.space.reason}` : "vector space consistent"}`);
  console.log("[reindex] run `pnpm graph:rebuild` to recompute SIMILAR edges");
  if (r.space.blocked) code = 2;
} catch (err) {
  console.error(`\n[reindex] ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
}
await closeQueues();
await redis.quit();
await db.$disconnect();
process.exit(code);
