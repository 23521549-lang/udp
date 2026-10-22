import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/**
 * Bề mặt HTTP vận hành của S3. `/readyz` là thứ Kubernetes hành động theo, nên
 * hợp đồng 503 khi đang tắt được kiểm ở đây; ca "pool chết" thì `dbErrorCode`
 * của `@udp/db` đã phủ, không dựng lại pool hỏng ở đây.
 */
describe("createApp", () => {
  it("/healthz sống mà không chạm database", async () => {
    const res = await request(createApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("/readyz 200 khi database lên, 503 ngay khi đang tắt", async () => {
    let shuttingDown = false;
    const app = createApp({ isShuttingDown: () => shuttingDown });
    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready", database: "up" });

    shuttingDown = true;
    const draining = await request(app).get("/readyz");
    expect(draining.status).toBe(503);
    expect(draining.body).toEqual({
      status: "not_ready",
      reason: "shutting_down",
    });
  });

  it("/metrics trả định dạng Prometheus với bộ đếm của S3", async () => {
    const res = await request(createApp()).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("udp_pd_sessions_in_flight");
    expect(res.text).toContain("udp_rollback_blocked_total");
  });
});
