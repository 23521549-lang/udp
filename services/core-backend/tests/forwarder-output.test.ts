import {
  CONTRACT_SYSTEM_NAMESPACE,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import {
  fluentBitOutput,
  fluentdOutput,
  SINK_SECRET_ENV,
} from "../src/modules/adapter-base/forwarder-output.js";
import {
  LOGS_SINK_PROTOCOLS,
  logsSinkBinding,
  logsSinkOf,
  type LogsSink,
} from "../src/modules/adapter-base/logs-sink.js";
import datadog from "../src/modules/monitoring-adapter/datadog/index.js";
import dynatrace from "../src/modules/monitoring-adapter/dynatrace/index.js";
import newRelic from "../src/modules/monitoring-adapter/newrelic/index.js";

/**
 * Plan #32 AC-3, AC-4 — hợp đồng dây `logs.sink@1` và output của hai forwarder, thuần: mỗi giao
 * thức một ô, khoá chỉ qua `secretKeyRef`, endpoint không chèn được cấu hình.
 */

const credential = { secretName: "udp-x-secrets", secretKey: "k" };
const SINKS: Record<LogsSink["protocol"], LogsSink> = {
  loki: {
    protocol: "loki",
    endpoint: "http://udp-loki-gateway.udp-system/loki/api/v1/push",
  },
  elasticsearch: {
    protocol: "elasticsearch",
    endpoint: "https://udp-elk-es-http.udp-system:9200",
    credential: { ...credential, username: "elastic" },
  },
  opensearch: {
    protocol: "opensearch",
    endpoint: "https://opensearch-cluster-master.udp-system:9200",
    credential: { ...credential, username: "admin" },
  },
  "splunk-hec": {
    protocol: "splunk-hec",
    endpoint: "https://http-inputs-acme.splunkcloud.com/services/collector",
    credential,
  },
  datadog: {
    protocol: "datadog",
    endpoint: "https://http-intake.logs.datadoghq.eu/api/v2/logs",
    credential,
  },
  newrelic: {
    protocol: "newrelic",
    endpoint: "https://log-api.eu.newrelic.com/log/v1",
    credential,
  },
  dynatrace: {
    protocol: "dynatrace",
    endpoint: "https://abc12345.live.dynatrace.com/api/v2/logs/ingest",
    credential,
  },
};

describe("logs.sink@1 — binding mang giao thức và TÊN chỗ để khoá", () => {
  it("đi một vòng binding ⇄ sink không mất gì, cho MỌI giao thức", () => {
    for (const protocol of LOGS_SINK_PROTOCOLS) {
      const sink = SINKS[protocol];
      expect(logsSinkOf(logsSinkBinding("logging:x", sink))).toEqual(sink);
    }
  });

  it("thiếu binding, thiếu giao thức hay giao thức lạ ⇒ NÉM, không đoán", () => {
    expect(() => logsSinkOf(undefined)).toThrow(/thiếu binding logs.sink/);
    expect(() =>
      logsSinkOf({
        id: "logs.sink",
        version: "1.0.0",
        providedBy: "x:y",
        endpoint: "http://a",
      }),
    ).toThrow(/không nói giao thức/);
    expect(() =>
      logsSinkOf({
        id: "logs.sink",
        version: "1.0.0",
        providedBy: "x:y",
        endpoint: "http://a",
        attributes: { protocol: "syslog" },
      }),
    ).toThrow(/không nói giao thức/);
  });
});

describe("output của forwarder theo giao thức (AC-4)", () => {
  const plugin = {
    loki: ["loki", "@type loki"],
    elasticsearch: ["es", "@type elasticsearch"],
    opensearch: ["opensearch", "@type opensearch"],
    "splunk-hec": ["splunk", "@type splunk_hec"],
    datadog: ["datadog", "@type datadog"],
    newrelic: ["nrlogs", "@type newrelic"],
    dynatrace: ["http", "@type http"],
  } as const;

  it("mỗi giao thức đúng plugin của Fluent Bit và Fluentd; khoá qua biến môi trường, không giá trị", () => {
    for (const protocol of LOGS_SINK_PROTOCOLS) {
      const sink = SINKS[protocol];
      const [bit, fluentd] = plugin[protocol];
      const a = fluentBitOutput(sink);
      const b = fluentdOutput(sink);
      expect(a.config).toMatch(new RegExp(`Name\\s+${bit}\\n`));
      expect(b.config).toContain(fluentd);
      const env =
        sink.credential === undefined
          ? []
          : [
              {
                name: SINK_SECRET_ENV,
                valueFrom: {
                  secretKeyRef: { name: "udp-x-secrets", key: "k" },
                },
              },
            ];
      expect(a.env).toEqual(env);
      expect(b.env).toEqual(env);
      if (sink.credential !== undefined) {
        expect(a.config).toContain(`\${${SINK_SECRET_ENV}}`);
        expect(b.config).toContain(`#{ENV['${SINK_SECRET_ENV}']}`);
      }
    }
  });

  it("giao thức cần khoá mà provider không khai Secret ⇒ NÉM", () => {
    const { credential: _drop, ...bare } = SINKS.datadog;
    void _drop;
    expect(() => fluentBitOutput(bare)).toThrow(/thiếu Secret/);
    expect(() => fluentdOutput(bare)).toThrow(/thiếu Secret/);
  });

  it("endpoint không chèn được một khối cấu hình mới", () => {
    const evil: LogsSink = {
      ...SINKS.newrelic,
      endpoint:
        "https://log-api.newrelic.com/log/v1\n[OUTPUT]\n    Name stdout",
    };
    // URL đã phân tích bỏ mọi ký tự xuống dòng: không dòng nào mở được khối thứ hai
    const opening = (text: string, head: string) =>
      text.split("\n").filter((line) => line.trimStart().startsWith(head));
    expect(opening(fluentBitOutput(evil).config, "[OUTPUT]")).toHaveLength(1);
    expect(opening(fluentBitOutput(evil).config, "Name ")).toHaveLength(1);
    expect(opening(fluentdOutput(evil).config, "<match")).toHaveLength(1);
  });
});

describe("provider logs.sink ở Monitoring trỏ tới Secret CÓ THẬT (AC-3)", () => {
  const cases = [
    {
      adapter: datadog,
      hosts: ["api.datadoghq.com"],
      config: {
        site: "datadoghq.com",
        apiKey: "0123456789abcdef0123456789abcdef",
        appKey: "fedcba9876543210fedcba9876543210fedcba98",
      },
    },
    {
      adapter: newRelic,
      hosts: [],
      config: {
        accountId: 1,
        region: "US",
        licenseKey: "a".repeat(40),
        // Ghép từ hai phần — lý do ở `monitoring-adapter/newrelic/contract.test.ts`
        userKey: ["NRAK", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0"].join("-"),
      },
    },
    {
      adapter: dynatrace,
      hosts: [],
      config: {
        environmentUrl: "https://abc12345.live.dynatrace.com",
        apiToken: `dt0c01.${"A".repeat(24)}.${"A".repeat(64)}`,
        dataIngestToken: `dt0c01.${"B".repeat(24)}.${"B".repeat(64)}`,
      },
    },
  ];

  it("binding nói giao thức; Secret + khoá nó nêu có mặt sau deploy", async () => {
    for (const { adapter, hosts, config } of cases) {
      const env = domainContractEnv({
        validConfig: config,
        invalidConfigs: [],
        externalHosts: hosts,
        quotaDimensions: [],
        ignoredLabelPrefixes: [],
        driftMutations: [],
      });
      const res = await adapter.deploy(env.context(), config);
      expect(res.status).toBe("SUCCESS");
      const sink = logsSinkOf(res.data?.find((b) => b.id === "logs.sink"));
      expect(sink.credential).toBeDefined();
      const client = await env.cluster.getClient("tooling");
      const secret = await client.read<{ stringData: Record<string, string> }>(
        "get",
        {
          apiVersion: "v1",
          kind: "Secret",
          namespace: CONTRACT_SYSTEM_NAMESPACE,
          name: sink.credential?.secretName ?? "",
        },
      );
      expect(
        Object.keys(secret?.stringData ?? {}),
        `${adapter.toolId}: ${String(sink.credential?.secretName)}`,
      ).toContain(sink.credential?.secretKey);
    }
  });
});
