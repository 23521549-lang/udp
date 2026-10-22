import { describe, expect, it } from "vitest";
import {
  ENVS,
  GIT,
  redSummary,
  SYSTEM_ZONES,
  systemLinks,
  USERS,
  type SystemLink,
} from "../src/features/architecture/system-model";

/**
 * Plan #57 QĐ-2/QĐ-3: vị trí của thành phần theo VAI TRÒ của domain, cạnh là vai trò (không phải lưu lượng đo) và
 * nối QUA domain chưa bật. Mỗi ô chặn một cách vẽ sai có thật: cạnh treo vào thẻ không có, chuỗi đứt khi thiếu một
 * mắt, domain không có chỗ trên sơ đồ.
 */

const ALL = Object.values(SYSTEM_ZONES).flat();
const present = (...domains: string[]) =>
  new Set([USERS, GIT, ENVS, ...domains]);
const pairs = (links: SystemLink[]) =>
  links.map((l) => `${l.from}>${l.to}:${l.kind}`);

describe("SYSTEM_ZONES", () => {
  it("mười sáu domain, mỗi domain đúng một vùng", () => {
    expect(ALL).toHaveLength(16);
    expect(new Set(ALL).size).toBe(16);
  });
});

describe("systemLinks", () => {
  it("đủ domain: lưu lượng users → Ingress → Service Mesh → environment, nét liền", () => {
    const links = systemLinks(present(...ALL));
    expect(pairs(links)).toEqual(
      expect.arrayContaining([
        "users>INGRESS:https",
        "INGRESS>SERVICE_MESH:route",
        "SERVICE_MESH>envs:mtls",
        "envs>DATABASE:sql",
      ]),
    );
    expect(
      links
        .filter((l) => l.kind === "https" || l.kind === "mtls")
        .every((l) => !l.dashed),
    ).toBe(true);
  });

  it("đủ domain: giao hàng git → CI/CD → Container Registry → GitOps → Progressive Delivery → environment, nét đứt", () => {
    const links = systemLinks(present(...ALL));
    expect(pairs(links)).toEqual(
      expect.arrayContaining([
        "git>CICD:webhook",
        "CICD>CONTAINER_REGISTRY:push",
        "CICD>ARTIFACT_REGISTRY:publish",
        "CONTAINER_REGISTRY>GITOPS:tag",
        "GITOPS>PROGRESSIVE_DELIVERY:sync",
        "PROGRESSIVE_DELIVERY>envs:canary",
      ]),
    );
    expect(links.filter((l) => l.kind === "sync").every((l) => l.dashed)).toBe(
      true,
    );
  });

  it("telemetry: environment tới TỪNG công cụ quan sát đang bật", () => {
    const links = systemLinks(present(...ALL));
    expect(pairs(links)).toEqual(
      expect.arrayContaining([
        "envs>MONITORING:metrics",
        "envs>LOGGING:logs",
        "envs>TRACING:traces",
      ]),
    );
    const only = pairs(systemLinks(present("LOGGING")));
    expect(only).toContain("envs>LOGGING:logs");
    expect(only.some((p) => p.includes("MONITORING"))).toBe(false);
  });

  it("vắng Service Mesh ⇒ Ingress nối thẳng environment; vắng cả hai ⇒ người dùng nối thẳng environment", () => {
    expect(pairs(systemLinks(present("INGRESS")))).toContain(
      "INGRESS>envs:route",
    );
    expect(pairs(systemLinks(present()))).toContain("users>envs:https");
  });

  it("giao hàng nối qua domain vắng, nhãn là vai trò của đầu đi", () => {
    const links = pairs(
      systemLinks(
        present("CICD", "CONTAINER_REGISTRY", "PROGRESSIVE_DELIVERY"),
      ),
    );
    expect(links).toContain("CONTAINER_REGISTRY>PROGRESSIVE_DELIVERY:tag");
    expect(links).toContain("PROGRESSIVE_DELIVERY>envs:canary");
    expect(pairs(systemLinks(present()))).toContain("git>envs:webhook");
  });

  it("không cạnh nào treo vào thành phần không có mặt", () => {
    for (const subset of [
      present(),
      present("INGRESS", "DATABASE"),
      present("ARTIFACT_REGISTRY", "TRACING", "POLICY"),
      present(...ALL),
    ]) {
      for (const l of systemLinks(subset)) {
        expect(subset.has(l.from) && subset.has(l.to)).toBe(true);
      }
    }
  });
});

describe("redSummary", () => {
  it("điểm cuối có dữ liệu của mỗi chuỗi; rate cộng, lỗi theo trọng số rate, p99 lấy max", () => {
    expect(
      redSummary([
        {
          workload: "a",
          requestRate: [1, 10, null],
          errorRatio: [0, 0.1, null],
          latencyP99Ms: [5, 100, null],
        },
        {
          workload: "b",
          requestRate: [30],
          errorRatio: [0],
          latencyP99Ms: [40],
        },
      ]),
    ).toEqual({ requestRate: 40, errorRatio: 0.025, latencyP99Ms: 100 });
  });

  it("không dữ liệu là null, không phải 0 (I7)", () => {
    expect(redSummary([])).toEqual({
      requestRate: null,
      errorRatio: null,
      latencyP99Ms: null,
    });
    expect(
      redSummary([
        {
          workload: "a",
          requestRate: [null],
          errorRatio: [null],
          latencyP99Ms: [null],
        },
      ]),
    ).toEqual({ requestRate: null, errorRatio: null, latencyP99Ms: null });
  });
});
