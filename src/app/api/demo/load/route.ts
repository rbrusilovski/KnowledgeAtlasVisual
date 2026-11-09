import { readFileSync } from "node:fs";
import path from "node:path";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { enqueue } from "@/server/jobs";

/** Fixture mode only: queue the fictional demo channels that aren't in the atlas yet (same pipeline as real adds). */
export const POST = withRoute({ auth: "required", rateLimit: { name: "demo-load", limit: 3, windowSec: 3600 } }, async ({ user }) => {
  if (env.YOUTUBE_MODE !== "fixture") throw new AppError("FORBIDDEN", "The demo dataset is only available in fixture mode");
  const index = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "youtube", "index.json"), "utf8")) as { channels: { id: string }[] };
  const have = new Set((await db.channel.findMany({ select: { youtubeId: true } })).map((c) => c.youtubeId));
  const missing = index.channels.filter((c) => !have.has(c.id));
  for (const c of missing) await enqueue.ingest({ youtubeId: c.id, requestedBy: user.id, lane: "interactive" });
  return withMeta({ queued: missing.length, total: index.channels.length }, {}, 202);
});
