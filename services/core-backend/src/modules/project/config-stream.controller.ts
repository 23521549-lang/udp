import { Router } from "express";
import { prisma } from "../../core/db.js";
import { requireAuth } from "../../core/http/middlewares/auth.middleware.js";
import {
  projectIdParam,
  requireMinProjectRole,
} from "../../core/http/middlewares/project-role.middleware.js";
import {
  CONFIG_STREAM_TIMING,
  createConfigVersionHub,
} from "./config-version-hub.js";

/**
 * `GET /projects/:id/stream` (Plan #41 QĐ-1, §10.14): SSE cho Portal — `flag_changed`
 * `{ environmentId, configVersion }` khi cấu hình của một environment đổi, `ready` ngay khi mở
 * (Portal làm mới sau một lần nối lại: sự kiện trong lúc đứt không được phát lại), `heartbeat` sau
 * `heartbeatMs` để proxy không cắt kết nối im lặng. Portal CHỈ `invalidateQueries` khi nhận.
 *
 * Một hub cho cả tiến trình: mỗi vòng MỘT câu truy vấn cho mọi project đang có luồng mở.
 */
export const configStreamRouter: Router = Router({ mergeParams: true });

const hub = createConfigVersionHub({
  read: async (projectIds) =>
    (
      await prisma.environment.findMany({
        where: { projectId: { in: [...projectIds] } },
        select: { id: true, projectId: true, configVersion: true },
      })
    ).map((e) => ({
      projectId: e.projectId,
      environmentId: e.id,
      configVersion: e.configVersion,
    })),
});

configStreamRouter.get(
  "/stream",
  requireAuth,
  requireMinProjectRole("VIEWER"),
  (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let lastSentAt = Date.now();
    const send = (event: string, data: string) => {
      res.write(`event: ${event}\ndata: ${data}\n\n`);
      lastSentAt = Date.now();
    };
    send("ready", "{}");
    const unsubscribe = hub.subscribe(projectIdParam(req), (change) => {
      send("flag_changed", JSON.stringify(change));
    });
    const heartbeat = setInterval(() => {
      if (Date.now() - lastSentAt >= CONFIG_STREAM_TIMING.heartbeatMs) {
        send("heartbeat", "{}");
      }
    }, CONFIG_STREAM_TIMING.heartbeatMs);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  },
);
