import { queryTemplates } from "@udp/metrics-provider";
import {
  canaryWeights,
  DELIVERY_ANNOTATIONS,
  type DeliverySpec,
  type Manifest,
} from "./delivery.types.js";

/**
 * `Rollout` của Argo Rollouts cho một session SERVICE_LEVEL (§7.3) [Plan #51 QĐ-6] — workload đã LÀ `Rollout`
 * (Luồng 3 coi nó là workload, `cicd/workload.ts`), nên S1 ghi `spec.strategy` bằng MỘT merge patch cùng lúc với
 * image mới.
 *
 * Merge patch (RFC 7386) gộp object và THAY mảng: `steps` thay nguyên, còn khoá phải XOÁ thì phải gửi `null` —
 * `analysis: null` là thứ bảo đảm I4 khi strategy trước (một session tool-driven) còn khối `analysis`.
 */

type Strategy = Record<string, unknown>;

/** Strategy gốc của workload — `canary` của nó mang `trafficRouting`, `canaryService`, `stableService` */
export interface BaseStrategy {
  canary?: Strategy;
  blueGreen?: Strategy;
}

export const PREVIEW_SUFFIX = "-preview";

export const analysisTemplateName = (workloadName: string): string =>
  `udp-${workloadName}`;

const isObject = (v: unknown): v is Strategy =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `canary` của strategy gốc bỏ hai khoá mà session tự quyết */
function baseCanaryOf(base: BaseStrategy): Strategy | undefined {
  if (!isObject(base.canary)) return undefined;
  const rest: Strategy = { ...base.canary };
  delete rest["steps"];
  delete rest["analysis"];
  return rest;
}

function stepsOf(spec: DeliverySpec): Strategy[] {
  if (spec.strategy === "ATTRIBUTE_SPLIT") {
    // Trọng số 0: chỉ request khớp header (route của S3 trong VirtualService) tới phiên bản mới
    return [{ setCanaryScale: { replicas: 1 } }, { pause: {} }];
  }
  const pause =
    spec.mode === "udp-driven"
      ? // Dừng vô hạn: CHỈ Service 3 promote mới đi tiếp (ADR-01)
        {}
      : { duration: `${String(spec.stepIntervalSeconds)}s` };
  return canaryWeights(spec.stepPercent).flatMap((w) => [
    { setWeight: w },
    { pause },
  ]);
}

/**
 * `spec.strategy` của session, hoặc lý do không dựng được. Luôn dựng từ strategy GỐC (trước session UDP đầu
 * tiên), không từ strategy của session trước — một session BLUE_GREEN xoá `canary`, session CANARY kế tiếp vẫn
 * lấy lại được `trafficRouting`.
 */
export function argoStrategy(
  spec: DeliverySpec,
  base: BaseStrategy,
): { strategy: Strategy } | { issue: string } {
  if (spec.strategy === "BLUE_GREEN") {
    return {
      strategy: {
        canary: null,
        blueGreen: {
          activeService: spec.workloadName,
          previewService: `${spec.workloadName}${PREVIEW_SUFFIX}`,
          // udp-driven: chuyển 100% CHỈ khi người dùng PROMOTE (§7.2 "không tự động")
          autoPromotionEnabled: spec.mode === "tool-driven",
          autoPromotionSeconds:
            spec.mode === "tool-driven" ? spec.stepIntervalSeconds : null,
        },
      },
    };
  }
  const canary = baseCanaryOf(base);
  if (canary === undefined || !isObject(canary["trafficRouting"])) {
    return {
      issue:
        "Rollout thiếu strategy.canary.trafficRouting — không có nó, setWeight chỉ xấp xỉ bằng SỐ POD chứ không phải trọng số traffic (§7.3)",
    };
  }
  return {
    strategy: {
      blueGreen: null,
      canary: {
        ...canary,
        steps: stepsOf(spec),
        // I4: udp-driven KHÔNG có analysis — null để xoá khối của strategy trước
        analysis:
          spec.mode === "tool-driven" && spec.strategy === "CANARY"
            ? {
                templates: [
                  { templateName: analysisTemplateName(spec.workloadName) },
                ],
              }
            : null,
      },
    },
  };
}

