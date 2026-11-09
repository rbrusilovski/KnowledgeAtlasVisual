/**
 * pnpm db:backup — encrypted PostgreSQL backup (D2).
 *
 *   pg_dump -Fc  →  AES-256-GCM (BACKUP_ENCRYPTION_KEY, kept off the DB host)  →  BACKUP_DIR/atlas-<db>-<ts>.dump.enc
 *   → optional off-host copy (BACKUP_UPLOAD_CMD, e.g. `rclone copy {file} remote:atlas-backups`)
 *   → local retention (BACKUP_RETENTION_DAYS, default 14; only files this script wrote)
 *   → status in Redis (`ops:backup:*`) so /admin alerts when backups fail, go stale or stay on-host.
 *
 * Plaintext dumps are refused. Uses the host's pg_dump if present, otherwise runs it inside the Postgres container.
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backupKey, encryptStream, pgTool, recordOps, run } from "./lib/pg-tools";

const FILE_RE = /^atlas-[\w-]+-\d{8}T\d{6}Z\.dump\.enc$/;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const dir = path.resolve(process.env.BACKUP_DIR ?? "backups");
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);
  const { key, keyId } = backupKey();
  mkdirSync(dir, { recursive: true });
  const dbName = new URL(url).pathname.slice(1) || "atlas";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = path.join(dir, `atlas-${dbName.replace(/[^\w-]/g, "_")}-${stamp}.dump.enc`);
  const tmp = `${file}.partial`;

  const tool = pgTool("pg_dump");
  console.log(`[backup] pg_dump (${tool.where}) → ${path.basename(file)}`);
  const dump = new PassThrough();
  const hash = createHash("sha256");
  const out = createWriteStream(tmp, { mode: 0o600 });
  const enc = encryptStream(key, keyId);
  enc.on("data", (c: Buffer) => hash.update(c));
  const writing = pipeline(dump, enc, out);
  await run([...tool.argv, "--format=custom", "--no-owner", "--no-privileges", tool.url(url)], { stdout: dump });
  dump.end();
  await writing;
  renameSync(tmp, file);
  const bytes = statSync(file).size;
  const sha256 = hash.digest("hex");
  writeFileSync(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`, { mode: 0o600 });
  console.log(`[backup] wrote ${(bytes / 1e6).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…`);

  let offHost = false;
  const upload = process.env.BACKUP_UPLOAD_CMD;
  if (upload) {
    for (const f of [file, `${file}.sha256`]) {
      const cmd = upload.replaceAll("{file}", `'${f.replaceAll("'", "'\\''")}'`);
      const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
      if (r.status !== 0) throw new Error(`BACKUP_UPLOAD_CMD failed (${r.status}) for ${path.basename(f)}`);
    }
    offHost = true;
    console.log("[backup] copied off-host");
  } else {
    console.warn("[backup] WARNING: BACKUP_UPLOAD_CMD is not set — this backup is NOT off-host (admin alert raised).");
  }

  // Retention: only files matching this script's naming pattern, in BACKUP_DIR.
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    const base = name.endsWith(".sha256") ? name.slice(0, -7) : name;
    if (!FILE_RE.test(base) || base === path.basename(file)) continue;
    const p = path.join(dir, name);
    if (statSync(p).mtimeMs < cutoff) {
      unlinkSync(p);
      pruned++;
    }
  }
  if (pruned) console.log(`[backup] pruned ${pruned} file(s) older than ${retentionDays} days`);
  await recordOps("backup", true, { file: path.basename(file), bytes, sha256, offHost, keyId, retentionDays });
  return file;
}

try {
  await main();
  const { redis } = await import("@/server/redis");
  await redis.quit();
  process.exit(0);
} catch (err) {
  console.error(`[backup] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  await recordOps("backup", false, { error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
  const { redis } = await import("@/server/redis");
  await redis.quit().catch(() => undefined);
  process.exit(1);
}

