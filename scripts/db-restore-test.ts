/**
 * pnpm db:restore-test [--file <backup.dump.enc>] — proves a backup can actually be restored (D2).
 *
 * Decrypts (GCM tag verified before anything is restored) → restores into a throwaway database
 * `atlas_restore_test_<ts>` on the same server → checks migrations + core tables against the source → drops it.
 * Records the outcome in Redis (`ops:restore-test:*`) for /admin alerts. Never touches the source database.
 *
 * To restore for real (disaster recovery), see docs/OPERATIONS.md §Restore.
 */
import "dotenv/config";
import { createReadStream, createWriteStream, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { backupKey, decryptStream, pgTool, recordOps, run } from "./lib/pg-tools";

const TABLES = ["_prisma_migrations", "Channel", "Video", "Transcript", "Niche", "Topic", "GraphNode", "GraphEdge", "user", "Workspace", "ExpansionProposal"];

function latestBackup(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".dump.enc"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files[0]) throw new Error(`No *.dump.enc backups in ${dir}`);
  return files[0];
}

async function counts(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = Number((await c.query(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n);
    return out;
  } finally {
    await c.end();
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const argFile = process.argv.indexOf("--file");
  const file = argFile > -1 ? path.resolve(process.argv[argFile + 1]!) : latestBackup(path.resolve(process.env.BACKUP_DIR ?? "backups"));
  const { key } = backupKey();
  const plain = path.join(tmpdir(), `atlas-restore-${process.pid}.dump`);
  const testDb = `atlas_restore_test_${Date.now()}`;
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const target = new URL(url);
  target.pathname = `/${testDb}`;

  console.log(`[restore-test] decrypting ${path.basename(file)}`);
  await pipeline(createReadStream(file), decryptStream(key), createWriteStream(plain, { mode: 0o600 }));
  const a = new pg.Client({ connectionString: admin.toString() });
  await a.connect();
  try {
    await a.query(`CREATE DATABASE "${testDb}"`);
    const tool = pgTool("pg_restore");
    console.log(`[restore-test] pg_restore (${tool.where}) → ${testDb}`);
    await run([...tool.argv, "--no-owner", "--no-privileges", "--exit-on-error", "-d", tool.url(target.toString())], { stdin: createReadStream(plain) });
    const restored = await counts(target.toString());
    const missing = TABLES.filter((t) => restored[t] === undefined);
    if (missing.length) throw new Error(`Restored database lacks tables: ${missing.join(", ")}`);
    if (!restored._prisma_migrations) throw new Error("Restored database has no applied migrations");
    console.log(`[restore-test] OK — ${Object.entries(restored).map(([t, n]) => `${t}=${n}`).join(" ")}`);
    await recordOps("restore-test", true, { file: path.basename(file), counts: restored });
  } finally {
    await a.query(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`).catch(() => undefined);
    await a.end();
    try {
      unlinkSync(plain);
    } catch {
      /* already gone */
    }
  }
}

try {
  await main();
  const { redis } = await import("@/server/redis");
  await redis.quit();
  process.exit(0);
} catch (err) {
  console.error(`[restore-test] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  await recordOps("restore-test", false, { error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
  const { redis } = await import("@/server/redis");
  await redis.quit().catch(() => undefined);
  process.exit(1);
}