/**
 * Merge patch lên `Rollout`: chú thích của session + strategy. `previousStrategy` chỉ ghi khi CHƯA có — nó là
 * bản gốc, ghi đè bằng strategy của một session là mất bản gốc mãi mãi.
 */
export function argoRolloutPatch(
  spec: DeliverySpec,
  strategy: Strategy,
  base: BaseStrategy,
  hasPreviousStrategy: boolean,
): Record<string, unknown> {
  return {
    metadata: {
      annotations: {
        [DELIVERY_ANNOTATIONS.session]: spec.sessionId,
        [DELIVERY_ANNOTATIONS.mode]: spec.mode,
        [DELIVERY_ANNOTATIONS.strategy]: spec.strategy,
        ...(hasPreviousStrategy
          ? {}
          : { [DELIVERY_ANNOTATIONS.previousStrategy]: JSON.stringify(base) }),
      },
    },
    spec: { strategy },
  };
}

/**
 * `AnalysisTemplate` của tool-driven CANARY: Argo tự đo tỉ lệ lỗi của PHIÊN BẢN MỚI (`service_version`) bằng
 * CÙNG PromQL mà Service 3 dùng (`queryTemplates`), cùng ngưỡng của session. `failureLimit` = số lần vượt được
 * tha trước khi rollback — `maxConsecutiveBreaches − 1` (Argo đếm tổng, không đếm liên tiếp: gần nhất có thể).
 */
export function argoAnalysisTemplate(
  spec: DeliverySpec,
  options: { prometheusUrl: string; versionNew: string; metricBase?: string },
): Manifest {
  const query = queryTemplates(options.metricBase).errorRate(
    {
      namespace: spec.namespace,
      workloadName: spec.workloadName,
      version: options.versionNew,
    },
    spec.metricWindowSeconds,
  );
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "AnalysisTemplate",
    metadata: {
      name: analysisTemplateName(spec.workloadName),
      namespace: spec.namespace,
      annotations: {
        [DELIVERY_ANNOTATIONS.session]: spec.sessionId,
        [DELIVERY_ANNOTATIONS.mode]: spec.mode,
      },
    },
    spec: {
      metrics: [
        {
          name: "error-rate",
          interval: `${String(spec.analysisIntervalSeconds)}s`,
          failureLimit: spec.thresholds.maxConsecutiveBreaches - 1,
          successCondition: `result[0] <= ${String(spec.thresholds.errorRate)}`,
          provider: {
            prometheus: { address: options.prometheusUrl, query },
          },
        },
      ],
    },
  };
}

export interface ServicePort {
  name?: string;
  port: number;
  targetPort?: number | string;
  protocol?: string;
}

/**
 * Service xem trước của BLUE_GREEN: cùng cổng và selector với service đang phục vụ — Argo gắn hash pod vào cả
 * hai. Chỉ chép bốn trường của cổng: `nodePort`/`clusterIP` của service gốc là của RIÊNG nó, chép sang là xung đột.
 */
export function previewService(
  spec: DeliverySpec,
  active: {
    spec?: { ports?: ServicePort[]; selector?: Record<string, string> };
  },
): Manifest {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: `${spec.workloadName}${PREVIEW_SUFFIX}`,
      namespace: spec.namespace,
      annotations: { [DELIVERY_ANNOTATIONS.session]: spec.sessionId },
    },
    spec: {
      selector: active.spec?.selector ?? {},
      ports: (active.spec?.ports ?? []).map((p) => ({
        ...(p.name === undefined ? {} : { name: p.name }),
        port: p.port,
        ...(p.targetPort === undefined ? {} : { targetPort: p.targetPort }),
        ...(p.protocol === undefined ? {} : { protocol: p.protocol }),
      })),
    },
  };
}
