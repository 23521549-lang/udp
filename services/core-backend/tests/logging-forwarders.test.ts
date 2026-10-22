import { readOnlyContext } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import { logsSinkBinding } from "../src/modules/adapter-base/logs-sink.js";
import { validateAndOrder } from "../src/modules/capability/capability.resolver.js";
import fluentBit from "../src/modules/logging-adapter/fluent-bit/index.js";
import fluentd from "../src/modules/logging-adapter/fluentd/index.js";
import loki from "../src/modules/logging-adapter/loki/index.js";
import datadog from "../src/modules/monitoring-adapter/datadog/index.js";
import newRelic from "../src/modules/monitoring-adapter/newrelic/index.js";

/**
 * Plan #32 AC-4, AC-5 — hai forwarder trước sink THẬT của domain Monitoring: output đúng plugin,
 * khoá qua `secretKeyRef`, sink đổi ⇒ render lại; validator chặn forwarder không có sink.
 */

const DATADOG_SINK = logsSinkBinding("monitoring:datadog", {
  protocol: "datadog",
  endpoint: "https://http-intake.logs.datadoghq.com/api/v2/logs",
  credential: {
    secretName: "udp-datadog-connection-key",
    secretKey: "api-key",
  },
});
const NEW_RELIC_SINK = logsSinkBinding("monitoring:newrelic", {
  protocol: "newrelic",
  endpoint: "https://log-api.newrelic.com/log/v1",
  credential: { secretName: "udp-newrelic-secrets", secretKey: "license-key" },
});

const envWith = (sink: typeof DATADOG_SINK, config: Record<string, unknown>) =>
  domainContractEnv(
    {
      validConfig: config,
      invalidConfigs: [],
      externalHosts: [],
      quotaDimensions: [],
      ignoredLabelPrefixes: [],
      driftMutations: [],
    },
    { resolved: { "logs.sink": sink } },
  );

const valuesOf = async (
  env: ReturnType<typeof envWith>,
  release: string,
): Promise<Record<string, unknown>> => {
  const client = await env.cluster.getClient("tooling");
  const found = await client.read<{ values: Record<string, unknown> }>("get", {
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace: SYSTEM_NS,
    name: `${release}-values`,
  });
  return found?.values ?? {};
};

describe("forwarder gửi log tới sink của domain Monitoring (AC-4)", () => {
  it("Fluent Bit: output datadog, khoá qua secretKeyRef tới Secret kết nối", async () => {
    const env = envWith(DATADOG_SINK, { excludeSystemNamespaces: true });
    const res = await fluentBit.deploy(env.context(), env.fixture.validConfig);
    expect(res.status).toBe("SUCCESS");
    const values = await valuesOf(env, "udp-fluent-bit");
    expect(JSON.stringify(values)).toContain("Name               datadog");
    expect(values.env).toEqual([
      {
        name: "SINK_SECRET",
        valueFrom: {
          secretKeyRef: { name: "udp-datadog-connection-key", key: "api-key" },
        },
      },
    ]);
  });

  it("sink đổi (Datadog → New Relic) ⇒ onDependencyChanged render lại; drift thấy lệch với sink mới", async () => {
    const env = envWith(DATADOG_SINK, { bufferGb: 5 });
    await fluentd.deploy(env.context(), env.fixture.validConfig);
    const res = await fluentd.onDependencyChanged(
      env.context(),
      env.fixture.validConfig,
      NEW_RELIC_SINK,
    );
    expect(res.status).toBe("SUCCESS");
    const values = await valuesOf(env, "udp-fluentd");
    expect(JSON.stringify(values)).toContain("@type newrelic");
    expect(JSON.stringify(values)).not.toContain("@type datadog");
    // Bối cảnh vẫn trỏ sink CŨ ⇒ cấu hình đang chạy lệch với nó: đúng là trôi
    const drift = await fluentd.detectDrift(
      readOnlyContext(env.context()),
      env.fixture.validConfig,
    );
    expect(drift.data?.drifted).toBe(true);
  });
});

describe("validator (AC-5)", () => {
  it("forwarder không có sink ⇒ MISSING_CAPABILITY; có sink ở Monitoring ⇒ hợp lệ", () => {
    for (const forwarder of [fluentBit, fluentd]) {
      const missing = validateAndOrder([forwarder]);
      expect(missing.errors[0]).toMatchObject({
        code: "MISSING_CAPABILITY",
        detail: ["logs.sink"],
      });
      expect(forwarder.capabilities.hint?.["logs.sink"]).toContain(
        "Monitoring",
      );
      for (const sink of [datadog, newRelic]) {
        expect(validateAndOrder([sink, forwarder]).valid).toBe(true);
      }
    }
  });

  it("backend Logging tự mang bộ thu: Loki hợp lệ một mình", () => {
    expect(validateAndOrder([loki]).valid).toBe(true);
  });
});
