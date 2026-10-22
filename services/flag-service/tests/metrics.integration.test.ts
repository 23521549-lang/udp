import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { issueSdkKey, stableOwner } from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { incrementCounter } from "../src/changefeed/metrics.js";

/**
 * `/metrics` của Service 2 [v4.8] — các bộ đếm mà E4 báo cáo phải đo ĐÚNG thứ
 * định nghĩa của chúng nói (§14): truy vấn Prisma, byte `/sdk/config` 200 (304
 * không có body), byte SSE theo loại khối; hai bộ đếm ADR-05 phản chiếu sang
 * Prometheus.
 */

const app = createApp();
const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 2,
  cacheKey: `__udp_prisma_s2metrics_${randomUUID()}`,
});

let server: Server | undefined;
let base = "";
let projectId: string | undefined;
let serverKey = "";

async function counter(name: string, labels = ""): Promise<number> {
  const text = (await request(app).get("/metrics").expect(200)).text;
  const line = text.split("\n").find((l) => l.startsWith(`${name}${labels} `));
  if (line === undefined) throw new Error(`thiếu ${name}${labels}`);
  return Number(line.split(" ")[1]);
}

beforeAll(async () => {
  const listening = app.listen(0);
  server = listening;
  await new Promise<void>((r) => listening.once("listening", r));
  base = `http://127.0.0.1:${String((listening.address() as AddressInfo).port)}`;
  const owner = await stableOwner(admin);
  const suffix = randomUUID().slice(0, 8);
  const project = await admin.project.create({
    data: {
      ownerId: owner.id,
      name: `s2metrics-${suffix}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      resourceQuota: {},
      environments: {
        create: [{ name: "dev", rank: 0, k8sNamespace: `udp-s2m-${suffix}` }],
      },
    },
    select: { id: true, environments: { select: { id: true } } },
  });
  projectId = project.id;
  serverKey = await issueSdkKey(admin, {
    environmentId: project.environments[0]?.id ?? "",
    keyType: "SERVER",
    createdById: owner.id,
  });
}, 60_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  if (projectId !== undefined) {
    await admin.project.delete({ where: { id: projectId } });
  }
  await admin.$disconnect();
});

describe("/metrics của Service 2", () => {
  it("đếm truy vấn Prisma của S2", async () => {
    const before = await counter("udp_flag_db_queries_total");
    await request(app).get("/readyz").expect(200);
    expect(await counter("udp_flag_db_queries_total")).toBeGreaterThan(before);
  });

  it("byte /sdk/config: 200 cộng đúng Content-Length, 304 không cộng", async () => {
    const before = await counter("udp_flag_sdk_config_bytes_total");
    const ok = await request(app)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${serverKey}`)
      .expect(200);
    const afterOk = await counter("udp_flag_sdk_config_bytes_total");
    expect(afterOk - before).toBe(Number(ok.headers["content-length"]));

    await request(app)
      .get("/sdk/config")
      .set("Authorization", `Bearer ${serverKey}`)
      .set("If-None-Match", ok.headers["etag"] as string)
      .expect(304);
    expect(await counter("udp_flag_sdk_config_bytes_total")).toBe(afterOk);
  });

  it("byte SSE theo loại khối: snapshot khi mở stream không con trỏ", async () => {
    const label = '{event="snapshot"}';
    const before = await counter("udp_flag_sse_bytes_total", label);
    const controller = new AbortController();
    const res = await fetch(`${base}/sdk/stream`, {
      headers: { Authorization: `Bearer ${serverKey}` },
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    let received = 0;
    // Đọc tới khi có một khối `event: snapshot` trọn vẹn
    let text = "";
    const complete = (): boolean => {
      const at = text.indexOf("event: snapshot");
      return at !== -1 && text.indexOf("\n\n", at) !== -1;
    };
    while (reader !== undefined && !complete()) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    const delta = (await counter("udp_flag_sse_bytes_total", label)) - before;
    expect(delta).toBeGreaterThan(0);
    // Khối retry đến trước snapshot trên cùng stream — byte nhận ≥ byte snapshot
    expect(received).toBeGreaterThanOrEqual(delta);
  });

  it("hai bộ đếm ADR-05 phản chiếu từ change feed", async () => {
    for (const name of [
      "changefeed_fallback_total",
      "changefeed_hash_mismatch_total",
    ] as const) {
      const before = await counter(name);
      incrementCounter(name);
      expect(await counter(name)).toBe(before + 1);
    }
  });
});
