import { flaggerGatePath, type FlaggerGate } from "@udp/http";
import {
  canaryWeights,
  DELIVERY_ANNOTATIONS,
  type DeliverySpec,
  type Manifest,
} from "./delivery.types.js";

/**
 * `Canary` của Flagger cho một session SERVICE_LEVEL (§7.3) [Plan #51 QĐ-6] — trỏ `Deployment` của workload;
 * Flagger tự dựng `<workload>-primary` và các service.
 *
 * - **udp-driven**: KHÔNG metrics — Service 3 là bên phân tích; Flagger hỏi Service 3 qua webhook gate trước mỗi
 *   lần tăng traffic, trước khi promote, và ở mỗi vòng xem có rollback không (ADR-01: tool ghi routing, UDP quyết).
 * - **tool-driven**: metrics dựng sẵn của Flagger theo ngưỡng của session; chỉ một gate `rollback` — đường duy
 *   nhất để ROLLBACK bằng tay tới được Flagger (Flagger không có API promote/abort).
 * - **ATTRIBUTE_SPLIT** = A/B của Flagger (`analysis.match` theo header, `iterations`): không tự quyết (§7.2) ⇒
 *   udp-driven gate `confirm-promotion` chỉ mở khi người dùng PROMOTE.
 */

export interface GateTarget {
  /** URL gốc của Service 3 nhìn từ cluster tenant (`PD_CONTROLLER_WEBHOOK_URL`) */
  baseUrl: string;
  /** `flaggerGateToken(bí mật nội bộ, sessionId)` */
  token: string;
}

function gatesOf(spec: DeliverySpec): FlaggerGate[] {
  if (spec.mode === "tool-driven") return ["rollback"];
  return spec.strategy === "ATTRIBUTE_SPLIT"
    ? ["confirm-promotion", "rollback"]
    : ["confirm-traffic-increase", "confirm-promotion", "rollback"];
}

function metricsOf(spec: DeliverySpec): Record<string, unknown>[] {
  if (spec.mode === "udp-driven") return [];
  const interval = `${String(spec.metricWindowSeconds)}s`;
  return [
    {
      name: "request-success-rate",
      // Flagger nói phần trăm THÀNH CÔNG; session nói tỉ lệ LỖI 0..1
      thresholdRange: { min: (1 - spec.thresholds.errorRate) * 100 },
      interval,
    },
    {
      name: "request-duration",
      thresholdRange: { max: spec.thresholds.latencyP99Ms },
      interval,
    },
  ];
}

function progressionOf(spec: DeliverySpec): Record<string, unknown> {
  if (spec.strategy === "ATTRIBUTE_SPLIT") {
    const match = spec.trafficMatch;
    return {
      // Số vòng phân tích trước khi xin promote: đủ một dwell của session
      iterations: Math.max(
        1,
        Math.ceil(spec.stepIntervalSeconds / spec.analysisIntervalSeconds),
      ),
      match:
        match === undefined
          ? []
          : [
              {
                headers: {
                  [match.header.toLowerCase()]: { exact: match.value },
                },
              },
            ],
    };
  }
  const weights = canaryWeights(spec.stepPercent);
  return {
    stepWeight: spec.stepPercent,
    maxWeight: weights[weights.length - 1] ?? spec.stepPercent,
  };
}

export function flaggerCanary(
  spec: DeliverySpec,
  options: { servicePort: number; gate: GateTarget },
): Manifest {
  const base = options.gate.baseUrl.replace(/\/$/, "");
  return {
    apiVersion: "flagger.app/v1beta1",
    kind: "Canary",
    metadata: {
      name: spec.workloadName,
      namespace: spec.namespace,
      annotations: {
        [DELIVERY_ANNOTATIONS.session]: spec.sessionId,
        [DELIVERY_ANNOTATIONS.mode]: spec.mode,
        [DELIVERY_ANNOTATIONS.strategy]: spec.strategy,
      },
    },
    spec: {
      targetRef: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: spec.workloadName,
      },
      service: { port: options.servicePort },
      skipAnalysis: false,
      analysis: {
        interval: `${String(spec.analysisIntervalSeconds)}s`,
        threshold: spec.thresholds.maxConsecutiveBreaches,
        ...progressionOf(spec),
        metrics: metricsOf(spec),
        webhooks: gatesOf(spec).map((gate) => ({
          name: `udp-${gate}`,
          type: gate,
          url: `${base}${flaggerGatePath(spec.sessionId, gate)}`,
          timeout: "10s",
          metadata: { token: options.gate.token },
        })),
      },
    },
  };
}
