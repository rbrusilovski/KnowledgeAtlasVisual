import type { NextRequest } from "next/server";
import { getSessionUser } from "@/server/session";
import { channelFor, replaySince, subscribe, type DeliveredEvent } from "@/server/services/realtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;

/** Server-Sent Events: global + the signed-in user's channel. Supports Last-Event-ID replay. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req.headers);
  const channels = [channelFor("global"), ...(user ? [channelFor({ userId: user.id })] : [])];
  const lastId = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("lastEventId");
  const enc = new TextEncoder();

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const frame = (e: DeliveredEvent) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.payload, channel: e.channel.startsWith("events:user") ? "user" : "global" })}\n\n`;

      send(`retry: 3000\n: connected ${new Date().toISOString()}\n\n`);
      const buffered: DeliveredEvent[] = [];
      let replaying = Boolean(lastId);
      const unsubscribe = subscribe(channels, (e) => (replaying ? buffered.push(e) : send(frame(e))));
      if (lastId && /^\d+-\d+$/.test(lastId)) {
        const missed = await replaySince(channels, lastId).catch(() => []);
        const seen = new Set<string>();
        for (const e of missed) {
          seen.add(e.id);
          send(frame(e));
        }
        replaying = false;
        for (const e of buffered) if (!seen.has(e.id)) send(frame(e));
      }
      replaying = false;
      const hb = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
