/**
 * Isolated end-to-end environment (used by Playwright's webServer):
 *   DB atlas_e2e · Redis prefix atlas-e2e · port 3100 · build dir .next-e2e · hash embeddings (offline, fast)
 * Resets the e2e DB, seeds taxonomy + a subset of fixture channels through the real pipeline, then runs the
 * worker and a production build served by `next start`. Ctrl-C / SIGTERM stops everything.
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env", quiet: true });
const PORT = process.env.E2E_PORT ?? "3100";
const DB = process.env.E2E_DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas_e2e";
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: DB,
  // Overridable so parallel worktrees can run e2e side by side (E2E_PORT / E2E_DATABASE_URL / E2E_REDIS_PREFIX).
  REDIS_PREFIX: process.env.E2E_REDIS_PREFIX ?? "atlas-e2e",
  YOUTUBE_MODE: "fixture",
  EMBEDDING_PROVIDER: "hash",
  BETTER_AUTH_URL: `http://localhost:${PORT}`,
  NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
  NEXT_DIST_DIR: ".next-e2e",
  BULL_BOARD_PORT: process.env.E2E_BULL_BOARD_PORT ?? "3111",
  WORKER_SCHEDULERS: "false",
  RATE_LIMIT_ANON_PER_MIN: "5000",
  RATE_LIMIT_USER_PER_MIN: "5000",
  RATE_LIMIT_DISCOVERY_PER_MIN: "500",
  RATE_LIMIT_CHANNEL_ADDS_PER_HOUR: "500",
  DISCOVERY_SEARCHES_PER_USER_PER_DAY: "100",
  LOG_LEVEL: "warn",
  AUTH_RATE_LIMIT: "off",
};

async function ensureDb() {
  const admin = new URL(DB);
  const name = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  if (!(await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount) await c.query(`CREATE DATABASE "${name}"`);
  await c.end();
}

const children: ChildProcess[] = [];
const stop = () => {
  for (const ch of children) ch.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await ensureDb();
const run = (cmd: string) => execSync(cmd, { env, stdio: "inherit" });
run("pnpm -s prisma migrate deploy");
run("pnpm -s tsx scripts/db-reset.ts --yes --no-seed");
run(`pnpm -s tsx prisma/seed/index.ts --channels ${process.env.E2E_CHANNELS ?? "14"}`);
children.push(spawn("pnpm", ["-s", "tsx", "src/worker/index.ts"], { env: { ...env, ATLAS_PROCESS: "worker" }, stdio: "inherit" }));
// Production build + `next start` (not `next dev`): dev servers rewrite next-env.d.ts on start, so an e2e dev server
// and a developer's `pnpm dev` would keep triggering each other's reloads. It's also closer to production.
if (!process.env.E2E_SKIP_BUILD) run("pnpm -s next build");
children.push(spawn("pnpm", ["-s", "next", "start", "-p", PORT], { env: { ...env, NODE_ENV: "production" }, stdio: "inherit" }));
