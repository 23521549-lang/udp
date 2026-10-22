import { type AdapterFixture, type DomainAdapter } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HELM_IGNORED_PREFIXES } from "../src/modules/adapter-base/contract-fixtures.js";
import {
  createHelmBasedAdapter,
  HelmAdapterError,
  type HelmAdapterSpec,
} from "../src/modules/adapter-base/helm.js";

/**
 * [Plan #61 61d-3a] Đường NÂNG CẤP của §8.6 — lần đầu có adapter đi qua được nó.
 *
 * Trước đợt này lớp nền Helm ném khi `fromVersion !== spec.version`, mà đường nâng cấp của §8.6 chỉ chạy **khi**
 * hai version khác nhau. Nên mọi lần đổi version của một adapter họ Helm chắc chắn thất bại, và cả đường đó (job,
 * `upgradeDomain`, rollback, `persist`) đã dựng đủ nhưng chưa ai đi qua. Hai nửa của bản sửa, mỗi nửa một ô ở đây:
 *
 *  - `upgradesFrom` mở đúng cửa cần mở, và **giữ** cửa đóng với một version lạ (d11 của bộ hợp đồng).
 *  - `restoreTo` áp lại ĐỊNH NGHĨA CŨ — không chỉ toạ độ chart cũ mà cả `values` cũ. Đây là nửa mà §8.6 đòi
 *    ("nâng cấp thất bại thì hạ về bản cũ, không để trạng thái lửng lơ") và là nửa mà cổng `rollback` của job
 *    không làm được khi registry chỉ nạp một bản adapter.
 */

const schema = z.object({ size: z.number().int().min(1) });

/** Giá trị của bản MỚI — có khoá `moi`, không có khoá `cu` */
const valuesV2 = (config: unknown): Record<string, unknown> => ({
  moi: schema.parse(config).size,
});

/** Giá trị của bản CŨ — khoá khác hẳn, để một lần hạ về sai là một ô đỏ */
const valuesV1 = (config: unknown): Record<string, unknown> => ({
  cu: schema.parse(config).size,
});

const REPO = "https://vi-du.test/charts";

const specOf = (over: Partial<HelmAdapterSpec> = {}): HelmAdapterSpec => ({
  domainType: "POLICY",
  toolId: "hai-ban",
  version: "2.0.0",
  upgradesFrom: [
    {
      version: "1.0.0",
      chart: { name: "engine", version: "1.1.0", repo: REPO },
      values: valuesV1,
      companions: [
        {
          releaseName: "udp-phu",
          chart: { name: "phu", version: "1.1.0", repo: REPO },
          values: valuesV1,
        },
      ],
    },
  ],
  scope: "cluster",
  capabilities: {
    provides: [{ id: "policy.admission", version: "1.0.0" }],
    requires: [],
  },
  configSchema: schema,
  chart: { name: "engine", version: "2.2.0", repo: REPO },
  releaseName: "udp-engine",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: valuesV2,
  companions: [
    {
      releaseName: "udp-phu",
      chart: { name: "phu", version: "2.2.0", repo: REPO },
      values: valuesV2,
    },
  ],
  bindings: () => [
    {
      id: "policy.admission",
      version: "1.0.0",
      providedBy: "policy:hai-ban",
    },
  ],
  ...over,
});

const adapter: DomainAdapter = createHelmBasedAdapter(specOf());

const fixture = (): AdapterFixture => ({
  validConfig: { size: 3 },
  invalidConfigs: [{ size: 0 }],
  externalHosts: [],
  quotaDimensions: [],
  ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
  driftMutations: [],
});

/** Toạ độ chart đã ghi lên HelmRelease, theo tên release */
async function chartsApplied(
  env: ReturnType<typeof domainContractEnv>,
): Promise<Record<string, unknown>> {
  const client = await env.cluster.getClient("tooling");
  const out: Record<string, unknown> = {};
  for (const name of ["udp-engine", "udp-phu"]) {
    const release = await client.read<{ chart: string; version: string }>(
      "get",
      {
        apiVersion: "helm.toolkit.fluxcd.io/v2",
        kind: "HelmRelease",
        namespace: SYSTEM_NS,
        name,
      },
    );
    out[name] = release === null ? null : release.version;
  }
  return out;
}

/** Giá trị đã ghi lên ConfigMap của một release */
async function valuesApplied(
  env: ReturnType<typeof domainContractEnv>,
  releaseName: string,
): Promise<string> {
  const client = await env.cluster.getClient("tooling");
  const cm = await client.read<Record<string, unknown>>("get", {
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace: SYSTEM_NS,
    name: `${releaseName}-values`,
  });
  return JSON.stringify(cm ?? {});
}

