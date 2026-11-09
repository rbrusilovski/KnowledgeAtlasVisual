/**
 * Optional AI features (only when ANTHROPIC_API_KEY is set): per-video extraction of topics/entities/claims +
 * a 2-sentence summary, and re-ranking of low-confidence niche classifications. Structured outputs via Zod,
 * cached by content hash in AiExtraction, bounded by a daily token budget.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { db, type Prisma } from "@/server/db";
import { env, features } from "@/server/env";
import { AppError } from "@/server/errors";
import { redis, key } from "@/server/redis";
import { log } from "@/server/logger";
import { quotaDay, secondsUntilReset } from "@/server/services/quota";
import { assertAllowed as assertPolicy } from "@/server/youtube/policy";
import { corpusTranscriptText } from "@/server/services/transcripts";

export const aiEnabled = () => features.ai;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!features.ai) throw new AppError("FORBIDDEN", "AI features are disabled (ANTHROPIC_API_KEY not set)");
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 });
  return client;
}

const budgetKey = () => key("ai", "tokens", quotaDay());

export async function tokenUsageToday() {
  return { used: Number((await redis.get(budgetKey())) ?? 0), budget: env.AI_DAILY_TOKEN_BUDGET };
}

async function assertBudget() {
  const { used, budget } = await tokenUsageToday();
  if (used >= budget) {
    throw new AppError("QUOTA_EXHAUSTED", "Daily AI token budget reached", { scope: "ai", used, budget }, { "Retry-After": String(secondsUntilReset()) });
  }
}

async function recordTokens(n: number) {
  await redis.multi().incrby(budgetKey(), n).expire(budgetKey(), 3 * 86400).exec();
}

async function structured<T extends z.ZodType>(schema: T, system: string, user: string, maxTokens = 2_000): Promise<{ data: z.infer<T>; tokensIn: number; tokensOut: number }> {
  await assertBudget();
  let response;
  try {
    response = await anthropic().messages.parse({
      model: env.ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: zodOutputFormat(schema) },
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new AppError("RATE_LIMITED", "AI provider rate limited; try again shortly");
    if (err instanceof Anthropic.APIError) throw new AppError("UPSTREAM_ERROR", `AI provider error ${err.status ?? ""}`.trim());
    throw err;
  }
  const tokensIn = response.usage.input_tokens;
  const tokensOut = response.usage.output_tokens;
  await recordTokens(tokensIn + tokensOut);
  if (response.stop_reason === "refusal") throw new AppError("UPSTREAM_ERROR", "AI declined this request");
  if (!response.parsed_output) throw new AppError("UPSTREAM_ERROR", `AI returned no structured output (stop: ${response.stop_reason})`);
  return { data: response.parsed_output as z.infer<T>, tokensIn, tokensOut };
}

// ── Video extraction ───────────────────────────────────────────────────────

export const VideoExtraction = z.object({
  summary: z.string().describe("Exactly two sentences summarizing the video."),
  topics: z.array(z.object({ label: z.string().describe("1-4 word lowercase topic"), weight: z.number().describe("0..1 salience") })).describe("Up to 8 topics."),
  entities: z.array(z.object({ name: z.string(), type: z.enum(["person", "organization", "product", "place", "work", "concept", "other"]) })),
  claims: z.array(z.string()).describe("Up to 5 key claims made in the video."),
});
export type VideoExtraction = z.infer<typeof VideoExtraction>;

export async function videoContent(videoId: string) {
  const v = await db.video.findUnique({
    where: { id: videoId },
    select: { id: true, title: true, description: true, tags: true },
  });
  if (!v) throw new AppError("NOT_FOUND", "Video not found");
  // Shared AI output may only use shared-corpus transcript text.
  const transcript = (await corpusTranscriptText(videoId, 12)).join(" ").slice(0, 12_000);
  const content = `Title: ${v.title}\nTags: ${v.tags.join(", ")}\nDescription:\n${v.description.slice(0, 3000)}\n${transcript ? `\nTranscript excerpt:\n${transcript}` : ""}`;
  return { content, contentHash: createHash("sha256").update(content).digest("hex").slice(0, 32) };
}

export async function getCachedExtraction(videoId: string) {
  return db.aiExtraction.findFirst({ where: { targetType: "video", targetId: videoId }, orderBy: { createdAt: "desc" } });
}

export async function extractVideo(videoId: string): Promise<{ output: VideoExtraction; cached: boolean }> {
  assertPolicy("derived-data");
  const { content, contentHash } = await videoContent(videoId);
  const hit = await db.aiExtraction.findUnique({ where: { targetType_targetId_contentHash: { targetType: "video", targetId: videoId, contentHash } } });
  if (hit) return { output: hit.output as unknown as VideoExtraction, cached: true };
  const r = await structured(
    VideoExtraction,
    "You analyze YouTube video metadata and transcripts for a research tool. Extract only what the content supports. Topics are short lowercase noun phrases (no channel names, no generic words like 'video').",
    content,
  );
  await db.aiExtraction.create({
    data: { targetType: "video", targetId: videoId, contentHash, model: env.ANTHROPIC_MODEL, output: r.data as unknown as Prisma.InputJsonValue, tokensIn: r.tokensIn, tokensOut: r.tokensOut },
  });
  log().info({ videoId, tokens: r.tokensIn + r.tokensOut }, "AI extraction stored");
  return { output: r.data, cached: false };
}

// ── Niche re-rank ──────────────────────────────────────────────────────────

export const NicheRerank = z.object({
  slug: z.string().describe("The chosen subniche slug, exactly as given in the candidate list."),
  confidence: z.number().describe("0..1"),
  rationale: z.string().describe("One sentence explaining the choice."),
});

export async function rerankNiche(channel: { title: string; description: string; keywords: string[]; recentTitles: string[] }, candidates: { slug: string; name: string; description: string }[]) {
  const r = await structured(
    NicheRerank,
    "You classify YouTube channels into a fixed taxonomy of subniches. Pick the single best subniche from the candidate list.",
    `Channel: ${channel.title}\nKeywords: ${channel.keywords.join(", ")}\nDescription: ${channel.description.slice(0, 1500)}\nRecent titles:\n- ${channel.recentTitles.slice(0, 15).join("\n- ")}\n\nCandidates:\n${candidates.map((c) => `- ${c.slug}: ${c.name} — ${c.description}`).join("\n")}`,
    800,
  );
  if (!candidates.some((c) => c.slug === r.data.slug)) return null;
  return { ...r.data, confidence: Math.max(0, Math.min(1, r.data.confidence)) };
}
