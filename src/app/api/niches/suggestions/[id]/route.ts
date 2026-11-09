import { z } from "zod";
import { withRoute } from "@/server/http/withRoute";
import { dismissSuggestion } from "@/server/services/classification";

export const DELETE = withRoute({ auth: "admin", params: z.object({ id: z.string().regex(/^[a-f0-9]{12}$/) }) }, async ({ params }) => {
  await dismissSuggestion(params.id);
  return { dismissed: true };
});