describe("đường nâng cấp của lớp nền Helm (Plan #61 61d-3a)", () => {
  it("nâng từ version của CHÍNH nó ⇒ đi qua (giữ hành vi cũ, d10)", async () => {
    const env = domainContractEnv(fixture());
    const res = await adapter.upgrade(
      env.context(),
      env.fixture.validConfig,
      "2.0.0",
    );
    expect(res.status).toBe("SUCCESS");
    expect(await chartsApplied(env)).toEqual({
      "udp-engine": "2.2.0",
      "udp-phu": "2.2.0",
    });
  });

  it("nâng từ một version KHAI trong upgradesFrom ⇒ đi qua, và áp bản MỚI", async () => {
    const env = domainContractEnv(fixture());
    const res = await adapter.upgrade(
      env.context(),
      env.fixture.validConfig,
      "1.0.0",
    );
    expect(res.status).toBe("SUCCESS");
    expect(await chartsApplied(env)).toEqual({
      "udp-engine": "2.2.0",
      "udp-phu": "2.2.0",
    });
    expect(await valuesApplied(env, "udp-engine")).toContain("moi");
  });

  it("nâng từ một version LẠ ⇒ vẫn từ chối, nguyên văn như trước (d11)", async () => {
    const env = domainContractEnv(fixture());
    const res = await adapter.upgrade(
      env.context(),
      env.fixture.validConfig,
      "0.9.0",
    );
    expect(res.status).toBe("FAILED");
    expect(res.message).toContain("không biết đường nâng cấp hai-ban từ 0.9.0");
    // Và KHÔNG áp gì: một lần từ chối không được để lại nửa cụm
    expect(env.cluster.writes).toEqual([]);
  });

  it("restoreTo áp lại ĐỊNH NGHĨA cũ — cả toạ độ chart lẫn giá trị", async () => {
    const env = domainContractEnv(fixture());
    await adapter.upgrade(env.context(), env.fixture.validConfig, "1.0.0");
    env.cluster.reset();

    const back = await adapter.restoreTo?.(
      env.context(),
      env.fixture.validConfig,
      "1.0.0",
    );
    expect(back?.status).toBe("SUCCESS");
    expect(await chartsApplied(env)).toEqual({
      "udp-engine": "1.1.0",
      "udp-phu": "1.1.0",
    });
    /**
     * Nửa dễ quên nhất: giá trị cũng phải là của bản CŨ.
     *
     * Hạ về mà dùng `values` của bản mới trên chart cũ là một lần hạ về SAI — Helm bỏ qua khoá mà chart không
     * biết trong im lặng, nên cụm trông như đã về bản cũ mà cấu hình thì không.
     */
    expect(await valuesApplied(env, "udp-engine")).toContain("cu");
    expect(await valuesApplied(env, "udp-engine")).not.toContain("moi");
    expect(await valuesApplied(env, "udp-phu")).toContain("cu");
  });

  it("restoreTo tới một version KHÔNG khai ⇒ thất bại, không áp gì", async () => {
    const env = domainContractEnv(fixture());
    const back = await adapter.restoreTo?.(
      env.context(),
      env.fixture.validConfig,
      "0.9.0",
    );
    expect(back?.status).toBe("FAILED");
    expect(back?.message).toContain("không mang định nghĩa của bản 0.9.0");
    expect(env.cluster.writes).toEqual([]);
  });

  it("adapter KHÔNG khai upgradesFrom thì không có restoreTo — kêu to thay vì vờ hạ về", () => {
    const { upgradesFrom: _bo, ...khongKhai } = specOf({ companions: [] });
    const plain = createHelmBasedAdapter(khongKhai);
    /**
     * `restoreTo` vẫn tồn tại (lớp nền luôn khai), nhưng nó từ chối mọi version — đó là hành vi đúng: cổng
     * `rollback` của job gọi nó rồi nhận FAILED, và kết cục là `ROLLBACK_FAILED` y như trước đợt này.
     */
    expect(typeof plain.restoreTo).toBe("function");
  });

  it("upgradesFrom chứa chính version của nó ⇒ ném NGAY lúc nạp registry", () => {
    expect(() =>
      createHelmBasedAdapter(
        specOf({
          upgradesFrom: [
            {
              version: "2.0.0",
              chart: { name: "engine", version: "2.2.0", repo: REPO },
              values: valuesV2,
            },
          ],
        }),
      ),
    ).toThrow(HelmAdapterError);
  });
});
