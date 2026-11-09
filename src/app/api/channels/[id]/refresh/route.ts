import { z } from "zod";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { IdParam } from "@/shared/contracts/common";
import { EXPANSION_LIMITS } from "@/shared/contracts/expansion";
import { findChannelId } from "@/server/services/catalog";
import { createProposal, toDTO, userActor } from "@/server/services/expansion";

/**
 * Propose re-fetching this channel and its stored videos (all parts, or statistics only). Refresh never adds records;
 * items YouTube no longer returns are deleted. Runs only after approval.
 */
export const POST = withRoute(
  { auth: "required", params: IdParam, body: z.object({ fields: z.enum(["all", "statistics"]).default("all") }), rateLimit: { name: "channel-sync", limit: env.RATE_LIMIT_CHANNEL_ADDS_PER_HOUR, windowSec: 3600 } },
  async ({ params, body, user }) => {
    const id = await findChannelId(params.id);
    const c = await db.channel.findUniqueOrThrow({ where: { id }, select: { youtubeId: true, title: true } });
    const videos = await db.video.findMany({ where: { channelId: id }, select: { youtubeId: true }, orderBy: { publishedAt: "desc" }, take: EXPANSION_LIMITS.refreshVideos });
    const actor = userActor(user);
    const p = await createProposal(
      {
        scope: { kind: "REFRESH_METADATA", channelYoutubeIds: [c.youtubeId], videoYoutubeIds: videos.map((v) => v.youtubeId), fields: body.fields, purpose: "user" },
        reason: `Requested by you: refresh ${body.fields === "statistics" ? "statistics" : "all metadata"} for ${c.title} and its ${videos.length} stored video(s).`,
        title: `Refresh ${c.title} (${videos.length} videos)`,
      },
      actor,
    );
    return withMeta(toDTO(p, actor), {}, 201);
  },
);
