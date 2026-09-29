import type { KubeTransport } from "@udp/cluster-access";
import { describe, expect, it } from "vitest";
import {
  inClusterPlatformProbe,
  parseQuantity,
  platformProbeFromEnv,
  PLATFORM_OBJECTS,
} from "../src/core/platform-probe.js";

/**
 * [Plan #53 QĐ-6] Tín hiệu của cụm đang chạy UDP: số lượng Kubernetes đọc đúng đơn vị, mỗi tín hiệu
 * độc lập, và mọi lý do "không đọc được" nói đúng tên — không bao giờ một con số đoán.
 */

const NS = "udp";
const routes = (
  table: Record<string, { status: number; body?: unknown } | "network">,
): { transport: KubeTransport; asked: string[]; auth: string[] } => {
  const asked: string[] = [];
  const auth: string[] = [];
  return {
    asked,
    auth,
    transport: {
      request(url, init) {
        const path = new URL(url).pathname;
        asked.push(path);
        auth.push(new Headers(init.headers).get("Authorization") ?? "");
        const hit = table[path];
        if (hit === "network") return Promise.reject(new Error("ECONNRESET"));
        if (hit === undefined)
          return Promise.resolve(new Response("", { status: 404 }));
        return Promise.resolve(
          Response.json(hit.body ?? {}, { status: hit.status }),
        );
      },
    },
  };
};

const probeWith = (transport: KubeTransport) =>
  inClusterPlatformProbe({
    apiServer: "https://10.43.0.1:443",
    namespace: NS,
    transport,
    token: () => Promise.resolve("sa-token"),
  });

const VM = {
  "/api/v1/nodes": {
    status: 200,
    body: {
      items: [
        {
          metadata: { name: "udp-vm" },
          status: { capacity: { cpu: "2", memory: "12249876Ki" } },
        },
      ],
    },
  },
  "/apis/metrics.k8s.io/v1beta1/nodes": {
    status: 200,
    body: { items: [{ usage: { cpu: "463127915n", memory: "4816000Ki" } }] },
  },
  [`/api/v1/namespaces/${NS}/persistentvolumeclaims/${PLATFORM_OBJECTS.postgresPvc}`]:
    {
      status: 200,
      body: { status: { capacity: { storage: "20Gi" } } },
    },
  [`/apis/batch/v1/namespaces/${NS}/cronjobs/${PLATFORM_OBJECTS.backupCronJob}`]:
    {
      status: 200,
      body: {
        spec: { schedule: "30 19 * * *" },
        status: {
          lastScheduleTime: "2026-09-29T19:30:00Z",
          lastSuccessfulTime: "2026-09-29T19:30:42Z",
        },
      },
    },
  [`/apis/batch/v1/namespaces/${NS}/jobs`]: {
    status: 200,
    body: {
      items: [
        {
          metadata: {
            ownerReferences: [{ kind: "CronJob", name: "udp-backup" }],
          },
          status: {
            conditions: [
              {
                type: "Failed",
                status: "True",
                lastTransitionTime: "2026-09-27T19:31:05Z",
              },
            ],
          },
        },
        {
          // Job của CronJob khác: không tính
          metadata: { ownerReferences: [{ kind: "CronJob", name: "khac" }] },
          status: {
            conditions: [
              {
                type: "Failed",
                status: "True",
                lastTransitionTime: "2026-09-29T00:00:00Z",
              },
            ],
          },
        },
      ],
    },
  },
  [`/apis/cert-manager.io/v1/namespaces/${NS}/certificates/${PLATFORM_OBJECTS.certificate}`]:
    {
      status: 200,
      body: {
        spec: { issuerRef: { name: "udp-letsencrypt" } },
        status: {
          notAfter: "2026-11-22T08:00:00Z",
          conditions: [{ type: "Ready", status: "True" }],
        },
      },
    },
} as const;

