import { config } from "dotenv";

// Tests run against the same docker services but an isolated DB + Redis prefix.
config({ path: ".env", quiet: true });
Object.assign(process.env, { NODE_ENV: "test" });
process.env.YOUTUBE_MODE = "fixture";
process.env.REDIS_PREFIX = process.env.TEST_REDIS_PREFIX ?? "atlas-test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://atlas:atlas@localhost:5432/atlas_test";
process.env.EMBEDDING_PROVIDER = process.env.TEST_EMBEDDING_PROVIDER ?? "hash";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-123";
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
// Tests never inherit the owner's local compliance decisions or taxonomy mode from .env: they start from the
// safe defaults and individual tests opt in explicitly.
process.env.YOUTUBE_LIVE_COLLECTION_ENABLED = "false";
process.env.YOUTUBE_CROSS_OWNER_AGGREGATION_APPROVED = "false";
process.env.YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED = "false";
process.env.TAXONOMY_MODE = "seed";
