import { readOnlyContext, type DomainAdapter } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import type { CapabilityBinding } from "@udp/shared-types";
import { describe, expect, it } from "vitest";
import {
  trafficRouterOf,
  trafficSplitBinding,
} from "../src/modules/adapter-base/traffic-router.js";
import { validateAndOrder } from "../src/modules/capability/capability.resolver.js";
import nginx from "../src/modules/ingress-adapter/nginx/index.js";
import datadog from "../src/modules/monitoring-adapter/datadog/index.js";
import dynatrace from "../src/modules/monitoring-adapter/dynatrace/index.js";
import victoriaMetrics from "../src/modules/monitoring-adapter/victoria-metrics/index.js";
import argoRollouts from "../src/modules/progressive-delivery-adapter/argo-rollouts/index.js";
import flagger from "../src/modules/progressive-delivery-adapter/flagger/index.js";
import spinnaker from "../src/modules/progressive-delivery-adapter/spinnaker/index.js";
import consul from "../src/modules/service-mesh-adapter/consul-connect/index.js";
import istio from "../src/modules/service-mesh-adapter/istio/index.js";
import linkerd from "../src/modules/service-mesh-adapter/linkerd/index.js";

/**
 * Plan #33 AC-2..AC-5 — đường traffic của progressive delivery trên adapter THẬT: validator bắt
 * tổ hợp tool thật không chạy được lúc CẤU HÌNH, controller chọn router theo `provider` của
 * binding, và khoá của Linkerd chỉ nằm trong `Secret`.
 */

const PROM: CapabilityBinding = {
  id: "metrics.query",
  version: "2.1.0",
  providedBy: "monitoring:victoria-metrics",
  endpoint: "http://vmsingle-udp-vm.udp-system:8429",
};
const DATADOG: CapabilityBinding = {
  id: "metrics.query",
  version: "1.0.0",
  providedBy: "monitoring:datadog",
  endpoint: "https://api.datadoghq.com/api/v1/query",
};
const mesh = (router: "istio" | "linkerd" | "kuma" | "consul") =>
  trafficSplitBinding("mesh.traffic-split", `service_mesh:${router}`, router);

function envFor(resolved: Record<string, CapabilityBinding>) {
  return domainContractEnv(
    {
      validConfig: {},
      invalidConfigs: [],
      externalHosts: [],
      quotaDimensions: [],
      ignoredLabelPrefixes: [],
      driftMutations: [],
    },
    { resolved },
  );
}

async function valuesOf(
  adapter: DomainAdapter,
  resolved: Record<string, CapabilityBinding>,
  config: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const env = envFor(resolved);
  const res = await adapter.deploy(env.context(), config);
  expect(res.status, JSON.stringify(res)).toBe("SUCCESS");
  const client = await env.cluster.getClient("tooling");
  const found = await client.read<{ values: Record<string, unknown> }>("get", {
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace: SYSTEM_NS,
    name: `udp-${adapter.toolId}-values`,
  });
  return found?.values ?? {};
}

describe("validator (AC-2, AC-3)", () => {
  it("Flagger + Consul Connect ⇒ CONFLICT; Spinnaker + Dynatrace ⇒ CONFLICT", () => {
    expect(
      validateAndOrder([consul, flagger, victoriaMetrics]).errors[0],
    ).toMatchObject({ code: "CONFLICT" });
    expect(validateAndOrder([dynatrace, spinnaker]).errors[0]).toMatchObject({
      code: "CONFLICT",
    });
  });

  it("Flagger + Datadog ⇒ VERSION_MISMATCH; + VictoriaMetrics ⇒ hợp lệ; Argo nhận cả Datadog", () => {
    expect(validateAndOrder([istio, datadog, flagger]).errors[0]).toMatchObject(
      { code: "VERSION_MISMATCH", detail: ["metrics.query"] },
    );
    expect(validateAndOrder([istio, victoriaMetrics, flagger]).valid).toBe(
      true,
    );
    expect(validateAndOrder([consul, datadog, argoRollouts]).valid).toBe(true);
  });

  it("không mesh lẫn ingress ⇒ MISSING_ANY_OF; có cả hai ⇒ hợp lệ", () => {
    expect(
      validateAndOrder([victoriaMetrics, flagger]).errors[0],
    ).toMatchObject({
      code: "MISSING_ANY_OF",
      detail: ["mesh.traffic-split", "ingress.traffic-split"],
    });
    expect(
      validateAndOrder([istio, nginx, victoriaMetrics, flagger]).valid,
    ).toBe(true);
  });
});

