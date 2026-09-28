import type { TrafficRouter } from "../../adapter-base/traffic-router.js";
import {
  isDeliveryTool,
  type ControlModeWire,
  type ServiceStrategy,
} from "./delivery.types.js";

/**
 * Ô nào của ma trận §7.2 chạy được với tool của environment (Plan #51 QĐ-5). `undefined` = được; chuỗi = lý do
 * 422 — đúng câu người dùng cần đọc để đổi lựa chọn, không phải "không hỗ trợ".
 */
export function supportIssue(
  toolId: string,
  mode: ControlModeWire,
  strategy: ServiceStrategy,
  router: TrafficRouter,
): string | undefined {
  if (!isDeliveryTool(toolId)) {
    return `${toolId} chưa có executor SERVICE_LEVEL — §7.2 vẽ Argo Rollouts và Flagger`;
  }
  if (toolId === "flagger" && strategy === "BLUE_GREEN") {
    return "BLUE_GREEN ở SERVICE_LEVEL là Rollout blueGreen của Argo Rollouts (§7.2) — environment này dùng Flagger";
  }
  if (toolId === "argo-rollouts" && strategy === "ATTRIBUTE_SPLIT") {
    if (mode === "tool-driven") {
      return "ATTRIBUTE_SPLIT tool-driven là A/B của Flagger (§7.2) — với Argo Rollouts chọn udp-driven";
    }
    if (router !== "istio") {
      return `ATTRIBUTE_SPLIT udp-driven định tuyến bằng VirtualService của Istio (§7.2) — router của environment là ${router}`;
    }
  }
  return undefined;
}
