/**
 * pnpm db:reset — wipes ALL data in the configured database and Redis namespace, re-applies migrations,
 * then re-seeds. Destructive: requires --yes (or ATLAS_RESET_CONFIRM=1).
 */
import "dotenv/config";
import { execSync } from "node:child_process";

if (!process.argv.includes("--yes") && process.env.ATLAS_RESET_CONFIRM !== "1") {
  console.error("This deletes every row in DATABASE_URL and every Redis key under REDIS_PREFIX.\nRe-run with: pnpm db:reset --yes");
  process.exit(1);
}

const { db } = await import("@/server/db");
const { redis, key } = await import("@/server/redis");
const { env } = await import("@/server/env");

const tables = await db.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
await db.$executeRawUnsafe(`ALTER SEQUENCE graph_version_seq RESTART WITH 1`);
for (const pattern of [`${key("")}*`, `${env.REDIS_PREFIX}-bull:*`]) {
  const stream = redis.scanStream({ match: pattern, count: 500 });
  for await (const keys of stream as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
}
await redis.quit();
await db.$disconnect();
console.log(`[reset] cleared ${tables.length} tables and Redis namespace "${env.REDIS_PREFIX}"`);
execSync("pnpm -s prisma migrate deploy", { stdio: "inherit" });
if (!process.argv.includes("--no-seed")) execSync("pnpm -s db:seed", { stdio: "inherit" });
process.exit(0);
