import type {
  ControlModeWire,
  DeliveryTool,
  RolloutThresholds,
  ServiceStrategy,
  TrafficMatch,
} from "@udp/shared-types";
import type { TrafficRouter } from "../../adapter-base/traffic-router.js";

/**
 * Đối tượng giao hàng của rollout SERVICE_LEVEL (§7.2, §7.3) [Plan #51] — thứ Service 1 ghi vào cluster để Argo
 * Rollouts hay Flagger chạy canary theo image. Hàm dựng là THUẦN (không gọi cluster), để I4 kiểm được trên chính
 * đầu ra của chúng.
 */

export interface DeliverySpec {
  sessionId: string;
  tool: DeliveryTool;
  mode: ControlModeWire;
  strategy: ServiceStrategy;
  workloadName: string;
  namespace: string;
  router: TrafficRouter;
  stepPercent: number;
  stepIntervalSeconds: number;
  analysisIntervalSeconds: number;
  metricWindowSeconds: number;
  thresholds: RolloutThresholds;
  trafficMatch?: TrafficMatch;
}

/** Chú thích mà mọi đối tượng giao hàng UDP ghi mang — người vận hành và Luồng 3 đọc chúng */
export const DELIVERY_ANNOTATIONS = {
  session: "udp.io/session-id",
  mode: "udp.io/control-mode",
  strategy: "udp.io/strategy",
  /**
   * Strategy của `Rollout` TRƯỚC session UDP đầu tiên (JSON). Mọi session dựng strategy của mình từ bản gốc này,
   * không từ strategy của session trước; deploy thường (Luồng 3) khôi phục nó khi session đã xong (QĐ-10).
   */
  previousStrategy: "udp.io/previous-strategy",
} as const;

export type Manifest = Record<string, unknown> & {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string } & Record<string, unknown>;
};

/** Trọng số các bậc canary: `step, 2·step, …` dưới 100 — bậc cuối (100%) là promote của công cụ */
export function canaryWeights(stepPercent: number): number[] {
  const weights: number[] = [];
  for (let w = stepPercent; w < 100; w += stepPercent) weights.push(w);
  return weights;
}
