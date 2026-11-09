import { z } from "zod";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { TranscriptUploadBody } from "@/shared/contracts/discover";
import { findVideoId } from "@/server/services/catalog";
import { getTranscript, uploadTranscript, timestampUrl } from "@/server/services/transcripts";
import { searchInTranscript } from "@/server/services/search";
import { db } from "@/server/db";

export const GET = withRoute({ auth: "none", params: IdParam, query: z.object({ q: z.string().trim().max(200).optional() }) }, async ({ params, query }) => {
  const id = await findVideoId(params.id);
  const t = await getTranscript(id);
  if (!t) return withMeta(null, { available: false });
  if (!query.q) return withMeta(t, { available: true });
  const yt = (await db.video.findUniqueOrThrow({ where: { id }, select: { youtubeId: true } })).youtubeId;
  const hits = await searchInTranscript(id, query.q);
  return withMeta({ ...t, hits: hits.map((h) => ({ ...h, url: timestampUrl(yt, h.startSec) })) }, { available: true, q: query.q, matches: hits.length });
});

export const POST = withRoute(
  { auth: "required", params: IdParam, body: TranscriptUploadBody, rateLimit: { name: "transcript-upload", limit: 30, windowSec: 3600 } },
  async ({ params, body, user }) => {
    const id = await findVideoId(params.id);
    return withMeta(await uploadTranscript(id, body.text, { filename: body.filename, language: body.language, userId: user.id }), {}, 201);
  },
);
