import { withRoute, withMeta } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { enqueue } from "@/server/jobs";
import { IdParam } from "@/shared/contracts/common";
import { SyncChannelBody } from "@/shared/contracts/channels";
import { findChannelId } from "@/server/services/catalog";
import { env } from "@/server/env";

export const POST = withRoute(
  { auth: "required", params: IdParam, body: SyncChannelBody, rateLimit: { name: "channel-sync", limit: env.RATE_LIMIT_CHANNEL_ADDS_PER_HOUR, windowSec: 3600 } },
  async ({ params, body, user }) => {
    const id = await findChannelId(params.id);
    const c = await db.channel.findUniqueOrThrow({ where: { id }, select: { youtubeId: true, backfillPageToken: true } });
    const job = body.full
      ? await enqueue.ingest({ youtubeId: c.youtubeId, requestedBy: user.id, full: true, lane: "interactive" })
      : await enqueue.sync(id, "interactive", user.id);
    return withMeta({ jobId: job.id, full: Boolean(body.full), hasMoreHistory: Boolean(c.backfillPageToken) }, {}, 202);
  },
);
