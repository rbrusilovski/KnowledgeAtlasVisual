/**
 * `pnpm db:reset` safety rules (plan Phase 6 / D3). Pure function so it is unit-tested.
 * Refuses: production (NODE_ENV or ATLAS_ENV), live YouTube mode, non-local database hosts (unless
 * ATLAS_ALLOW_REMOTE_RESET=1 — never honoured in production), and runs without explicit confirmation.
 */
export interface ResetGuardInput {
  env: Record<string, string | undefined>;
  argv: string[];
}

export function resetRefusal({ env, argv }: ResetGuardInput): string | null {
  if (env.NODE_ENV === "production" || env.ATLAS_ENV === "production") return "refusing to reset: NODE_ENV/ATLAS_ENV is production";
  if (env.YOUTUBE_MODE === "live") return "refusing to reset: YOUTUBE_MODE=live (this looks like a real deployment)";
  if (!env.DATABASE_URL) return "DATABASE_URL is not set";
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || host.endsWith(".localhost");
  if (!local && env.ATLAS_ALLOW_REMOTE_RESET !== "1") return `refusing to reset a non-local database host (${host}); set ATLAS_ALLOW_REMOTE_RESET=1 if this really is a disposable dev database`;
  if (!argv.includes("--yes") && env.ATLAS_RESET_CONFIRM !== "1") return "destructive: re-run with `pnpm db:reset --yes`";
  return null;
}
