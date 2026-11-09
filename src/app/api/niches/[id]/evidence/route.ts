import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { AppError } from "@/server/errors";
import { nicheEvidence } from "@/server/services/taxonomy";

/** Which videos placed content in this category, and why (decision, confidence, run, evidence). */
export const GET = withRoute({ auth: "none", params: IdParam, query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, async ({ params, query }) => {
  const r = await nicheEvidence(decodeURIComponent(params.id), query.limit);
  if (!r) throw new AppError("NOT_FOUND", "Niche not found");
  return r;
});
