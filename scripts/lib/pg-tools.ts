/**
 * Shared helpers for backup/restore/reset scripts: locating pg_dump/pg_restore (host or the Postgres container),
 * streaming AES-256-GCM backup encryption, and recording ops status in Redis for the admin alert registry.
 */
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export const MAGIC = Buffer.from("ATLB1"); // file format: MAGIC | keyId(8, padded) | iv(12) | ciphertext | tag(16)
const KEY_ID_LEN = 8;
const IV_LEN = 12;
const TAG_LEN = 16;

export function backupKey(): { key: Buffer; keyId: string } {
  const raw = process.env.BACKUP_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes, base64 (openssl rand -base64 32). Keep it OFF the database host.");
  return { key, keyId: (process.env.BACKUP_ENCRYPTION_KEY_ID ?? "b1").slice(0, KEY_ID_LEN) };
}

export function encryptStream(key: Buffer, keyId: string): Transform {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let headerSent = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!headerSent) {
        this.push(Buffer.concat([MAGIC, Buffer.from(keyId.padEnd(KEY_ID_LEN, "\0")), iv]));
        headerSent = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb: TransformCallback) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, Buffer.from(keyId.padEnd(KEY_ID_LEN, "\0")), iv]));
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

/** Streaming decrypt; the GCM tag (last 16 bytes) is verified at the end — a tampered file fails the stream. */
export function decryptStream(key: Buffer): Transform {
  let header: Buffer | null = null;
  let pending = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  const HEADER = MAGIC.length + KEY_ID_LEN + IV_LEN;
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      pending = Buffer.concat([pending, chunk]);
      if (!header) {
        if (pending.length < HEADER) return cb();
        header = pending.subarray(0, HEADER);
        if (!header.subarray(0, MAGIC.length).equals(MAGIC)) return cb(new Error("Not an Atlas encrypted backup (bad magic)"));
        decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length + KEY_ID_LEN)) as DecipherGCM;
        pending = pending.subarray(HEADER);
      }
      // Hold back the last TAG_LEN bytes: they may be the auth tag.
      if (pending.length > TAG_LEN) {
        const body = pending.subarray(0, pending.length - TAG_LEN);
        pending = pending.subarray(pending.length - TAG_LEN);
        return cb(null, decipher!.update(body));
      }
      cb();
    },
    flush(cb: TransformCallback) {
      try {
        if (!decipher || pending.length !== TAG_LEN) throw new Error("Truncated backup");
        decipher.setAuthTag(pending);
        this.push(decipher.final());
        cb();
      } catch (e) {
        cb(e instanceof Error ? e : new Error(String(e)));
      }
    },
  });
}

function onPath(bin: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

/** Postgres container to exec into when the host lacks client tools (PG_CONTAINER, or the compose `postgres` service). */
function container(): string | null {
  if (process.env.PG_CONTAINER) return process.env.PG_CONTAINER;
  const files = process.env.PG_COMPOSE_FILE ? ["-f", process.env.PG_COMPOSE_FILE] : [];
  const r = spawnSync("docker", ["compose", ...files, "ps", "-q", "postgres"], { encoding: "utf8" });
  const id = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
  if (id) return id;
  const any = spawnSync("docker", ["ps", "-q", "--filter", "ancestor=pgvector/pgvector:pg17"], { encoding: "utf8" });
  return any.status === 0 ? any.stdout.trim().split("\n")[0] || null : null;
}

export interface PgTool {
  /** argv to run; the connection URL is appended by the caller. */
  argv: string[];
  /** Rewrite a host-side URL for where the tool runs (inside the container the server is 127.0.0.1:5432). */
  url(u: string): string;
  where: string;
}

export function pgTool(bin: "pg_dump" | "pg_restore" | "psql"): PgTool {
  if (onPath(bin)) return { argv: [bin], url: (u) => u, where: "host" };
  const c = container();
  if (!c) throw new Error(`${bin} not found on PATH and no Postgres container found (set PG_CONTAINER)`);
  return {
    argv: ["docker", "exec", "-i", c, bin],
    url: (u) => {
      const x = new URL(u);
      x.hostname = "127.0.0.1";
      x.port = "5432";
      return x.toString();
    },
    where: `container ${c.slice(0, 12)}`,
  };
}

export function run(argv: string[], opts: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0]!, argv.slice(1), { stdio: [opts.stdin ? "pipe" : "ignore", opts.stdout ? "pipe" : "inherit", "inherit"] });
    if (opts.stdin) opts.stdin.pipe(p.stdin!);
    if (opts.stdout) p.stdout!.pipe(opts.stdout, { end: false });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${argv.slice(0, 5).join(" ")} exited with ${code}`))));
  });
}

/** Ops status for the alert registry (services/alerts reads these keys). */
export async function recordOps(name: "backup" | "restore-test", ok: boolean, info: Record<string, unknown>) {
  const { redis, key } = await import("@/server/redis");
  const payload = JSON.stringify({ at: new Date().toISOString(), ok, ...info });
  await redis.set(key("ops", name, ok ? "last-success" : "last-failure"), payload);
  await redis.set(key("ops", name, "last"), payload);
}

export function isLocalHost(u: string): boolean {
  const h = new URL(u).hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".localhost");
}
