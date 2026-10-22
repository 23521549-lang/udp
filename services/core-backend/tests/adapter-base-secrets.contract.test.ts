import {
  DOMAIN_CONTRACT_CHECKS,
  type DomainContractEnv,
} from "@udp/adapter-core/contract";
import {
  readOnlyContext,
  type AdapterFixture,
  type DomainAdapter,
} from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHelmBasedAdapter,
  HelmAdapterError,
  type HelmAdapterSpec,
} from "../src/modules/adapter-base/helm.js";

/**
 * Plan #31 QĐ-5 — lớp nền Helm với `secretValues`: khoá của agent vào `Secret` của
 * `udp-system`, ConfigMap giá trị chỉ mang băm, và adapter vẫn qua đủ 42 phép.
 *
 * Adapter ở đây là bản TỐI THIỂU có bí mật (cùng lý lẽ với `adapter-base-noop`): nằm dưới
 * `tests/` để registry sản phẩm không bao giờ thấy nó.
 */

const LICENSE = "canhLicenseP31b0a1b2c3d4e5f6a7b8";
const schema = z.object({
  cluster: z.string().min(1),
  licenseKey: z.string().min(16).describe("secret"),
});

const spec: HelmAdapterSpec = {
  domainType: "MONITORING",
  toolId: "agent-bi-mat",
  version: "0.1.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "metrics.query", version: "1.0.0" }],
    requires: [],
  },
  configSchema: schema,
  chart: { name: "agent", version: "1.2.3", repo: "https://vi-du.test/charts" },
  releaseName: "udp-agent",
  quotaDimensions: [],
  values: (config) => ({ cluster: { name: schema.parse(config).cluster } }),
  secretValues: (config) => ({
    global: { licenseKey: schema.parse(config).licenseKey },
  }),
  bindings: () => [
    {
      id: "metrics.query",
      version: "1.0.0",
      providedBy: "monitoring:agent-bi-mat",
      endpoint: "https://api.vi-du.test/query",
    },
  ],
};
const adapter: DomainAdapter = createHelmBasedAdapter(spec);

const ref = (kind: string, name: string) => ({
  apiVersion: kind === "HelmRelease" ? "helm.toolkit.fluxcd.io/v2" : "v1",
  kind,
  namespace: SYSTEM_NS,
  name,
});
const VALUES = ref("ConfigMap", "udp-agent-values");
const SECRET = ref("Secret", "udp-agent-secrets");
const RELEASE = ref("HelmRelease", "udp-agent");

function fixture(): AdapterFixture {
  return {
    validConfig: { cluster: "prod-1", licenseKey: LICENSE },
    invalidConfigs: [
      { cluster: "prod-1" },
      { cluster: "", licenseKey: LICENSE },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: [],
    driftMutations: [
      {
        name: "xoá Secret của release",
        apply: async (client) => {
          await client.write("delete", SECRET);
        },
      },
      {
        name: "sửa tay khoá trong Secret",
        apply: async (client) => {
          await client.write("patch", SECRET, {
            stringData: { "values.yaml": "{}" },
          });
        },
      },
    ],
  };
}

const envFor = (): DomainContractEnv => domainContractEnv(fixture());

describe("lớp nền Helm có secretValues qua đủ bộ hợp đồng", () => {
  for (const check of DOMAIN_CONTRACT_CHECKS) {
    it(check.name, async () => {
      await check.run(adapter, envFor());
    });
  }
});

describe("lớp nền Helm: bí mật trên cluster (AC-8)", () => {
  it("khoá chỉ nằm trong Secret của udp-system; ConfigMap mang băm; release trỏ tới Secret", async () => {
    const env = envFor();
    expect(
      (await adapter.deploy(env.context(), env.fixture.validConfig)).status,
    ).toBe("SUCCESS");
    const client = await env.cluster.getClient("tooling");

    expect(await client.read("get", SECRET)).toEqual({
      type: "Opaque",
      stringData: {
        "values.yaml": JSON.stringify({ global: { licenseKey: LICENSE } }),
      },
    });
    const values = await client.read<Record<string, unknown>>("get", VALUES);
    expect(JSON.stringify(values)).not.toContain(LICENSE);
    expect(values?.secretsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await client.read("get", RELEASE)).toMatchObject({
      valuesFrom: "udp-agent-values",
      secretValuesFrom: "udp-agent-secrets",
    });
    // Secret được ghi TRƯỚC release: release không bao giờ trỏ tới thứ chưa có
    const kinds = env.cluster.writes.map((w) => w.ref.kind);
    expect(kinds.indexOf("Secret")).toBeLessThan(kinds.indexOf("HelmRelease"));
    expect(env.progressLog.join(" | ")).not.toContain(LICENSE);
  });

  it("đổi khoá ⇒ drift; chi tiết drift không in khoá cũ lẫn mới", async () => {
    const env = envFor();
    await adapter.deploy(env.context(), env.fixture.validConfig);
    const rotated = "khoaMoiP31b9f8e7d6c5b4a39281";
    const res = await adapter.detectDrift(readOnlyContext(env.context()), {
      ...env.fixture.validConfig,
      licenseKey: rotated,
    });
    expect(res.data?.drifted).toBe(true);
    expect(JSON.stringify(res)).not.toContain(rotated);
    expect(JSON.stringify(res)).not.toContain(LICENSE);
  });

  it("teardown `switch` giữ ConfigMap nhưng XOÁ Secret: khoá không sống lâu hơn tool", async () => {
    const env = envFor();
    await adapter.deploy(env.context(), env.fixture.validConfig);
    await adapter.teardown(env.context(), "switch");
    const client = await env.cluster.getClient("tooling");
    expect(await client.read("get", SECRET)).toBeNull();
    expect(await client.read("get", VALUES)).not.toBeNull();
  });

  it("adapter namespace-scoped khai secretValues ⇒ từ chối lúc dựng (§12.2)", () => {
    expect(() =>
      createHelmBasedAdapter({ ...spec, scope: "namespace" }),
    ).toThrow(HelmAdapterError);
  });
});
