import express from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { getQueue, QUEUES } from "@/server/jobs";
import { env } from "@/server/env";
import { baseLogger } from "@/server/logger";

export const BOARD_BASE_PATH = "/api/admin/queues";

/** bull-board on localhost only; the web app proxies /api/admin/queues for ADMIN users. */
export function startBoard() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BOARD_BASE_PATH);
  createBullBoard({
    queues: Object.values(QUEUES).map((n) => new BullMQAdapter(getQueue(n))),
    serverAdapter,
    options: { uiConfig: { boardTitle: "Atlas queues" } },
  });
  const app = express();
  app.use(BOARD_BASE_PATH, serverAdapter.getRouter());
  const server = app.listen(env.BULL_BOARD_PORT, "127.0.0.1", () => baseLogger.info({ port: env.BULL_BOARD_PORT }, "bull-board listening"));
  server.on("error", (err) => baseLogger.warn({ err }, "bull-board failed to start"));
  return server;
}
