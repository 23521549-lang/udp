import type { LogsSink } from "./logs-sink.js";

/**
 * Output của bộ forwarder (Fluent Bit, Fluentd) theo `logs.sink` đã resolve (Plan #32 AC-4).
 *
 * Một hàm THUẦN cho mỗi forwarder, để mỗi giao thức kiểm được bằng một test không cần cluster.
 * Khoá không bao giờ nằm trong cấu hình render ra: forwarder đọc nó từ biến môi trường
 * `SINK_SECRET`, và biến đó lấy từ `secretKeyRef` tới `Secret` mà provider đã khai.
 *
 * Giá trị ghép vào cấu hình chỉ đến từ `URL` đã phân tích (host, port, path) và hằng của
 * provider — không một ký tự xuống dòng nào đi vào được, nên không ai chèn thêm một khối
 * `[OUTPUT]` hay `<match>` qua endpoint.
 */

export const SINK_SECRET_ENV = "SINK_SECRET";

export interface ForwarderOutput {
  /** Văn bản cấu hình output của forwarder */
  config: string;
  /** Biến môi trường cho pod forwarder — khoá qua `secretKeyRef`, không giá trị */
  env: {
    name: string;
    valueFrom: { secretKeyRef: { name: string; key: string } };
  }[];
}

/** Giao thức cần khoá — thiếu `credential` là lỗi của provider, không đoán */
const NEEDS_CREDENTIAL = new Set([
  "elasticsearch",
  "opensearch",
  "splunk-hec",
  "datadog",
  "newrelic",
  "dynatrace",
]);

function partsOf(sink: LogsSink) {
  const url = new URL(sink.endpoint);
  const tls = url.protocol === "https:";
  return {
    url,
    host: url.hostname,
    port: url.port === "" ? (tls ? "443" : "80") : url.port,
    path: url.pathname,
    tls,
  };
}

function envOf(sink: LogsSink): ForwarderOutput["env"] {
  if (sink.credential === undefined) {
    if (NEEDS_CREDENTIAL.has(sink.protocol)) {
      throw new Error(`logs.sink ${sink.protocol} thiếu Secret chứa khoá`);
    }
    return [];
  }
  return [
    {
      name: SINK_SECRET_ENV,
      valueFrom: {
        secretKeyRef: {
          name: sink.credential.secretName,
          key: sink.credential.secretKey,
        },
      },
    },
  ];
}

const block = (header: string, lines: readonly [string, string][]): string =>
  [header, ...lines.map(([k, v]) => `    ${k.padEnd(18)} ${v}`)].join("\n");

/** Khối `[OUTPUT]` của Fluent Bit */
export function fluentBitOutput(sink: LogsSink): ForwarderOutput {
  const env = envOf(sink);
  const { url, host, port, path, tls } = partsOf(sink);
  const secret = `\${${SINK_SECRET_ENV}}`;
  const on = tls ? "On" : "Off";
  const common: [string, string][] = [
    ["Match", "kube.*"],
    ["Host", host],
    ["Port", port],
    ["tls", on],
  ];
  const lines: Record<LogsSink["protocol"], [string, string][]> = {
    loki: [["Name", "loki"], ...common, ["Uri", path], ["labels", "job=udp"]],
    elasticsearch: [
      ["Name", "es"],
      ...common,
      ["HTTP_User", sink.credential?.username ?? "elastic"],
      ["HTTP_Passwd", secret],
      ["Suppress_Type_Name", "On"],
      ["Logstash_Format", "On"],
    ],
    opensearch: [
      ["Name", "opensearch"],
      ...common,
      ["HTTP_User", sink.credential?.username ?? "admin"],
      ["HTTP_Passwd", secret],
      ["Suppress_Type_Name", "On"],
      ["Logstash_Format", "On"],
    ],
    "splunk-hec": [["Name", "splunk"], ...common, ["Splunk_Token", secret]],
    datadog: [
      ["Name", "datadog"],
      ...common,
      ["apikey", secret],
      ["compress", "gzip"],
    ],
    newrelic: [
      ["Name", "nrlogs"],
      ["Match", "kube.*"],
      ["base_uri", url.href],
      ["license_key", secret],
    ],
    dynatrace: [
      ["Name", "http"],
      ...common,
      ["URI", path],
      ["Header", `Authorization Api-Token ${secret}`],
      ["Format", "json"],
      ["json_date_key", "timestamp"],
    ],
  };
  return { config: block("[OUTPUT]", lines[sink.protocol]), env };
}

/** Khối `<match>` của Fluentd */
export function fluentdOutput(sink: LogsSink): ForwarderOutput {
  const env = envOf(sink);
  const { url, host, port, tls } = partsOf(sink);
  const secret = `"#{ENV['${SINK_SECRET_ENV}']}"`;
  const scheme = tls ? "https" : "http";
  const lines: Record<LogsSink["protocol"], string[]> = {
    loki: ["@type loki", `url "${url.origin}"`, 'extra_labels {"job":"udp"}'],
    elasticsearch: [
      "@type elasticsearch",
      `host ${host}`,
      `port ${port}`,
      `scheme ${scheme}`,
      `user ${sink.credential?.username ?? "elastic"}`,
      `password ${secret}`,
      "logstash_format true",
    ],
    opensearch: [
      "@type opensearch",
      `host ${host}`,
      `port ${port}`,
      `scheme ${scheme}`,
      `user ${sink.credential?.username ?? "admin"}`,
      `password ${secret}`,
      "logstash_format true",
    ],
    "splunk-hec": [
      "@type splunk_hec",
      `hec_host ${host}`,
      `hec_port ${port}`,
      `protocol ${scheme}`,
      `hec_token ${secret}`,
    ],
    datadog: ["@type datadog", `host ${host}`, `api_key ${secret}`],
    newrelic: [
      "@type newrelic",
      `base_uri ${url.href}`,
      `license_key ${secret}`,
    ],
    dynatrace: [
      "@type http",
      `endpoint ${url.href}`,
      `headers "{\\"Authorization\\":\\"Api-Token #{ENV['${SINK_SECRET_ENV}']}\\"}"`,
      "json_array true",
      "<format>",
      "  @type json",
      "</format>",
    ],
  };
  return {
    config: [
      "<match kubernetes.**>",
      ...lines[sink.protocol].map((l) => `  ${l}`),
      "</match>",
    ].join("\n"),
    env,
  };
}
