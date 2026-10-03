import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Kyverno qua đủ bộ hợp đồng (Plan #34 AC-1): engine + bộ Pod Security Standards */

function fixture(): AdapterFixture {
  return {
    validConfig: {
      podSecurityStandard: "baseline",
      validationFailureAction: "Audit",
      replicas: 1,
    },
    invalidConfigs: [
      { podSecurityStandard: "privileged" },
      { validationFailureAction: "Deny" },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-kyverno", {
      companions: ["udp-kyverno-policies"],
    }),
  };
}

describe("kyverno", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});

/**
 * [Plan #61 61d-3a] Bản 2.0.0 — và cái bẫy im lặng của chart 3.9.x.
 *
 * `kyverno-policies` từ 3.9.x mặc định `policyType: ValidatingPolicy`, mà khoá `policyExclude` của bản 1.0.0 **chỉ**
 * áp dụng cho họ `ClusterPolicy` cũ. Nâng chart mà quên đổi khoá thì `udp-system`, `kube-system` và `udp-build`
 * mất quyền miễn trừ **trong im lặng** — với `Enforce` thì pod nền tảng và pod build BuildKit bị chặn. Những ô dưới
 * đây là thứ duy nhất biến lần nâng chart kế tiếp thành một test đỏ nếu ai đó đổi khoá sai.
 */
describe("kyverno 2.0.0: chart, miễn trừ, và đường hạ về", () => {
  const configOf = (over: Record<string, unknown> = {}) => ({
    podSecurityStandard: "baseline",
    validationFailureAction: "Audit",
    replicas: 1,
    ...over,
  });

  /** Giá trị đã ghi lên ConfigMap của một release */
  async function valuesOf(
    env: ReturnType<typeof domainContractEnv>,
    releaseName: string,
  ): Promise<Record<string, unknown>> {
    const client = await env.cluster.getClient("tooling");
    const cm = await client.read<{ values?: Record<string, unknown> }>("get", {
      apiVersion: "v1",
      kind: "ConfigMap",
      namespace: CONTRACT_SYSTEM_NAMESPACE,
      name: `${releaseName}-values`,
    });
    return cm?.values ?? {};
  }

  /** Toạ độ chart đã ghi lên HelmRelease */
  async function chartOf(
    env: ReturnType<typeof domainContractEnv>,
    releaseName: string,
  ): Promise<string> {
    const client = await env.cluster.getClient("tooling");
    const release = await client.read<{ version?: string }>("get", {
      apiVersion: "helm.toolkit.fluxcd.io/v2",
      kind: "HelmRelease",
      namespace: CONTRACT_SYSTEM_NAMESPACE,
      name: releaseName,
    });
    return release?.version ?? "";
  }

  it("version 2.0.0, hai chart 3.9.1, và capability GIỮ policy.admission@1.0.0", async () => {
    expect(adapter.version).toBe("2.0.0");
    /**
     * Bump version capability sẽ làm mọi consumer khai `^1` vỡ 422 ngay trong `validateAndOrder` — trước khi chạm
     * cụm. Đổi chart không phải đổi hợp đồng capability.
     */
    expect(adapter.capabilities.provides).toEqual([
      { id: "policy.admission", version: "1.0.0" },
    ]);

    const env = domainContractEnv(fixture());
    expect((await adapter.deploy(env.context(), configOf())).status).toBe(
      "SUCCESS",
    );
    expect(await chartOf(env, "udp-kyverno")).toBe("3.9.1");
    expect(await chartOf(env, "udp-kyverno-policies")).toBe("3.9.1");
  });

  it("miễn trừ đi bằng vpolExclude (họ mới), KHÔNG còn policyExclude, và policyType ghim tường minh", async () => {
    const env = domainContractEnv(fixture());
    await adapter.deploy(env.context(), configOf());
    const values = await valuesOf(env, "udp-kyverno-policies");

    expect(values.policyType).toBe("ValidatingPolicy");
    expect(values.vpolExclude).toEqual({
      excludeNamespaces: [
        CONTRACT_SYSTEM_NAMESPACE,
        "kube-system",
        "udp-build",
      ],
    });
    // Khoá của bản cũ không được còn lại: nó vô tác dụng với họ ValidatingPolicy
    expect(values.policyExclude).toBeUndefined();
  });

  it("failurePolicy theo chế độ: Audit ⇒ Ignore, Enforce ⇒ Fail", async () => {
    for (const [action, failurePolicy, replicas] of [
      ["Audit", "Ignore", 1],
      ["Enforce", "Fail", 2],
    ] as const) {
      const env = domainContractEnv(fixture());
      await adapter.deploy(
        env.context(),
        configOf({ validationFailureAction: action, replicas }),
      );
      expect((await valuesOf(env, "udp-kyverno-policies")).failurePolicy).toBe(
        failurePolicy,
      );
    }
  });

  it("Enforce với MỘT bản sao ⇒ từ chối ngay lúc parse cấu hình", () => {
    const bad = adapter.configSchema.safeParse(
      configOf({ validationFailureAction: "Enforce", replicas: 1 }),
    );
    expect(bad.success).toBe(false);
    const ok = adapter.configSchema.safeParse(
      configOf({ validationFailureAction: "Enforce", replicas: 2 }),
    );
    expect(ok.success).toBe(true);
  });

  it("hạ về 1.0.0 áp lại chart 3.2.7/3.2.6 VÀ khoá policyExclude của bản cũ", async () => {
    const env = domainContractEnv(fixture());
    await adapter.upgrade(env.context(), configOf(), "1.0.0");
    env.cluster.reset();

    const back = await adapter.restoreTo?.(env.context(), configOf(), "1.0.0");
    expect(back?.status).toBe("SUCCESS");
    expect(await chartOf(env, "udp-kyverno")).toBe("3.2.7");
    expect(await chartOf(env, "udp-kyverno-policies")).toBe("3.2.6");

    const values = await valuesOf(env, "udp-kyverno-policies");
    /**
     * Nửa dễ quên nhất của một lần hạ về: chart 3.2.x **không biết** `vpolExclude` và bỏ qua nó trong im lặng,
     * nên nếu hạ về mà vẫn dùng giá trị của bản mới thì cụm trông như đã về bản cũ mà ba namespace nền tảng
     * không còn được miễn trừ.
     */
    expect(values.policyExclude).toEqual({
      any: [
        {
          resources: {
            namespaces: [CONTRACT_SYSTEM_NAMESPACE, "kube-system", "udp-build"],
          },
        },
      ],
    });
    expect(values.vpolExclude).toBeUndefined();
    expect(values.policyType).toBeUndefined();
  });
});
