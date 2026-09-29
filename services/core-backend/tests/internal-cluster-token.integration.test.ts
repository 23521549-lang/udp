import { randomUUID } from "node:crypto";
import { env, INTERNAL_SECRET_HEADER } from "@udp/config";
import { internalClusterTokenResponseWire } from "@udp/shared-types/wire";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { PhaseFailedError } from "../src/jobs/job-kit.js";
import type { ClusterTokenIssuer } from "../src/modules/cluster/cluster-token.js";
import {
  inertCloudPlatform,
  inertProvisioning,
  noDomainAdapters,
  noRepoSource,
  outsidePlatform,
} from "./helpers/inert-deps.js";

/**
 * `POST /internal/clusters/:id/token` (ADR-06, §9) [Plan #51 AC-2] — luật của route, trên một nguồn token tiêm vào:
 * chỉ `traffic` (§12.2, T12), hạn ≤ 1 giờ (I24c), lỗi gốc không đi ra ngoài (I12). Đường thật tới cluster
 * (`projectClusterToken`) có test ở `provision-job.integration.test.ts`.
 */

const HOUR_MS = 3_600_000;
const PROJECT = randomUUID();

function appWith(clusterToken: ClusterTokenIssuer | null) {
  return createApp({
    metricsFor: () => {
      throw new Error("test này không đo");
    },
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    repoSource: noRepoSource,
    platform: outsidePlatform,
    domainRegistry: noDomainAdapters,
    provisioning: { ...inertProvisioning, clusterToken },
  });
}

const call = (
  app: ReturnType<typeof createApp>,
  serviceAccount: string,
  id: string = PROJECT,
) =>
  request(app)
    .post(`/internal/clusters/${id}/token`)
    .set(INTERNAL_SECRET_HEADER, env.INTERNAL_SERVICE_SECRET)
    .send({ serviceAccount });

describe("POST /internal/clusters/:id/token", () => {
  it("cấp token của udp-traffic: đúng project, đúng identity, đúng hình", async () => {
    const asked: [string, string][] = [];
    const app = appWith((projectId, identity) => {
      asked.push([projectId, identity]);
      return Promise.resolve({
        apiEndpoint: "https://cluster.vi-du.test",
        caData: "Q0EtREFUQQ==",
        token: "bound-traffic",
        expiresAt: new Date(Date.now() + 30 * 60_000),
      });
    });
    const res = await call(app, "traffic").expect(200);
    expect(internalClusterTokenResponseWire.parse(res.body)).toMatchObject({
      apiEndpoint: "https://cluster.vi-du.test",
      token: "bound-traffic",
    });
    expect(asked).toEqual([[PROJECT, "traffic"]]);
  });

  it("I24(c): cluster cấp token sống 2 giờ ⇒ hạn trả về vẫn ≤ 1 giờ", async () => {
    const app = appWith(() =>
      Promise.resolve({
        apiEndpoint: "https://cluster.vi-du.test",
        caData: "Q0E=",
        token: "t",
        expiresAt: new Date(Date.now() + 2 * HOUR_MS),
      }),
    );
    const before = Date.now();
    const res = await call(app, "traffic").expect(200);
    const expiresAt = Date.parse((res.body as { expiresAt: string }).expiresAt);
    expect(expiresAt - before).toBeLessThanOrEqual(HOUR_MS + 1_000);
  });

  it("workload và tooling bị từ chối với MỌI bên gọi — S1 không phân biệt được S2 với S3 (§12.2, T12)", async () => {
    let asked = 0;
    const app = appWith(() => {
      asked += 1;
      return Promise.reject(new Error("không được gọi"));
    });
    for (const serviceAccount of ["workload", "tooling"]) {
      await call(app, serviceAccount).expect(403);
    }
    expect(asked).toBe(0);
  });

  it("không bí mật nội bộ ⇒ 401; id không phải uuid ⇒ 400; tiến trình không có worker ⇒ 503", async () => {
    const app = appWith(null);
    await request(app)
      .post(`/internal/clusters/${PROJECT}/token`)
      .send({ serviceAccount: "traffic" })
      .expect(401);
    await call(app, "traffic", "khong-phai-uuid").expect(400);
    await call(app, "traffic").expect(503);
  });

  it("project chưa có cluster ⇒ 404; lỗi cloud ⇒ 503 và thông điệp gốc không đi ra", async () => {
    await call(
      appWith(() =>
        Promise.reject(new PhaseFailedError("project chưa có cluster")),
      ),
      "traffic",
    ).expect(404);
    const res = await call(
      appWith(() =>
        Promise.reject(new Error("AKIAIOSFODNN7EXAMPLE bị từ chối")),
      ),
      "traffic",
    ).expect(503);
    expect(JSON.stringify(res.body)).not.toContain("AKIA");
  });
});
