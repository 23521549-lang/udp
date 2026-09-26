import { resolve } from "node:path";
import {
  CONTRACT_ENVIRONMENTS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import { validateAndOrder } from "../src/modules/capability/capability.resolver.js";
import { derivedPassword } from "../src/modules/adapter-base/database.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import { resolvedFor } from "../src/modules/provisioning/domain-phase.js";
import cloudnativePg from "../src/modules/database-adapter/cloudnative-pg/index.js";
import kubecost from "../src/modules/cost-adapter/kubecost/index.js";
import opencost from "../src/modules/cost-adapter/opencost/index.js";
import ghcr from "../src/modules/container-registry-adapter/ghcr/index.js";
import datadog from "../src/modules/monitoring-adapter/datadog/index.js";
import prometheusGrafana from "../src/modules/monitoring-adapter/prometheus-grafana/index.js";

/**
 * Plan #38 AC-2, AC-3: database theo environment (instance, binding, quota), mật khẩu suy theo
 * environment, và Cost đòi PromQL. Bộ hợp đồng 42 phép của từng adapter nằm cạnh adapter.
 */

const product = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});

const THREE = [
  ...CONTRACT_ENVIRONMENTS,
  {
    id: "00000000-0000-4000-8000-00000000e003",
    name: "staging",
    k8sNamespace: "udp-hop-dong-staging",
    isProduction: false,
  },
];

const fixture = {
  validConfig: { storageGb: 5 },
  invalidConfigs: [],
  externalHosts: [],
  quotaDimensions: [],
  ignoredLabelPrefixes: [],
  driftMutations: [],
};

describe("database theo environment (AC-2)", () => {
  it("registry có đủ sáu tool Database và hai tool Cost", async () => {
    const tools = (await product)
      .all()
      .filter((l) => ["DATABASE", "COST"].includes(l.adapter.domainType))
      .map((l) => l.key)
      .sort();
    expect(tools).toEqual([
      "cost:kubecost",
      "cost:opencost",
      "database:cloudnative-pg",
      "database:k8ssandra",
      "database:minio",
      "database:mongodb",
      "database:mysql",
      "database:redis",
    ]);
  });

  it("CloudNativePG: một binding mỗi environment, endpoint trong namespace của nó; production có HA", async () => {
    const env = domainContractEnv(fixture, {
      environments: THREE,
    });
    const quota = { ...env.context().quota, maxDatabases: 3 };
    const res = await cloudnativePg.deploy(env.context({ quota }), {
      storageGb: 5,
    });
    expect(res.status).toBe("SUCCESS");
    expect(res.data?.map((b) => [b.environmentId, b.endpoint])).toEqual(
      THREE.map((e) => [
        e.id,
        `udp-postgres-rw.${e.k8sNamespace}.svc.cluster.local:5432`,
      ]),
    );
    const client = await env.cluster.getClient("tooling");
    const prodValues = await client.read<{
      values: { resources: { spec: { instances: number } }[] };
    }>("get", {
      apiVersion: "v1",
      kind: "ConfigMap",
      namespace: "udp-system",
      name: "udp-cnpg-db-prod-values",
    });
    expect(prodValues?.values.resources[0]?.spec.instances).toBe(3);
  });

  it("ba environment mà trần database là 2 ⇒ FAILED trước khi ghi gì (QĐ-4)", async () => {
    const env = domainContractEnv(fixture, { environments: THREE });
    const res = await cloudnativePg.deploy(env.context(), { storageGb: 5 });
    expect(res.status).toBe("FAILED");
    expect(res.message).toMatch(/maxDatabases = 3, trần là 2/);
    expect(env.cluster.writes).toEqual([]);
  });

  it("mỗi environment đọc ĐÚNG binding database của mình", () => {
    const stored = CONTRACT_ENVIRONMENTS.map((e, i) => ({
      id: `b${String(i)}`,
      domainConfigId: "d",
      environmentId: e.id,
      capabilityId: "db.instance",
      providedBy: "database:cloudnative-pg",
      schemaVersion: "1.0.0",
      endpoint: `udp-postgres-rw.${e.k8sNamespace}.svc.cluster.local:5432`,
      attributes: null,
    }));
    for (const e of CONTRACT_ENVIRONMENTS) {
      expect(resolvedFor(stored, {}, e.id)["db.instance"]?.endpoint).toContain(
        e.k8sNamespace,
      );
    }
  });

  it("mật khẩu suy theo environment: khác nhau giữa env, ổn định qua các lần tính", () => {
    const seed = "s".repeat(32);
    const [dev, prod] = CONTRACT_ENVIRONMENTS;
    expect(derivedPassword(seed, dev!)).not.toBe(derivedPassword(seed, prod!));
    expect(derivedPassword(seed, dev!)).toBe(derivedPassword(seed, dev!));
    expect(derivedPassword(seed, dev!)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("Cost đòi PromQL và độc quyền (AC-3)", () => {
  it("một mình ⇒ thiếu metrics.query; với Datadog ⇒ sai phiên bản; với Prometheus (+ registry nó cần) ⇒ hợp lệ", () => {
    expect(validateAndOrder([opencost]).errors[0]?.code).toBe(
      "MISSING_CAPABILITY",
    );
    expect(validateAndOrder([opencost, datadog]).errors[0]?.code).toBe(
      "VERSION_MISMATCH",
    );
    expect(validateAndOrder([opencost, prometheusGrafana, ghcr]).valid).toBe(
      true,
    );
  });

  it("OpenCost và Kubecost cùng lúc ⇒ CONFLICT: một cluster một bộ tính chi phí", () => {
    const res = validateAndOrder([opencost, kubecost, prometheusGrafana, ghcr]);
    expect(res.errors.map((e) => e.code)).toContain("CONFLICT");
  });
});
