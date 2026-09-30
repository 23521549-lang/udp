import type { ReactNode } from "react";
import { count, defineMessages, plural } from "../../i18n";
import { formatDecimal, formatNumber, formatPercent } from "../../lib/format";
import type { LinkKind, SystemZone } from "./system-model";

/** [Plan #57] Chữ của bộ chọn góc nhìn và góc "Tổng quan hệ thống" của trang Kiến trúc */
export const systemMessages = defineMessages({
  vi: {
    views: {
      label: "Góc nhìn",
      system: "Tổng quan hệ thống",
      infra: "Hạ tầng & công cụ",
    },
    lead: "Yêu cầu vào từ đâu, chảy qua đâu, dữ liệu nằm đâu: giao hàng phía trên, quan sát phía dưới, quản trị bên phải.",
    kpi: {
      label: "Số liệu chính",
      tools: "Công cụ",
      toolsSub: (ok: number, warn: number, error: number) =>
        `${formatNumber(ok)} ổn, ${formatNumber(warn)} cần xem, ${formatNumber(error)} lỗi`,
      workloads: "Workload",
      workloadsSub: (envs: number) => `trên ${formatNumber(envs)} environment`,
      deploys: "Deploy 14 ngày",
      deploysSub: (failure: number) => `${formatNumber(failure)} thất bại`,
      success: "Thành công",
      failure: "Thất bại",
      red: (env: string, range: string) => `${env}, ${range} qua`,
      redSub: (errorRatio: number | null, rate: number | null) =>
        [
          errorRatio === null
            ? "lỗi chưa rõ"
            : `lỗi ${formatPercent(errorRatio)}`,
          rate === null ? null : `${formatDecimal(rate)} yêu cầu/giây`,
        ]
          .filter(Boolean)
          .join(", "),
      redNone: "Production",
      p99: (ms: number | null) =>
        ms === null ? "p99 chưa rõ" : `p99 ${formatNumber(Math.round(ms))} ms`,
      redLoading: "Đang đọc metrics",
      noProduction: "Project chưa có environment production.",
      noMetrics: (link: ReactNode) => <>Chưa có nguồn metrics. {link}</>,
      toDomains: "Bật ở trang Domain",
      noData: (range: string) => `Chưa có dữ liệu trong ${range} qua.`,
      redError: "Không đọc được metrics lúc này.",
    },
    legend: {
      solid: "yêu cầu, dữ liệu",
      dashed: "giao hàng, điều khiển, telemetry",
      note: "Cạnh là vai trò suy từ domain đang bật, không phải lưu lượng đo được.",
    },
    zone: {
      delivery: "Giao hàng",
      traffic: "Lưu lượng",
      data: "Dữ liệu",
      observe: "Quan sát",
      govern: "Quản trị",
    } satisfies Record<SystemZone, string>,
    zoneEmpty: "Chưa bật domain nào",
    environments: "Environment",
    users: "Người dùng cuối",
    usersSub: "qua Internet",
    git: "Mã nguồn",
    gitSub: "git push",
    production: "production",
    noWorkloads: "Chưa có workload",
    openDeploys: (workload: string, env: string) =>
      `${workload} ở ${env}: mở trang Deploy`,
    link: {
      https: "HTTPS",
      route: "định tuyến",
      mtls: "mTLS",
      sql: "SQL",
      secrets: "bí mật",
      metrics: "metrics",
      logs: "logs",
      traces: "traces",
      webhook: "webhook",
      push: "đẩy image",
      publish: "đẩy gói",
      tag: "tag mới",
      sync: "sync",
      canary: "canary",
    } satisfies Record<LinkKind, string>,
    table: {
      show: "Xem dạng bảng",
      hide: "Xem dạng sơ đồ",
      components: "Thành phần",
      connections: "Kết nối",
      zone: "Vùng",
      component: "Thành phần",
      tool: "Công cụ",
      status: "Trạng thái",
      from: "Từ",
      to: "Tới",
      role: "Vai trò",
      line: "Loại",
      actor: "Tác nhân",
      notATool: "không phải công cụ",
      workloads: (n: number) => `${formatNumber(n)} workload`,
    },
  },
  en: {
    views: {
      label: "View",
      system: "System overview",
      infra: "Infrastructure & tools",
    },
    lead: "Where requests come in, where they flow, where data lives: delivery on top, observability below, governance on the right.",
    kpi: {
      label: "Key figures",
      tools: "Tools",
      toolsSub: (ok: number, warn: number, error: number) =>
        `${formatNumber(ok)} healthy, ${formatNumber(warn)} ${plural(warn, "needs", "need")} attention, ${formatNumber(error)} in error`,
      workloads: "Workloads",
      workloadsSub: (envs: number) =>
        `across ${count(envs, "environment", "environments")}`,
      deploys: "Deployments, 14 days",
      deploysSub: (failure: number) => `${formatNumber(failure)} failed`,
      success: "Succeeded",
      failure: "Failed",
      red: (env: string, range: string) => `${env}, last ${range}`,
      redSub: (errorRatio: number | null, rate: number | null) =>
        [
          errorRatio === null
            ? "error rate unknown"
            : `${formatPercent(errorRatio)} errors`,
          rate === null ? null : `${formatDecimal(rate)} requests/s`,
        ]
          .filter(Boolean)
          .join(", "),
      redNone: "Production",
      p99: (ms: number | null) =>
        ms === null ? "p99 unknown" : `p99 ${formatNumber(Math.round(ms))} ms`,
      redLoading: "Reading metrics",
      noProduction: "The project has no production environment.",
      noMetrics: (link: ReactNode) => <>No metrics source yet. {link}</>,
      toDomains: "Enable it on the Domains page",
      noData: (range: string) => `No data in the last ${range}.`,
      redError: "Metrics cannot be read right now.",
    },
    legend: {
      solid: "requests, data",
      dashed: "delivery, control, telemetry",
      note: "Edges are roles inferred from the enabled domains, not measured traffic.",
    },
    zone: {
      delivery: "Delivery",
      traffic: "Traffic",
      data: "Data",
      observe: "Observability",
      govern: "Governance",
    },
    zoneEmpty: "No domain enabled",
    environments: "Environments",
    users: "End users",
    usersSub: "over the Internet",
    git: "Source code",
    gitSub: "git push",
    production: "production",
    noWorkloads: "No workloads yet",
    openDeploys: (workload: string, env: string) =>
      `${workload} in ${env}: open the Deployments page`,
    link: {
      https: "HTTPS",
      route: "routes",
      mtls: "mTLS",
      sql: "SQL",
      secrets: "secrets",
      metrics: "metrics",
      logs: "logs",
      traces: "traces",
      webhook: "webhook",
      push: "push image",
      publish: "publish",
      tag: "new tag",
      sync: "sync",
      canary: "canary",
    },
    table: {
      show: "View as table",
      hide: "View as diagram",
      components: "Components",
      connections: "Connections",
      zone: "Zone",
      component: "Component",
      tool: "Tool",
      status: "Status",
      from: "From",
      to: "To",
      role: "Role",
      line: "Kind",
      actor: "Actor",
      notATool: "not a tool",
      workloads: (n: number) => count(n, "workload", "workloads"),
    },
  },
});
