import type { CapabilityBinding } from "@udp/shared-types";

/**
 * Hợp đồng dây của `logs.sink@1` (Plan #32 QĐ-3) — binding nói GIAO THỨC và CHỖ ĐỂ KHOÁ.
 *
 * Consumer của log là bộ forwarder đa giao thức (Fluent Bit, Fluentd), không phải một SDK
 * một giao thức như trace, nên major của capability giữ 1 và giao thức nằm trong
 * `attributes.protocol`. Khoá (nếu có) chỉ là TÊN `Secret` + khoá trong `udp-system` — forwarder
 * mount bằng `secretKeyRef`; giá trị không bao giờ nằm trong bảng `capability_bindings`.
 */

export const LOGS_SINK_PROTOCOLS = [
  "loki",
  "elasticsearch",
  "opensearch",
  "splunk-hec",
  "datadog",
  "newrelic",
  "dynatrace",
] as const;
export type LogsSinkProtocol = (typeof LOGS_SINK_PROTOCOLS)[number];

export interface LogsSinkCredential {
  /** `Secret` trong `udp-system` — cùng namespace với forwarder */
  secretName: string;
  secretKey: string;
  /** Tên đăng nhập đi kèm (Elasticsearch `elastic`, OpenSearch `admin`) */
  username?: string;
}

export interface LogsSink {
  protocol: LogsSinkProtocol;
  endpoint: string;
  credential?: LogsSinkCredential;
}

/** Binding `logs.sink@1` của một provider */
export function logsSinkBinding(
  providedBy: string,
  sink: LogsSink,
): CapabilityBinding {
  return {
    id: "logs.sink",
    version: "1.0.0",
    providedBy,
    endpoint: sink.endpoint,
    attributes: {
      protocol: sink.protocol,
      ...(sink.credential === undefined
        ? {}
        : {
            secretName: sink.credential.secretName,
            secretKey: sink.credential.secretKey,
            ...(sink.credential.username === undefined
              ? {}
              : { username: sink.credential.username }),
          }),
    },
  };
}

const isProtocol = (value: unknown): value is LogsSinkProtocol =>
  typeof value === "string" &&
  (LOGS_SINK_PROTOCOLS as readonly string[]).includes(value);

/**
 * Đọc lại sink từ binding đã resolve — NÉM khi thiếu hay lạ: forwarder đoán giao thức là gửi
 * log vào một endpoint không hiểu chúng, và lỗi đó chỉ lộ ra khi người ta cần log.
 */
export function logsSinkOf(binding: CapabilityBinding | undefined): LogsSink {
  if (binding === undefined) {
    throw new Error("thiếu binding logs.sink trong ctx.resolved");
  }
  const attributes = binding.attributes ?? {};
  const protocol = attributes.protocol;
  if (binding.endpoint === undefined || !isProtocol(protocol)) {
    throw new Error(
      `binding logs.sink của ${binding.providedBy} không nói giao thức hay endpoint`,
    );
  }
  const { secretName, secretKey, username } = attributes;
  return {
    protocol,
    endpoint: binding.endpoint,
    ...(secretName === undefined || secretKey === undefined
      ? {}
      : {
          credential: {
            secretName,
            secretKey,
            ...(username === undefined ? {} : { username }),
          },
        }),
  };
}
