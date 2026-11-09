/**
 * pnpm db:reset — DEVELOPMENT ONLY. Wipes ALL data in the configured database and Redis namespace, re-applies
 * migrations, then re-seeds. Refuses production, live mode and non-local hosts (scripts/lib/reset-guard.ts) and
 * requires --yes (or ATLAS_RESET_CONFIRM=1).
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { resetRefusal } from "./lib/reset-guard";

const refusal = resetRefusal({ env: process.env, argv: process.argv });
if (refusal) {
  console.error(`[reset] ${refusal}\nThis deletes every row in DATABASE_URL and every Redis key under REDIS_PREFIX.`);
  process.exit(1);
}
const target = new URL(process.env.DATABASE_URL!);
console.log(`[reset] target ${target.hostname}:${target.port || 5432}${target.pathname}`);

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
