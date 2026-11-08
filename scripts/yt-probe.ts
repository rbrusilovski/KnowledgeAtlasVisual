/**
 * Resolve a channel input and print what the API returns + the quota it cost.
 *   pnpm yt:probe @handle | https://youtube.com/@handle | UC… | video URL | /c/custom [--confirm]
 */
import "dotenv/config";
import { env } from "@/server/env";
import { redis } from "@/server/redis";
import { db } from "@/server/db";
import { youtube, withYouTubeContext } from "@/server/youtube";
import { resolveChannelInput } from "@/server/youtube/resolve";
import { usage } from "@/server/services/quota";

async function main() {
  const input = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!input) {
    console.error("usage: pnpm yt:probe <url|@handle|UC…> [--confirm]");
    process.exit(2);
  }
  const spent: { method: string; bucket: string; units: number }[] = [];
  const result = await withYouTubeContext(
    { lane: "interactive", noCache: true, onCost: (method, bucket, units) => spent.push({ method, bucket, units }) },
    async () => {
      const r = await resolveChannelInput(input, { confirmSearch: process.argv.includes("--confirm") });
      if (r.status !== "resolved") return { resolution: r };
      const [channel] = await youtube.getChannels({ ids: [r.youtubeId] });
      return { resolution: r, channel };
    },
  );
  console.log(`mode: ${env.YOUTUBE_MODE}`);
  console.log("resolution:", result.resolution);
  if ("channel" in result && result.channel) {
    const c = result.channel;
    console.log(`channel: ${c.snippet?.title} (${c.id}) ${c.snippet?.customUrl ?? ""}`);
    console.log(`  subscribers=${c.statistics?.subscriberCount ?? "?"} videos=${c.statistics?.videoCount ?? "?"} uploads=${c.contentDetails?.relatedPlaylists?.uploads}`);
  }
  const total = spent.reduce<Record<string, number>>((a, s) => ((a[s.bucket] = (a[s.bucket] ?? 0) + s.units), a), {});
  console.log("cost:", spent.length ? spent.map((s) => `${s.method}=${s.units}(${s.bucket})`).join(", ") : "0 (cached/alias)", total);
  const u = await usage();
  console.log("quota today:", u.buckets.map((b) => `${b.bucket} ${b.used}/${b.limit}`).join(" · "), `resets ${u.resetAt}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redis.quit();
    await db.$disconnect();
  });
