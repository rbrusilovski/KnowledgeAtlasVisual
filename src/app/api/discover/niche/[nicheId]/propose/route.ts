import { z } from "zod";
import { withRoute, withMeta } from "@/server/http/withRoute";
import { db } from "@/server/db";
import { AppError, notFound } from "@/server/errors";
import { EXPANSION_LIMITS } from "@/shared/contracts/expansion";
import { createProposal, toDTO, userActor } from "@/server/services/expansion";

const Body = z.object({
  maxChannelsToAdd: z.number().int().min(1).max(EXPANSION_LIMITS.discoveryChannelsToAdd).default(5),
  maxCandidatesPerQuery: z.number().int().min(1).max(EXPANSION_LIMITS.discoveryCandidatesPerQuery).default(15),
  maxVideosPerChannel: z.number().int().min(0).max(1_000).default(100),
  regionCode: z.string().regex(/^[A-Z]{2}$/).optional(),
});

/**
 * Propose a bounded DISCOVER_CHANNELS expansion from a subniche's curated discovery queries. Nothing is searched or
 * added until the user approves the proposal (which shows the search count and the maximum channels/videos).
 */
export const POST = withRoute(
  { auth: "required", params: z.object({ nicheId: z.string().max(100) }), body: Body, rateLimit: { name: "proposal-create", limit: 60, windowSec: 3600 } },
  async ({ params, body, user }) => {
    const n = await db.niche.findFirst({ where: { OR: [{ id: params.nicheId }, { slug: params.nicheId }] }, select: { id: true, name: true, discoveryQueries: true } });
    if (!n) throw notFound("Niche");
    if (!n.discoveryQueries.length) throw new AppError("VALIDATION_ERROR", "This niche has no discovery queries");
    const actor = userActor(user);
    const p = await createProposal(
      {
        scope: { kind: "DISCOVER_CHANNELS", queries: n.discoveryQueries.slice(0, EXPANSION_LIMITS.discoveryQueries), nicheId: n.id, regionCode: body.regionCode, maxCandidatesPerQuery: body.maxCandidatesPerQuery, maxChannelsToAdd: body.maxChannelsToAdd, maxVideosPerChannel: body.maxVideosPerChannel, includeTranscripts: true },
        reason: `Requested by you: find up to ${body.maxChannelsToAdd} new channel(s) for ${n.name} using its curated discovery queries.`,
        coverageGap: `${n.name} may be missing relevant channels.`,
        title: `Discover up to ${body.maxChannelsToAdd} new ${n.name} channel(s)`,
      },
      actor,
    );
    return withMeta(toDTO(p, actor), {}, 201);
  },
);
