import { DOMAIN_CONTRACT_CHECKS } from "@udp/adapter-core/contract";
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
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../src/modules/adapter-base/contract-fixtures.js";
import {
  createHelmBasedAdapter,
  HelmAdapterError,
  type HelmAdapterSpec,
} from "../src/modules/adapter-base/helm.js";

/**
 * Plan #32 AC-2 — lớp nền Helm NHIỀU release: một adapter tối thiểu ba release (máy chủ, giao
 * diện, bộ thu) với khoá phẳng trong `Secret`, qua đủ 42 phép; áp theo thứ tự, gỡ ngược thứ
 * tự, trôi ở BẤT KỲ release nào cũng bị thấy. Nằm dưới `tests/` để registry sản phẩm không thấy.
 */

const PASSWORD = "canhMatKhauP32A1!b2c3";
const schema = z.object({
  storageGb: z.number().int().min(1),
  password: z.string().min(8).describe("secret"),
});

const spec: HelmAdapterSpec = {
  domainType: "LOGGING",
  toolId: "nhom-ba",
  version: "0.1.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "logs.sink", version: "1.0.0" }],
    requires: [],
  },
  configSchema: schema,
  chart: {
    name: "may-chu",
    version: "1.0.0",
    repo: "https://vi-du.test/charts",
  },
  releaseName: "udp-may-chu",
  quotaDimensions: ["maxStorageGb"],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],
  values: (config) => ({ size: `${String(schema.parse(config).storageGb)}Gi` }),
  secretKeys: (config) => ({ password: schema.parse(config).password }),
  companions: [
    {
      releaseName: "udp-giao-dien",
      chart: {
        name: "giao-dien",
        version: "2.0.0",
        repo: "https://vi-du.test/charts",
      },
      values: () => ({
        env: [
          {
            name: "PASSWORD",
            valueFrom: {
              secretKeyRef: { name: "udp-may-chu-secrets", key: "password" },
            },
          },
        ],
      }),
    },
    {
      releaseName: "udp-bo-thu",
      chart: {
        name: "bo-thu",
        version: "3.0.0",
        repo: "https://vi-du.test/charts",
      },
      values: (_config, ctx) => ({
        target: `http://udp-may-chu.${ctx.systemNamespace}`,
      }),
    },
  ],
  bindings: () => [
    {
      id: "logs.sink",
      version: "1.0.0",
      providedBy: "logging:nhom-ba",
      endpoint: "http://udp-may-chu.udp-system",
    },
  ],
};
const adapter: DomainAdapter = createHelmBasedAdapter(spec);

const fixture = (): AdapterFixture => ({
  validConfig: { storageGb: 10, password: PASSWORD },
  invalidConfigs: [{ storageGb: 0, password: PASSWORD }, { storageGb: 10 }],
  externalHosts: [],
  quotaDimensions: ["maxStorageGb"],
  ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
  driftMutations: helmDriftMutations("udp-may-chu", {
    secrets: true,
    companions: ["udp-giao-dien", "udp-bo-thu"],
  }),
});

describe("lớp nền Helm ba release qua đủ bộ hợp đồng", () => {
  for (const check of DOMAIN_CONTRACT_CHECKS) {
    it(check.name, async () => {
      await check.run(adapter, domainContractEnv(fixture()));
    });
  }
});

const releaseOrder = (
  writes: readonly { verb: string; ref: { kind: string; name?: string } }[],
  verb: string,
) =>
  writes
    .filter((w) => w.verb === verb && w.ref.kind === "HelmRelease")
    .map((w) => w.ref.name);

describe("lớp nền Helm nhiều release (Plan #32 AC-2)", () => {
  it("áp: Secret trước, rồi từng release THEO THỨ TỰ; khoá phẳng chỉ trong Secret", async () => {
    const env = domainContractEnv(fixture());
    expect(
      (await adapter.deploy(env.context(), env.fixture.validConfig)).status,
    ).toBe("SUCCESS");
    expect(env.cluster.writes[0]?.ref.kind).toBe("Secret");
    expect(releaseOrder(env.cluster.writes, "apply")).toEqual([
      "udp-may-chu",
      "udp-giao-dien",
      "udp-bo-thu",
    ]);
    const client = await env.cluster.getClient("tooling");
    expect(
      await client.read("get", {
        apiVersion: "v1",
        kind: "Secret",
        namespace: SYSTEM_NS,
        name: "udp-may-chu-secrets",
      }),
    ).toEqual({ type: "Opaque", stringData: { password: PASSWORD } });
    const others = await Promise.all(
      env.cluster.writes
        .filter((w) => w.ref.kind !== "Secret")
        .map((w) => client.read("get", w.ref)),
    );
    expect(JSON.stringify(others)).not.toContain(PASSWORD);
  });

  it("gỡ: NGƯỢC thứ tự áp; `switch` giữ mọi ConfigMap nhưng xoá Secret", async () => {
    const env = domainContractEnv(fixture());
    await adapter.deploy(env.context(), env.fixture.validConfig);
    env.cluster.reset();
    await adapter.teardown(env.context(), "switch");
    expect(releaseOrder(env.cluster.writes, "delete")).toEqual([
      "udp-bo-thu",
      "udp-giao-dien",
      "udp-may-chu",
    ]);
    const deleted = env.cluster.writes.map((w) => w.ref.kind);
    expect(deleted).not.toContain("ConfigMap");
    expect(deleted).toContain("Secret");
  });

  it("xoá release đi kèm ⇒ drift nêu đúng tên nó; healthcheck báo thiếu", async () => {
    const env = domainContractEnv(fixture());
    await adapter.deploy(env.context(), env.fixture.validConfig);
    const client = await env.cluster.getClient("tooling");
    await client.write("delete", {
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      namespace: SYSTEM_NS,
      name: "udp-giao-dien",
    });
    const drift = await adapter.detectDrift(
      readOnlyContext(env.context()),
      env.fixture.validConfig,
    );
    expect(drift.data).toEqual({
      drifted: true,
      details: "udp-giao-dien: thiếu HelmRelease của tool",
    });
    expect((await adapter.healthcheck(env.context())).data).toEqual({
      healthy: false,
      details: "chưa có Helm release udp-giao-dien",
    });
  });

  it("hai release trùng tên, hay bí mật ở adapter namespace ⇒ từ chối lúc dựng", () => {
    expect(() =>
      createHelmBasedAdapter({
        ...spec,
        companions: [
          {
            releaseName: "udp-may-chu",
            chart: spec.chart,
            values: () => ({}),
          },
        ],
      }),
    ).toThrow(HelmAdapterError);
    expect(() =>
      createHelmBasedAdapter({ ...spec, scope: "namespace" }),
    ).toThrow(HelmAdapterError);
  });
});
