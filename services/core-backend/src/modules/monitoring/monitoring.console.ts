import type { MetricsSource } from "@udp/metrics-provider";
import type { MonitoringConsoleWire } from "@udp/shared-types/wire";
import { serviceTargetOf } from "../cluster/service-proxy-fetch.js";

/**
 * [v4.11, Plan #53 QĐ-4] Cách mở công cụ giám sát của một nguồn `metrics.query` — THUẦN, từ nguồn
 * đã suy (không thêm cấu hình nào):
 *
 * - SaaS: trang web của nhà cung cấp, đúng vùng dữ liệu (Datadog theo `site`, New Relic theo vùng,
 *   Dynatrace là URL môi trường của khách);
 * - trong cluster: LỆNH port-forward. Grafana và Prometheus của tenant không có địa chỉ công khai, và
 *   UDP cố ý không mở một địa chỉ như thế (§12.2: bề mặt công khai tối thiểu);
 * - Grafana Cloud: `null` — điểm PromQL của stack không cho biết địa chỉ Grafana của stack, và một
 *   đường dẫn đoán là một đường dẫn hỏng.
 */
export function consoleOf(
  source: MetricsSource,
  providedBy: string,
): MonitoringConsoleWire | null {
  switch (source.kind) {
    case "datadog":
      return {
        kind: "url",
        label: "Mở Datadog",
        // Site vùng (ap1.…) là host của chính nó; site gốc có tiền tố app.
        url:
          source.site.split(".").length > 2
            ? `https://${source.site}`
            : `https://app.${source.site}`,
      };
    case "newrelic":
      return {
        kind: "url",
        label: "Mở New Relic",
        url:
          source.region === "EU"
            ? "https://one.eu.newrelic.com"
            : "https://one.newrelic.com",
      };
    case "dynatrace":
      return {
        kind: "url",
        label: "Mở Dynatrace",
        url: source.environmentUrl,
      };
    case "prometheus": {
      if (!source.inCluster) return null;
      const target = serviceTargetOf(source.baseUrl);
      if (providedBy === "monitoring:prometheus-grafana") {
        /**
         * kube-prometheus-stack đặt tên dịch vụ theo release: `<release>-prometheus` cho Prometheus,
         * `<release>-grafana` cho Grafana (cổng 80). Suy release từ chính endpoint của binding.
         */
        const release = target.service.replace(/-prometheus$/, "");
        return {
          kind: "portForward",
          label: "Mở Grafana",
          command: `kubectl -n ${target.namespace} port-forward svc/${release}-grafana 3000:80`,
          localUrl: "http://localhost:3000",
        };
      }
      const ui =
        providedBy === "monitoring:victoria-metrics" ? "/vmui" : "/graph";
      return {
        kind: "portForward",
        label: "Mở giao diện truy vấn",
        command: `kubectl -n ${target.namespace} port-forward svc/${target.service} ${String(target.port)}:${String(target.port)}`,
        localUrl: `http://localhost:${String(target.port)}${ui}`,
      };
    }
  }
}