describe("số lượng Kubernetes", () => {
  it("lõi, mili-lõi, nano-lõi; byte nhị phân và thập phân", () => {
    expect(parseQuantity("2")).toBe(2);
    expect(parseQuantity("1500m")).toBe(1.5);
    expect(parseQuantity("463127915n")).toBeCloseTo(0.463, 3);
    expect(parseQuantity("12Gi")).toBe(12 * 1024 ** 3);
    expect(parseQuantity("4816000Ki")).toBe(4_816_000 * 1024);
    expect(parseQuantity("20G")).toBe(20e9);
    expect(parseQuantity("hỏng")).toBeNaN();
    expect(parseQuantity("3Qi")).toBeNaN();
  });
});

describe("probe trong cụm", () => {
  it("máy ảo đủ tín hiệu: node cộng số đo, PVC, sao lưu (kể cả lần hỏng gần nhất CỦA CronJob đó), chứng chỉ", async () => {
    const { transport, auth } = routes(VM);
    const s = await probeWith(transport).read();
    expect(s.node).toEqual({
      state: "ok",
      name: "udp-vm",
      cpuCores: 2,
      cpuUsedCores: 0.463,
      memoryBytes: 12_249_876 * 1024,
      memoryUsedBytes: 4_816_000 * 1024,
    });
    expect(s.postgresVolume).toEqual({
      state: "ok",
      capacityBytes: 20 * 1024 ** 3,
    });
    expect(s.backup).toEqual({
      state: "ok",
      schedule: "30 19 * * *",
      lastScheduleAt: "2026-09-29T19:30:00.000Z",
      lastSuccessAt: "2026-09-29T19:30:42.000Z",
      lastFailureAt: "2026-09-27T19:31:05.000Z",
    });
    expect(s.certificate).toEqual({
      state: "ok",
      name: "udp-tls",
      ready: true,
      notAfter: "2026-11-22T08:00:00.000Z",
      issuer: "udp-letsencrypt",
    });
    expect(new Set(auth)).toEqual(new Set(["Bearer sa-token"]));
  });

  it("kind: không metrics-server, không cert-manager, không CronJob ⇒ NOT_CONFIGURED cho đúng tín hiệu đó", async () => {
    const kind = { ...VM } as Record<
      string,
      { status: number; body?: unknown }
    >;
    delete kind["/apis/metrics.k8s.io/v1beta1/nodes"];
    delete kind[
      `/apis/cert-manager.io/v1/namespaces/${NS}/certificates/${PLATFORM_OBJECTS.certificate}`
    ];
    delete kind[
      `/apis/batch/v1/namespaces/${NS}/cronjobs/${PLATFORM_OBJECTS.backupCronJob}`
    ];
    const s = await probeWith(routes(kind).transport).read();
    expect(s.node).toEqual({ state: "unavailable", reason: "NOT_CONFIGURED" });
    expect(s.certificate).toEqual({
      state: "unavailable",
      reason: "NOT_CONFIGURED",
    });
    expect(s.backup).toEqual({
      state: "unavailable",
      reason: "NOT_CONFIGURED",
    });
    // Tín hiệu còn lại vẫn đọc được — một cái vắng không kéo cái khác theo
    expect(s.postgresVolume.state).toBe("ok");
  });

  it("RBAC thiếu ⇒ FORBIDDEN; mạng hỏng ⇒ UNAVAILABLE", async () => {
    const forbidden = { ...VM } as Record<
      string,
      { status: number; body?: unknown } | "network"
    >;
    forbidden["/api/v1/nodes"] = { status: 403 };
    forbidden[
      `/api/v1/namespaces/${NS}/persistentvolumeclaims/${PLATFORM_OBJECTS.postgresPvc}`
    ] = "network";
    const s = await probeWith(routes(forbidden).transport).read();
    expect(s.node).toEqual({ state: "unavailable", reason: "FORBIDDEN" });
    expect(s.postgresVolume).toEqual({
      state: "unavailable",
      reason: "UNAVAILABLE",
    });
  });

  it("ngoài pod (không KUBERNETES_SERVICE_HOST) ⇒ mọi tín hiệu NOT_IN_CLUSTER", async () => {
    const probe = await platformProbeFromEnv({});
    const s = await probe.read();
    expect(Object.values(s)).toEqual(
      Array.from({ length: 4 }, () => ({
        state: "unavailable",
        reason: "NOT_IN_CLUSTER",
      })),
    );
  });
});
