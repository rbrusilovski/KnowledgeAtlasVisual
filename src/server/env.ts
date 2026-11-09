import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true" || v === "1");
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);

const serverSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    REDIS_PREFIX: z.string().default("atlas"),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be ≥ 32 chars"),
    BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    ADMIN_EMAILS: z
      .string()
      .default("")
      .transform((s) => s.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)),
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes, base64"),
    ENCRYPTION_KEY_ID: z.string().default("k1"),
    YOUTUBE_MODE: z.enum(["live", "fixture"]).default("fixture"),
    YOUTUBE_API_KEY: z.string().optional(),
    QUOTA_SEARCH_MODEL: z.enum(["bucket", "shared"]).default("bucket"),
    QUOTA_GENERAL_UNITS_PER_DAY: int(10_000),
    QUOTA_SEARCH_CALLS_PER_DAY: int(100),
    QUOTA_BACKGROUND_RATIO: z.coerce.number().min(0).max(1).default(0.6),
    DISCOVERY_SEARCHES_PER_USER_PER_DAY: int(20),
    INGEST_MAX_VIDEOS_PER_CHANNEL: int(300),
    EMBEDDING_PROVIDER: z.enum(["local", "remote", "hash"]).default("local"),
    EMBEDDING_DIM: int(384),
    EMBEDDING_MODEL: z.string().default("Xenova/all-MiniLM-L6-v2"),
    EMBEDDING_REMOTE_URL: z.string().url().optional(),
    EMBEDDING_REMOTE_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
    AI_DAILY_TOKEN_BUDGET: int(200_000),
    FEATURE_YOUTUBE_OAUTH: bool(false),
    TRANSCRIPT_THIRD_PARTY_ENABLED: bool(false),
    /** Policy gates for LIVE YouTube data (ignored in fixture mode). See docs/COMPLIANCE_DECISIONS.md. */
    YOUTUBE_LIVE_COLLECTION_ENABLED: bool(false),
    YOUTUBE_CROSS_OWNER_AGGREGATION_APPROVED: bool(false),
    YOUTUBE_DERIVED_METRICS_AMENDMENT_ACCEPTED: bool(false),
    /** Expansion proposals: how long a pending proposal can be approved, and how long an approval may execute. */
    PROPOSAL_TTL_HOURS: int(72),
    PROPOSAL_EXECUTION_DAYS: int(7),
    /** Compliance: refresh proposals are raised this many days before an API-data retention deadline. */
    COMPLIANCE_REFRESH_LEAD_DAYS: int(5),
    CLASSIFY_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.35),
    RATE_LIMIT_ANON_PER_MIN: int(60),
    RATE_LIMIT_USER_PER_MIN: int(300),
    RATE_LIMIT_DISCOVERY_PER_MIN: int(10),
    RATE_LIMIT_CHANNEL_ADDS_PER_HOUR: int(30),
    RATE_LIMIT_AI_PER_DAY: int(50),
    BULL_BOARD_PORT: int(3101),
    WORKER_SCHEDULERS: bool(true),
    /** Better Auth's built-in limiter (sign-in/sign-up brute-force protection). On by default in production. */
    AUTH_RATE_LIMIT: z.enum(["on", "off", "auto"]).default("auto"),
  })
  .superRefine((v, ctx) => {
    if (v.YOUTUBE_MODE === "live" && !v.YOUTUBE_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["YOUTUBE_API_KEY"], message: "required when YOUTUBE_MODE=live" });
    }
    if (v.EMBEDDING_PROVIDER === "remote" && !v.EMBEDDING_REMOTE_URL) {
      ctx.addIssue({ code: "custom", path: ["EMBEDDING_REMOTE_URL"], message: "required when EMBEDDING_PROVIDER=remote" });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

function load(): ServerEnv {
  // Empty strings in .env mean "unset".
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
  const parsed = serverSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${lines}\nSee .env.example.`);
  }
  return parsed.data;
}

export const env: ServerEnv = load();

export const features = {
  ai: Boolean(env.ANTHROPIC_API_KEY),
  youtubeOAuth: env.FEATURE_YOUTUBE_OAUTH && Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  demo: env.YOUTUBE_MODE === "fixture",
} as const;
