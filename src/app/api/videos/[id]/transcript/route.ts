import { z } from "zod";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { TranscriptUploadBody } from "@/shared/contracts/discover";
import { findVideoId } from "@/server/services/catalog";
import { getTranscript, uploadTranscript, deleteTranscript, timestampUrl } from "@/server/services/transcripts";
import { searchInTranscript } from "@/server/services/search";
import { db } from "@/server/db";

/**
 * Transcripts are scoped to the viewer: their own private uploads / owner captions plus the shared (fixture) corpus.
 * Sign-in is required (plan Phase 0: `auth: "required"`); another user's private transcript is indistinguishable
 * from none.
 */
export const GET = withRoute(
  { auth: "required", params: IdParam, query: z.object({ q: z.string().trim().max(200).optional(), transcriptId: z.string().max(40).optional() }) },
  async ({ params, query, user }) => {
    const id = await findVideoId(params.id);
    const t = await getTranscript(id, { userId: user.id }, query.transcriptId);
    if (!t) return withMeta(null, { available: false });
    if (!query.q) return withMeta(t, { available: true });
    const yt = (await db.video.findUniqueOrThrow({ where: { id }, select: { youtubeId: true } })).youtubeId;
    const hits = await searchInTranscript(t.id, query.q);
    return withMeta({ ...t, hits: hits.map((h) => ({ ...h, url: timestampUrl(yt, h.startSec) })) }, { available: true, q: query.q, matches: hits.length });
  },
);

export const POST = withRoute(
  { auth: "required", params: IdParam, body: TranscriptUploadBody, rateLimit: { name: "transcript-upload", limit: 30, windowSec: 3600 } },
  async ({ params, body, user }) => {
    const id = await findVideoId(params.id);
    return withMeta(await uploadTranscript(id, body.text, { filename: body.filename, language: body.language, userId: user.id }), {}, 201);
  },
);

export const DELETE = withRoute({ auth: "required", params: IdParam, query: z.object({ transcriptId: z.string().min(1).max(40) }) }, async ({ query, user }) =>
  deleteTranscript(query.transcriptId, { userId: user.id }),
);
