/**
 * pnpm propose --as <email> --channels UC…,UC… [--max 200] [--no-transcripts] [--title "…"] --reason "…"
 *
 * Files an ADD_CHANNELS proposal on behalf of a user, as an AGENT (source CLAUDE). It can only create a PENDING
 * proposal — the user must review and approve it in Atlas (Data page). Agents can never approve (services/expansion).
 * Prints the proposal id, scope hash and server-side estimate.
 */
import "dotenv/config";

const { db } = await import("@/server/db");
const { redis } = await import("@/server/redis");
const { createProposal, toDTO } = await import("@/server/services/expansion");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
try {
  const email = arg("as");
  const channels = (arg("channels") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const reason = arg("reason");
  if (!email || !channels.length || !reason) {
    console.error('usage: pnpm propose --as <email> --channels UC…,UC… [--max 200] [--title "…"] --reason "…"');
    process.exit(2);
  }
  const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const actor = { kind: "agent" as const, userId: user.id };
  const p = await createProposal(
    {
      scope: { kind: "ADD_CHANNELS", channels: channels.map((youtubeId) => ({ youtubeId, aliases: [] })), maxVideosPerChannel: Number(arg("max") ?? 200), includeTranscripts: !process.argv.includes("--no-transcripts") },
      reason,
      title: arg("title"),
      coverageGap: arg("gap"),
    },
    actor,
  );
  const d = toDTO(p, actor);
  console.log(JSON.stringify({ id: d.id, status: d.status, source: d.source, title: d.title, scopeHash: d.scopeHash, estimate: d.estimate, expiresAt: d.expiresAt }, null, 2));
  console.log(`\nPending — approve it in Atlas: /data (signed in as ${email}).`);
} finally {
  await redis.quit();
  await db.$disconnect();
}
