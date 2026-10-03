import type { MonitoringConsoleWire, RedRange } from "@udp/shared-types/wire";
import type { ReactNode } from "react";
import { count, defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

/** Chữ của trang Giám sát */
export const monitoringMessages = defineMessages({
  vi: {
    title: "Giám sát",
    lead: (env: string) =>
      `Request, lỗi và độ trễ của workload ở ${env}, cùng lượt đánh giá flag, sức khoẻ domain và chỉ số deploy.`,
    rangeLabel: "Khoảng thời gian",
    range: {
      "1h": "1 giờ",
      "6h": "6 giờ",
      "24h": "24 giờ",
      "7d": "7 ngày",
    } satisfies Record<RedRange, string>,
    doraTitle: (days: number) => `Deploy ${formatNumber(days)} ngày`,
    deployHistory: "Lịch sử deploy",
    red: {
      /** Nút mở công cụ giám sát — máy chủ chỉ gửi MÃ công cụ (I37) */
      openApp: {
        datadog: "Mở Datadog",
        newrelic: "Mở New Relic",
        dynatrace: "Mở Dynatrace",
        grafana: "Mở Grafana",
        "query-ui": "Mở giao diện truy vấn",
      } satisfies Record<MonitoringConsoleWire["app"], string>,
      title: "Workload",
      source: (tool: ReactNode, step: string) => (
        <>
          Nguồn {tool}, mỗi điểm {step}
        </>
      ),
      noMetricsTitle: "Chưa có nguồn metrics",
      noMetrics: (link: ReactNode) => (
        <>
          Bật domain Giám sát với Prometheus, VictoriaMetrics hay một dịch vụ
          SaaS (Datadog, New Relic, Dynatrace, Grafana Cloud) để thấy request,
          lỗi và độ trễ. {link}
        </>
      ),
      toDomains: "Tới trang Domain",
      noWorkloadsTitle: "Chưa có workload nào",
      noWorkloads: "Workload hiện ở đây sau lần deploy đầu tiên qua UDP.",
      portForward: (url: ReactNode) => (
        <>
          Công cụ giám sát chạy trong cluster và không có địa chỉ công khai.
          Chạy lệnh dưới đây rồi mở {url}.
        </>
      ),
      workload: (name: string) => `Workload ${name}`,
      requestRate: "Request mỗi giây",
      requestRateSeries: "Request/giây",
      errorRate: "Tỉ lệ lỗi 5xx",
      errorRateSeries: "Tỉ lệ lỗi",
      latency: "Độ trễ p99",
    },
    flags: {
      title: "Lượt đánh giá flag",
      none: "Project chưa có flag nào.",
      noStats:
        "Chưa đọc được số lượt đánh giá: dịch vụ đánh giá flag không trả lời.",
      daily: "Tổng theo ngày, 14 ngày",
      evaluations: "Lượt đánh giá",
      topTitle: "Dùng nhiều nhất 7 ngày",
      topNone: "Chưa flag nào được đánh giá trong 7 ngày.",
      topList: "Flag dùng nhiều nhất",
      basedOn: (shown: number, total: number) =>
        `Tính trên ${formatNumber(shown)} trong ${formatNumber(total)} flag.`,
    },
    health: {
      title: "Sức khoẻ domain",
      none: "Project chưa bật domain nào.",
    },
    cost: {
      title: (days: number) => `Chi phí ${formatNumber(days)} ngày`,
      total: (usd: string) => `Tổng ${usd}`,
      notEnabled: (link: ReactNode) => <>Chưa bật Cost Management. {link}</>,
      enableLink: "Bật OpenCost hay Kubecost ở trang Domain",
      daily: "Chi phí theo ngày",
      series: "Chi phí",
    },
  },
  en: {
    title: "Monitoring",
    lead: (env: string) =>
      `Requests, errors and latency of workloads in ${env}, plus flag evaluations, domain health and deployment metrics.`,
    rangeLabel: "Time range",
    range: {
      "1h": "1 hour",
      "6h": "6 hours",
      "24h": "24 hours",
      "7d": "7 days",
    },
    doraTitle: (days: number) => `Deployments, ${formatNumber(days)} days`,
    deployHistory: "Deployment history",
    red: {
      openApp: {
        datadog: "Open Datadog",
        newrelic: "Open New Relic",
        dynatrace: "Open Dynatrace",
        grafana: "Open Grafana",
        "query-ui": "Open the query UI",
      },
      title: "Workloads",
      source: (tool: ReactNode, step: string) => (
        <>
          Source {tool}, one point every {step}
        </>
      ),
      noMetricsTitle: "No metrics source yet",
      noMetrics: (link: ReactNode) => (
        <>
          Enable the Monitoring domain with Prometheus, VictoriaMetrics or a
          SaaS service (Datadog, New Relic, Dynatrace, Grafana Cloud) to see
          requests, errors and latency. {link}
        </>
      ),
      toDomains: "Go to Domains",
      noWorkloadsTitle: "No workloads yet",
      noWorkloads:
        "Workloads appear here after the first deployment through UDP.",
      portForward: (url: ReactNode) => (
        <>
          The monitoring tool runs inside the cluster and has no public address.
          Run the command below, then open {url}.
        </>
      ),
      workload: (name: string) => `Workload ${name}`,
      requestRate: "Requests per second",
      requestRateSeries: "Requests/s",
      errorRate: "5xx error rate",
      errorRateSeries: "Error rate",
      latency: "p99 latency",
    },
    flags: {
      title: "Flag evaluations",
      none: "The project has no flags yet.",
      noStats:
        "Could not read evaluation counts: the flag evaluation service is not responding.",
      daily: "Daily total, 14 days",
      evaluations: "Evaluations",
      topTitle: "Most used, 7 days",
      topNone: "No flag was evaluated in the last 7 days.",
      topList: "Most used flags",
      basedOn: (shown: number, total: number) =>
        `Based on ${formatNumber(shown)} of ${count(total, "flag", "flags")}.`,
    },
    health: {
      title: "Domain health",
      none: "The project has no domains enabled.",
    },
    cost: {
      title: (days: number) => `Cost, ${formatNumber(days)} days`,
      total: (usd: string) => `Total ${usd}`,
      notEnabled: (link: ReactNode) => (
        <>Cost Management is not enabled. {link}</>
      ),
      enableLink: "Enable OpenCost or Kubecost on the Domains page",
      daily: "Daily cost",
      series: "Cost",
    },
  },
});
