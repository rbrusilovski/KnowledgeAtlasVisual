import { withRoute, withMeta } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { IdParam } from "@/shared/contracts/common";
import { SyncChannelBody } from "@/shared/contracts/channels";
import { findChannelId } from "@/server/services/catalog";
import { createProposal, toDTO, userActor } from "@/server/services/expansion";
import { env } from "@/server/env";

/**
 * Proposes (never runs) a sync of new uploads, or with `full: true` a bounded, resumable history backfill that
 * continues from the saved checkpoint. The caller must approve the returned proposal.
 */
export const POST = withRoute(
  { auth: "required", params: IdParam, body: SyncChannelBody, rateLimit: { name: "channel-sync", limit: env.RATE_LIMIT_CHANNEL_ADDS_PER_HOUR, windowSec: 3600 } },
  async ({ params, body, user }) => {
    const id = await findChannelId(params.id);
    const c = await db.channel.findUniqueOrThrow({ where: { id }, select: { youtubeId: true, title: true, videoCount: true, history: { select: { itemsSeen: true, state: true } } } });
    const actor = userActor(user);
    const remaining = c.videoCount !== null && c.history ? Math.max(0, c.videoCount - c.history.itemsSeen) : null;
    const p = body.full
      ? await createProposal(
          {
            scope: { kind: "BACKFILL_HISTORY", channelYoutubeId: c.youtubeId, maxPages: body.maxPages ?? 20, maxVideos: body.maxVideos ?? 1_000, includeTranscripts: true },
            reason: `Requested by you: collect older uploads of ${c.title}.`,
            coverageGap: remaining !== null ? `About ${remaining} older upload(s) not collected yet (YouTube reports ${c.videoCount}).` : "Older upload history not collected yet.",
          },
          actor,
        )
      : await createProposal(
          { scope: { kind: "SYNC_UPLOADS", channelYoutubeIds: [c.youtubeId], maxNewVideosPerChannel: 50, includeTranscripts: true }, reason: `Requested by you: check ${c.title} for new uploads and refresh its details.` },
          actor,
        );
    return withMeta(toDTO(p, actor), { full: Boolean(body.full) }, 201);
  },
);
