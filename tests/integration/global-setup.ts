import { execSync } from "node:child_process";
import pg from "pg";
import { config } from "dotenv";

/** Creates/migrates the isolated `atlas_test` database once per run. */
export default async function setup() {
  config({ path: ".env", quiet: true });
  const testUrl = process.env.TEST_DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas_test";
  const admin = new URL(testUrl);
  const dbName = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${dbName}"`);
  await client.end();
  execSync("pnpm -s prisma migrate deploy", { env: { ...process.env, DATABASE_URL: testUrl }, stdio: "pipe" });
}