describe("router theo provider của binding (AC-3, AC-4)", () => {
  it("Flagger: meshProvider theo binding; có cả mesh lẫn ingress thì MESH (QĐ-3)", async () => {
    expect(
      await valuesOf(flagger, {
        "mesh.traffic-split": mesh("kuma"),
        "metrics.query": PROM,
      }),
    ).toMatchObject({ meshProvider: "kuma", metricsServer: PROM.endpoint });
    const both = await valuesOf(flagger, {
      "mesh.traffic-split": mesh("istio"),
      "ingress.traffic-split": trafficSplitBinding(
        "ingress.traffic-split",
        "ingress:nginx",
        "nginx",
      ),
      "metrics.query": PROM,
    });
    expect(both.meshProvider).toBe("istio");
  });

  it("Flagger: router đổi (Istio → Linkerd) ⇒ onDependencyChanged áp giá trị mới", async () => {
    const env = envFor({
      "mesh.traffic-split": mesh("istio"),
      "metrics.query": PROM,
    });
    await flagger.deploy(env.context(), {});
    const res = await flagger.onDependencyChanged(
      env.context(),
      {},
      mesh("linkerd"),
    );
    expect(res.status).toBe("SUCCESS");
    const client = await env.cluster.getClient("tooling");
    const found = await client.read<{ values: { meshProvider: string } }>(
      "get",
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        namespace: SYSTEM_NS,
        name: "udp-flagger-values",
      },
    );
    expect(found?.values.meshProvider).toBe("linkerd");
  });

  it("Argo Rollouts: Istio có sẵn; Consul/Kuma đi plugin Gateway API", async () => {
    const native = await valuesOf(argoRollouts, {
      "mesh.traffic-split": mesh("istio"),
      "metrics.query": DATADOG,
    });
    expect(native.controller).toEqual({ trafficRouterPlugins: [] });
    const plugin = await valuesOf(argoRollouts, {
      "mesh.traffic-split": mesh("consul"),
      "metrics.query": DATADOG,
    });
    expect(JSON.stringify(plugin.controller)).toContain(
      "argoproj-labs/gatewayAPI",
    );
  });

  it("Spinnaker: Kayenta theo ngôn ngữ của nguồn metrics", async () => {
    const prom = await valuesOf(spinnaker, { "metrics.query": PROM });
    expect(prom.kayenta).toMatchObject({
      metricsStore: { type: "prometheus" },
    });
    const dd = await valuesOf(spinnaker, { "metrics.query": DATADOG });
    expect(dd.kayenta).toMatchObject({ metricsStore: { type: "datadog" } });
  });

  it("thiếu binding traffic hay binding không nói provider ⇒ NÉM", () => {
    expect(() => trafficRouterOf({})).toThrow(/mesh\/ingress/);
    expect(() =>
      trafficRouterOf({
        "mesh.traffic-split": {
          id: "mesh.traffic-split",
          version: "1.0.0",
          providedBy: "x:y",
        },
      }),
    ).toThrow();
  });
});

describe("Linkerd: issuer key chỉ trong Secret (AC-5)", () => {
  const pem = (label: string, body: string): string =>
    [`-----BEGIN ${label}-----`, body, `-----END ${label}-----`, ""].join("\n");
  const KEY_BODY = "CANHKHOAISSUERP33abcdef";
  const config = {
    trustAnchorPem: pem("CERTIFICATE", "MIIBtrust"),
    issuerCertPem: pem("CERTIFICATE", "MIIBissuer"),
    issuerKeyPem: pem("EC PRIVATE KEY", KEY_BODY),
  };

  it("khoá vào Secret; control plane đọc qua secretValuesFrom; không ConfigMap nào mang khoá", async () => {
    const env = envFor({});
    expect((await linkerd.deploy(env.context(), config)).status).toBe(
      "SUCCESS",
    );
    const client = await env.cluster.getClient("tooling");
    const read = (kind: string, name: string) =>
      client.read<Record<string, unknown>>("get", {
        apiVersion: kind === "HelmRelease" ? "helm.toolkit.fluxcd.io/v2" : "v1",
        kind,
        namespace: SYSTEM_NS,
        name,
      });
    expect(
      JSON.stringify(await read("Secret", "udp-linkerd-crds-secrets")),
    ).toContain(KEY_BODY);
    expect(
      await read("HelmRelease", "udp-linkerd-control-plane"),
    ).toMatchObject({
      secretValuesFrom: "udp-linkerd-crds-secrets",
    });
    for (const name of [
      "udp-linkerd-crds-values",
      "udp-linkerd-control-plane-values",
    ]) {
      expect(JSON.stringify(await read("ConfigMap", name))).not.toContain(
        KEY_BODY,
      );
    }
    const drift = await linkerd.detectDrift(
      readOnlyContext(env.context()),
      config,
    );
    expect(drift.data?.drifted).toBe(false);
  });

  it("thiếu chứng chỉ ⇒ configSchema từ chối", () => {
    expect(
      linkerd.configSchema.safeParse({ issuerKeyPem: config.issuerKeyPem })
        .success,
    ).toBe(false);
  });
});
