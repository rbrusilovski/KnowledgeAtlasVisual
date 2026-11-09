import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { history } from "@/server/services/quota";
import { getQueue, QUEUES, queueCounts } from "@/server/jobs";
import { tokenUsageToday } from "@/server/services/ai";
import { evaluateAlerts } from "@/server/services/alerts";

export const dynamic = "force-dynamic";

export const GET = withRoute({ auth: "admin", query: z.object({ days: z.coerce.number().int().min(1).max(8).default(7) }) }, async ({ query }) => {
  const [quota, runs, counts, ai, alerts] = await Promise.all([
    history(query.days),
    db.ingestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 100 }),
    queueCounts(),
    tokenUsageToday(),
    evaluateAlerts(),
  ]);
  const failed = (
    await Promise.all(
      Object.values(QUEUES).map(async (q) =>
        (await getQueue(q).getFailed(0, 19)).map((j) => ({ queue: q, id: j.id, name: j.name, failedReason: j.failedReason, attemptsMade: j.attemptsMade, finishedOn: j.finishedOn ? new Date(j.finishedOn).toISOString() : null, data: j.data })),
      ),
    )
  ).flat().sort((a, b) => String(b.finishedOn).localeCompare(String(a.finishedOn))).slice(0, 50);
  const totals = { channels: await db.channel.count(), videos: await db.video.count(), transcripts: await db.transcript.count(), topics: await db.topic.count({ where: { videoCount: { gte: 2 } } }), users: await db.user.count(), nodes: await db.graphNode.count(), edges: await db.graphEdge.count() };
  return { alerts, quota, runs, queues: counts, failed, ai, totals };
});
