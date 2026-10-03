import {
  SEED_ADMIN_EMAIL,
  SEED_CHECKOUT_FLAG_KEY,
  SEED_DEV_SERVER_KEY,
  SEED_IDS,
} from "@udp/db/seed-constants";
import { beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE, SAMPLE_NAMESPACE } from "../src/cluster.js";
import {
  api,
  eventually,
  FLAG_SERVICE,
  login,
  openStream,
  PORTAL,
  promQuery,
  type Session,
} from "./support.js";

/**
 * **E2E rút gọn** của §13.5 (Plan #50) — chạy trên cụm do `pnpm deploy:up` dựng, ở job `kind` của CI:
 *
 *   pnpm --filter @udp/deploy e2e
 *
 * Mỗi kiểm tra là một đường mà chỉ cụm THẬT mới lộ lỗi: nginx phục vụ SPA và proxy `/api`; cookie + CSRF đi
 * qua proxy; khoá tạo bằng API thật dùng được ở Service 2; lan truyền cấu hình S1 → S2 → SDK (Luồng 4) trên
 * NOTIFY thật; Prometheus trong cụm thấy workload với nhãn `namespace` mà dữ liệu seed trỏ tới (§7.4).
 */

let session: Session;
let devEnvId: string;

beforeAll(async () => {
  session = await login();
  const { body } = await api<{ environments: { id: string; name: string }[] }>(
    session,
    "GET",
    `/projects/${SEED_IDS.project}/environments`,
  );
  const dev = body.environments.find((e) => e.name === "dev");
  if (dev === undefined) throw new Error("project seed không có env dev");
  devEnvId = dev.id;
});

