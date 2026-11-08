import { QUOTA_TIMEZONE } from "@/server/youtube/costs";

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: QUOTA_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: QUOTA_TIMEZONE, hour: "numeric", hourCycle: "h23" });

/** Quota day key in Pacific Time, e.g. "2026-11-08". */
export function quotaDay(at: Date = new Date()): string {
  return dayFmt.format(at);
}

/** Next midnight America/Los_Angeles after `at` (handles PST/PDT and DST transitions). */
export function nextResetAt(at: Date = new Date()): Date {
  const [y, m, d] = quotaDay(at).split("-").map(Number) as [number, number, number];
  // Midnight PST is 08:00 UTC, midnight PDT is 07:00 UTC. Try both; keep the one that is LA midnight.
  for (const utcHour of [7, 8]) {
    const candidate = new Date(Date.UTC(y, m - 1, d + 1, utcHour));
    if (Number(hourFmt.format(candidate)) === 0 && quotaDay(candidate) !== quotaDay(at)) return candidate;
  }
  return new Date(Date.UTC(y, m - 1, d + 1, 8));
}

export function secondsUntilReset(at: Date = new Date()): number {
  return Math.max(1, Math.ceil((nextResetAt(at).getTime() - at.getTime()) / 1000));
}
