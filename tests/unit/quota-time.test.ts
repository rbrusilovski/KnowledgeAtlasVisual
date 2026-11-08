import { describe, expect, it } from "vitest";
import { quotaDay, nextResetAt, secondsUntilReset } from "@/server/services/quota";

describe("quota date math (America/Los_Angeles)", () => {
  it("uses the Pacific calendar day, not UTC", () => {
    // 2026-11-09 05:00 UTC is still Nov 8 in LA (PST, UTC-8)
    expect(quotaDay(new Date("2026-11-09T05:00:00Z"))).toBe("2026-11-08");
    expect(quotaDay(new Date("2026-11-09T08:00:00Z"))).toBe("2026-11-09");
  });

  it("resets at midnight PST (08:00 UTC) in winter", () => {
    expect(nextResetAt(new Date("2026-12-01T20:00:00Z")).toISOString()).toBe("2026-12-02T08:00:00.000Z");
  });

  it("resets at midnight PDT (07:00 UTC) in summer", () => {
    expect(nextResetAt(new Date("2026-07-01T20:00:00Z")).toISOString()).toBe("2026-07-02T07:00:00.000Z");
  });

  it("handles the DST fall-back day (Nov 1 2026)", () => {
    // Oct 31 23:30 PDT → next midnight is Nov 1 00:00 PDT = 07:00 UTC
    expect(nextResetAt(new Date("2026-11-01T06:30:00Z")).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    // Nov 1 12:00 PST → next midnight is Nov 2 00:00 PST = 08:00 UTC
    expect(nextResetAt(new Date("2026-11-01T20:00:00Z")).toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("handles the DST spring-forward day (Mar 8 2026)", () => {
    expect(nextResetAt(new Date("2026-03-08T12:00:00Z")).toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("just after midnight resets the following midnight", () => {
    expect(nextResetAt(new Date("2026-12-02T08:00:01Z")).toISOString()).toBe("2026-12-03T08:00:00.000Z");
  });

  it("seconds until reset is positive", () => {
    expect(secondsUntilReset(new Date("2026-12-02T07:59:59Z"))).toBe(1);
  });
});
