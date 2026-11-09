import { readFileSync } from "node:fs";
import path from "node:path";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { createProposal, toDTO, userActor } from "@/server/services/expansion";

/** Fixture mode only: PROPOSE adding the fictional demo channels that aren't in the atlas yet (approve to load). */
export const POST = withRoute({ auth: "required", rateLimit: { name: "demo-load", limit: 10, windowSec: 3600 } }, async ({ user }) => {
  if (env.YOUTUBE_MODE !== "fixture") throw new AppError("FORBIDDEN", "The demo dataset is only available in fixture mode");
  const index = JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "youtube", "index.json"), "utf8")) as { channels: { id: string }[] };
  const have = new Set((await db.channel.findMany({ select: { youtubeId: true } })).map((c) => c.youtubeId));
  const missing = index.channels.filter((c) => !have.has(c.id)).slice(0, 100);
  if (!missing.length) return withMeta(null, { queued: 0, total: index.channels.length });
  const actor = userActor(user);
  const p = await createProposal(
    {
      scope: { kind: "ADD_CHANNELS", channels: missing.map((c) => ({ youtubeId: c.id, aliases: [] })), maxVideosPerChannel: env.INGEST_MAX_VIDEOS_PER_CHANNEL, includeTranscripts: true },
      reason: "Load the fictional demo dataset (fixture mode).",
      title: `Load ${missing.length} demo channels`,
    },
    actor,
  );
  return withMeta(toDTO(p, actor), { missing: missing.length, total: index.channels.length }, 201);
});
