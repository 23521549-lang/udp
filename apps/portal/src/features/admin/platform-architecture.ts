import type { AdminSystemWire } from "@udp/shared-types/wire";

/**
 * [Plan #57 QĐ-7] Kiến trúc của CHÍNH nền tảng UDP (C4 container + deployment) — THUẦN, test được không cần DOM.
 *
 * Cạnh là lời gọi có thật trong mã, không phải ước đoán: Service 1 đọc Prometheus của khách theo binding
 * `metrics.query` và cấp token cluster 1 giờ (D-P30, ADR-06); Service 3 xin cả hai qua Service 1, rồi tự vào cluster
 * của khách bằng token đó; Service 1 và Service 3 gọi flag-service qua HTTP nội bộ. Chữ của cạnh là MÃ (`Protocol`),
 * câu nằm ở `admin.messages.tsx` (I37).
 *
 * Bốn khối S1, S2, S3, PostgreSQL gọi nhau đôi một, nên PostgreSQL đứng GIỮA (S1 trên, S2 trái, S3 phải): không cạnh
 * nào chạy xuyên qua thẻ khác; riêng S3 → S2 đi vòng dưới PostgreSQL.
 */

export const PLATFORM_NODES = {
  /** Người dùng UDP và ứng dụng gọi vào (trái), cùng nơi giữ bản sao lưu */
  left: ["developer", "publisher", "sdk", "objectStorage"],
  /** Máy ảo Oracle Always Free chạy k3s */
  vm: ["portal", "s1", "s2", "pg", "s3", "backup"],
  /** Hệ thống của khách mà UDP gọi ra, và pipeline CI của khách gọi vào (phải) */
  right: ["ci", "clouds", "prometheus", "clusters"],
} as const;

export type PlatformNode =
  (typeof PLATFORM_NODES)[keyof typeof PLATFORM_NODES][number];

export type Protocol =
  | "https"
  | "restSse"
  | "sseOfrep"
  | "webhook"
  | "internal"
  | "metricsToken"
  | "sqlQueue"
  | "listenNotify"
  | "sqlLease"
  | "cloudApi"
  | "metricsQuery"
  | "token"
  | "pgDump"
  | "upload";

export interface PlatformLink {
  from: PlatformNode;
  to: PlatformNode;
  protocol: Protocol;
  /** Nét liền: yêu cầu và dữ liệu; nét đứt: điều khiển và telemetry */
  dashed: boolean;
  /** Đi vòng dưới khối ở giữa (hai đầu cùng hàng, giữa là PostgreSQL) */
  under?: true;
}

export const PLATFORM_LINKS: readonly PlatformLink[] = [
  { from: "developer", to: "portal", protocol: "https", dashed: false },
  { from: "publisher", to: "portal", protocol: "https", dashed: false },
  { from: "portal", to: "s1", protocol: "restSse", dashed: false },
  { from: "sdk", to: "s2", protocol: "sseOfrep", dashed: false },
  { from: "ci", to: "s1", protocol: "webhook", dashed: true },
  { from: "s1", to: "s2", protocol: "internal", dashed: true },
  { from: "s3", to: "s1", protocol: "metricsToken", dashed: true },
  { from: "s3", to: "s2", protocol: "internal", dashed: true, under: true },
  { from: "s1", to: "pg", protocol: "sqlQueue", dashed: false },
  { from: "s2", to: "pg", protocol: "listenNotify", dashed: false },
  { from: "s3", to: "pg", protocol: "sqlLease", dashed: false },
  { from: "s1", to: "clouds", protocol: "cloudApi", dashed: true },
  { from: "s1", to: "prometheus", protocol: "metricsQuery", dashed: true },
  { from: "s3", to: "clusters", protocol: "token", dashed: true },
  { from: "backup", to: "pg", protocol: "pgDump", dashed: false },
  { from: "backup", to: "objectStorage", protocol: "upload", dashed: false },
];

/** Tên của ba service trong `GET /admin/system/health` */
const SERVICE_NAME = {
  s1: "udp-core-backend",
  s2: "udp-feature-flag-service",
  s3: "udp-pd-controller",
} as const;

/** Sức khoẻ một service; chưa có dữ liệu hay máy chủ không kể tên đó là "không rõ", không phải "ổn" */
export function serviceState(
  system: AdminSystemWire | undefined,
  node: keyof typeof SERVICE_NAME,
): "up" | "down" | "unknown" {
  return (
    system?.services.find((s) => s.name === SERVICE_NAME[node])?.status ??
    "unknown"
  );
}
