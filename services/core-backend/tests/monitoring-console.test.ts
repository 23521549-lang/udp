import { describe, expect, it } from "vitest";
import { consoleOf } from "../src/modules/monitoring/monitoring.console.js";
import {
  redGrid,
  RED_WINDOWS,
} from "../src/modules/monitoring/monitoring.service.js";

/**
 * [Plan #53 QĐ-4] Đường mở công cụ giám sát (thuần, từ nguồn đã suy) và lưới điểm của trang Giám sát.
 */
describe("đường mở công cụ giám sát", () => {
  it("SaaS: trang web đúng vùng dữ liệu", () => {
    expect(
      consoleOf(
        { kind: "datadog", site: "datadoghq.eu", apiKey: "k", appKey: "a" },
        "monitoring:datadog",
      ),
    ).toEqual({
      kind: "url",
      app: "datadog",
      url: "https://app.datadoghq.eu",
    });
    expect(
      consoleOf(
        {
          kind: "datadog",
          site: "ap1.datadoghq.com",
          apiKey: "k",
          appKey: "a",
        },
        "monitoring:datadog",
      ),
    ).toMatchObject({ url: "https://ap1.datadoghq.com" });
    expect(
      consoleOf(
        { kind: "newrelic", region: "EU", accountId: 1, apiKey: "k" },
        "monitoring:newrelic",
      ),
    ).toMatchObject({ url: "https://one.eu.newrelic.com" });
    expect(
      consoleOf(
        {
          kind: "dynatrace",
          environmentUrl: "https://abc12345.live.dynatrace.com",
          apiToken: "t",
        },
        "monitoring:dynatrace",
      ),
    ).toMatchObject({ url: "https://abc12345.live.dynatrace.com" });
  });

  it("trong cụm: lệnh port-forward — Grafana của kube-prometheus-stack, giao diện vmui của VictoriaMetrics", () => {
    expect(
      consoleOf(
        {
          kind: "prometheus",
          baseUrl: "http://udp-prometheus-prometheus.udp-system:9090",
          inCluster: true,
        },
        "monitoring:prometheus-grafana",
      ),
    ).toEqual({
      kind: "portForward",
      app: "grafana",
      command:
        "kubectl -n udp-system port-forward svc/udp-prometheus-grafana 3000:80",
      localUrl: "http://localhost:3000",
    });
    expect(
      consoleOf(
        {
          kind: "prometheus",
          baseUrl:
            "http://udp-vm-victoria-metrics-single-server.udp-system:8428",
          inCluster: true,
        },
        "monitoring:victoria-metrics",
      ),
    ).toMatchObject({
      command:
        "kubectl -n udp-system port-forward svc/udp-vm-victoria-metrics-single-server 8428:8428",
      localUrl: "http://localhost:8428/vmui",
    });
  });

  it("Grafana Cloud: không đoán địa chỉ Grafana của stack", () => {
    expect(
      consoleOf(
        {
          kind: "prometheus",
          baseUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom",
          inCluster: false,
        },
        "monitoring:grafana-cloud",
      ),
    ).toBeNull();
  });
});

describe("lưới điểm", () => {
  it("mốc chia hết cho bước, đủ điểm cho mỗi khoảng nhìn (≤ 169)", () => {
    const end = new Date("2026-09-30T10:07:30Z");
    for (const { rangeSec, stepSec } of Object.values(RED_WINDOWS)) {
      const g = redGrid(end, rangeSec, stepSec);
      expect(g.startSec % stepSec).toBe(0);
      expect(g.points).toBeLessThanOrEqual(169);
      expect(g.points).toBeGreaterThanOrEqual(rangeSec / stepSec);
    }
    expect(redGrid(end, 3600, 60)).toEqual({
      startSec: Math.floor((end.getTime() / 1000 - 3600) / 60) * 60,
      points: 61,
    });
  });
});
