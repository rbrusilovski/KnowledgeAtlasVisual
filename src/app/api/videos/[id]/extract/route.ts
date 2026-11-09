import { withRoute, withMeta } from "@/server/http/withRoute";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { IdParam } from "@/shared/contracts/common";
import { findVideoId } from "@/server/services/catalog";
import { aiEnabled, extractVideo } from "@/server/services/ai";
import { applyAiTopics } from "@/server/services/topics";

export const POST = withRoute(
  { auth: "required", params: IdParam, rateLimit: { name: "ai-extract", limit: env.RATE_LIMIT_AI_PER_DAY, windowSec: 86400 } },
  async ({ params }) => {
    if (!aiEnabled()) throw new AppError("FORBIDDEN", "AI extraction is not enabled on this server (set ANTHROPIC_API_KEY).");
    const id = await findVideoId(params.id);
    const r = await extractVideo(id);
    await applyAiTopics(id, r.output.topics);
    return withMeta(r.output, { cached: r.cached, model: env.ANTHROPIC_MODEL });
  },
);
