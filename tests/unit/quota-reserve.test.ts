import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { redis, key } from "@/server/redis";
import { reserve, canSpend, markExhausted, usage, reserveUserDiscovery } from "@/server/services/quota";
import { costOf } from "@/server/youtube/costs";

async function clear() {
  const keys = await redis.keys(key("quota", "*"));
  if (keys.length) await redis.del(...keys);
}

describe("quota reserve (Redis, Lua)", () => {
  beforeEach(clear);
  afterAll(async () => {
    await clear();
    await redis.quit();
  });

  it("increments atomically and reports usage", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve("general", 5, "interactive")));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await usage()).buckets.find((b) => b.bucket === "general")!.used).toBe(100);
  });

  it("denies background lane past QUOTA_BACKGROUND_RATIO but allows interactive", async () => {
    // limit 10000 × 0.6 = 6000
    expect((await reserve("general", 5999, "background")).ok).toBe(true);
    const bg = await reserve("general", 2, "background");
    expect(bg).toMatchObject({ ok: false, reason: "background_budget" });
    expect((await reserve("general", 2, "interactive")).ok).toBe(true);
    expect(await canSpend("general", 1, "background")).toBe(false);
    expect(await canSpend("general", 1, "interactive")).toBe(true);
  });

  it("denies when the bucket is full; search bucket is separate (100 calls)", async () => {
    for (let i = 0; i < 100; i++) expect((await reserve("search", 1, "interactive")).ok).toBe(true);
    expect(await reserve("search", 1, "interactive")).toMatchObject({ ok: false, reason: "exhausted" });
    expect((await reserve("general", 1, "interactive")).ok).toBe(true);
  });

  it("marks a bucket exhausted on a real quotaExceeded", async () => {
    const resetAt = await markExhausted("general");
    expect(resetAt.getTime()).toBeGreaterThan(Date.now());
    expect(await reserve("general", 1, "interactive")).toMatchObject({ ok: false, reason: "exhausted" });
  });

  it("caps discovery searches per user", async () => {
    for (let i = 0; i < 20; i++) await reserveUserDiscovery("u1", 1);
    await expect(reserveUserDiscovery("u1", 1)).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    await expect(reserveUserDiscovery("u2", 1)).resolves.toMatchObject({ used: 1 });
  });

  it("supports both search cost models", () => {
    expect(costOf("search.list", "bucket")).toEqual({ bucket: "search", units: 1 });
    expect(costOf("search.list", "shared")).toEqual({ bucket: "general", units: 100 });
    expect(costOf("captions.list")).toEqual({ bucket: "general", units: 50 });
    expect(costOf("playlistItems.list")).toEqual({ bucket: "general", units: 1 });
  });
});