describe("Portal (nginx)", () => {
  it("phục vụ SPA ở gốc và ở một đường sâu (try_files về index.html)", async () => {
    for (const path of ["/", `/projects/${SEED_IDS.project}`]) {
      const res = await fetch(`${PORTAL}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(await res.text(), path).toContain('id="root"');
    }
  });

  it("đăng nhập QUA proxy /api: phiên đọc được project seed", async () => {
    const { status, body } = await api<{ projects: { id: string }[] }>(
      session,
      "GET",
      "/projects",
    );
    expect(status).toBe(200);
    expect(body.projects.map((p) => p.id)).toContain(SEED_IDS.project);
  });
});

describe("Service 2 (SDK, OFREP)", () => {
  it("SERVER key của seed đọc /sdk/config của env dev", async () => {
    const res = await fetch(`${FLAG_SERVICE}/sdk/config`, {
      headers: { Authorization: `Bearer ${SEED_DEV_SERVER_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      environment: string;
      configVersion: number;
      flags: { key: string }[];
    };
    expect(body.environment).toBe("dev");
    expect(body.flags.map((f) => f.key)).toContain(SEED_CHECKOUT_FLAG_KEY);
  });

  it("khoá CLIENT tạo bằng API thật đánh giá được qua OFREP, rồi thu hồi", async () => {
    const created = await api<{ key: { id: string }; secretKey: string }>(
      session,
      "POST",
      `/projects/${SEED_IDS.project}/environments/${devEnvId}/keys`,
      { keyType: "CLIENT", label: "e2e-cluster" },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    try {
      const res = await fetch(
        `${FLAG_SERVICE}/ofrep/v1/evaluate/flags/${SEED_CHECKOUT_FLAG_KEY}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${created.body.secretKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ context: { targetingKey: "e2e-user" } }),
        },
      );
      expect(res.status).toBe(200);
      const evaluation = (await res.json()) as { key: string; value: unknown };
      expect(evaluation.key).toBe(SEED_CHECKOUT_FLAG_KEY);
      expect(typeof evaluation.value).toBe("boolean");
    } finally {
      const revoked = await api(
        session,
        "DELETE",
        `/projects/${SEED_IDS.project}/environments/${devEnvId}/keys/${created.body.key.id}`,
      );
      expect(revoked.status).toBe(200);
    }
  });
});

describe("Luồng 4 — bật/tắt ở Portal tới SDK", () => {
  it("đổi trạng thái flag ⇒ stream SSE của SDK nhận event mới và /sdk/config phản ánh nó", async () => {
    const flagPath = `/projects/${SEED_IDS.project}/flags/${SEED_IDS.flagDarkMode}`;
    const envs = await api<{
      envs: { environment: { id: string }; isEnabled: boolean }[];
    }>(session, "GET", `${flagPath}/envs`);
    const before = envs.body.envs.find((e) => e.environment.id === devEnvId);
    if (before === undefined)
      throw new Error("flag seed không có cấu hình dev");
    const flag = await api<{ flag: { key: string } }>(session, "GET", flagPath);
    const flagKey = flag.body.flag.key;

    const stream = openStream(SEED_DEV_SERVER_KEY);
    try {
      expect(await stream.status).toBe(200);
      const first = await stream.waitFor((e) => e.id !== undefined, 10_000);
      const toggled = await api(
        session,
        "PATCH",
        `${flagPath}/envs/${devEnvId}`,
        {
          isEnabled: !before.isEnabled,
        },
      );
      expect(toggled.status, JSON.stringify(toggled.body)).toBe(200);
      try {
        // Hàng đợi NOTIFY bật trong cụm (ConfigMap) — lan truyền dưới vài giây; 15 s là trần rộng cho runner
        await stream.waitFor((e) => (e.id ?? 0) > (first.id ?? 0), 15_000);
        const res = await fetch(`${FLAG_SERVICE}/sdk/config`, {
          headers: { Authorization: `Bearer ${SEED_DEV_SERVER_KEY}` },
        });
        const body = (await res.json()) as {
          flags: { key: string; isEnabled?: boolean }[];
        };
        expect(body.flags.find((f) => f.key === flagKey)?.isEnabled).toBe(
          !before.isEnabled,
        );
      } finally {
        const restored = await api(
          session,
          "PATCH",
          `${flagPath}/envs/${devEnvId}`,
          { isEnabled: before.isEnabled },
        );
        expect(restored.status).toBe(200);
      }
    } finally {
      stream.close();
    }
  });
});

describe("Bảng điều khiển nền tảng trên cụm thật (Plan #53 QĐ-6)", () => {
  it("ServiceAccount chỉ-đọc của Service 1 đọc được cụm; thứ kind không có thì nói đúng lý do, không FORBIDDEN", async () => {
    const admin = await login(SEED_ADMIN_EMAIL);
    const res = await api<{
      platform: {
        release: string | null;
        node: { state: string; reason?: string };
        postgresVolume: { state: string; capacityBytes?: number };
        backup: { state: string; reason?: string };
        certificate: { state: string; reason?: string };
      };
    }>(admin, "GET", "/admin/platform");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.platform;
    expect(p.release).toBe("local");
    // PVC của PostgreSQL: RBAC `persistentvolumeclaims get` hoạt động trên API server thật
    expect(p.postgresVolume.state).toBe("ok");
    // kind: không metrics-server, không cert-manager, không CronJob sao lưu (chúng là của máy ảo)
    const notConfigured = { state: "unavailable", reason: "NOT_CONFIGURED" };
    expect(p.node).toEqual(notConfigured);
    expect(p.certificate).toEqual(notConfigured);
    expect(p.backup).toEqual(notConfigured);
  });
});

describe("Prometheus trong cụm", () => {
  it("scrape sample-app với nhãn namespace của env dev seed (§7.4)", async () => {
    const up = await eventually(
      () =>
        promQuery(NAMESPACE, `up{namespace="${SAMPLE_NAMESPACE}"}`).find(
          (r) => r.value[1] === "1",
        ),
      120_000,
      `target sample-app ở ${SAMPLE_NAMESPACE}`,
    );
    expect(up.metric["namespace"]).toBe(SAMPLE_NAMESPACE);
  });
});
