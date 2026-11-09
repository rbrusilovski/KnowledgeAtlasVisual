import { withRoute } from "@/server/http/withRoute";
import { IdParam } from "@/shared/contracts/common";
import { videoDetail, findVideoId } from "@/server/services/catalog";
import { getCachedExtraction, aiEnabled } from "@/server/services/ai";

export const GET = withRoute({ auth: "none", params: IdParam }, async ({ params }) => {
  const id = await findVideoId(params.id);
  const [v, ai] = await Promise.all([videoDetail(id), getCachedExtraction(id)]);
  return { ...v, ai: { enabled: aiEnabled(), extraction: ai ? { output: ai.output, model: ai.model, createdAt: ai.createdAt.toISOString() } : null } };
});
