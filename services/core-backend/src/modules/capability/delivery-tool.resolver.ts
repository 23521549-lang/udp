import { UnprocessableError } from "@udp/http";
import { prisma } from "../../core/db.js";
import {
  TRAFFIC_ROUTERS,
  type TrafficRouter,
} from "../adapter-base/traffic-router.js";
import {
  bindingsOfProject,
  type StoredBinding,
} from "./capability-binding.repository.js";

/**
 * Tool giao hàng của MỘT environment cho rollout SERVICE_LEVEL (§7.3 "traffic.control provider?") [Plan #51 QĐ-5]:
 * adapter đang cung cấp `traffic.control` (Argo Rollouts, Flagger, Spinnaker), và bộ định tuyến đứng sau nó —
 * `attributes.provider` của binding `mesh.traffic-split`/`ingress.traffic-split` (mesh thắng ingress, cùng luật
 * với adapter Flagger).
 *
 * Chọn binding theo CÙNG luật với `metricsSourceFor`: bản riêng của environment thắng bản cluster-scoped.
 * `traffic.control` là capability ĐỘC QUYỀN (§5.3), nên không có ca "nhiều provider".
 */

export interface DeliveryTarget {
  toolId: string;
  router: TrafficRouter;
}

function pick(
  bindings: readonly StoredBinding[],
  capabilityId: string,
  environmentId: string,
): StoredBinding | undefined {
  const rank = (environment: string | null | undefined): number =>
    environment == null ? 1 : environment === environmentId ? 2 : 0;
  return bindings
    .filter((b) => b.capabilityId === capabilityId && rank(b.environmentId) > 0)
    .sort((a, b) => rank(b.environmentId) - rank(a.environmentId))[0];
}

const isRouter = (value: unknown): value is TrafficRouter =>
  (TRAFFIC_ROUTERS as readonly unknown[]).includes(value);

export async function deliveryTargetFor(args: {
  projectId: string;
  environmentId: string;
}): Promise<DeliveryTarget> {
  const bindings = await bindingsOfProject(prisma, args.projectId);
  const control = pick(bindings, "traffic.control", args.environmentId);
  if (control === undefined) {
    throw new UnprocessableError(
      "Environment chưa có Progressive Delivery (Argo Rollouts hoặc Flagger) — SERVICE_LEVEL cần một tool giữ đường traffic (§7.3)",
      undefined,
      "MISSING_CAPABILITY",
    );
  }
  const split =
    pick(bindings, "mesh.traffic-split", args.environmentId) ??
    pick(bindings, "ingress.traffic-split", args.environmentId);
  const router = split?.attributes?.["provider"];
  if (!isRouter(router)) {
    throw new UnprocessableError(
      "Không xác định được bộ định tuyến traffic (service mesh hoặc ingress) của environment",
    );
  }
  // `providedBy` là `<domain>:<toolId>` (`progressive_delivery:argo-rollouts`)
  return {
    toolId: control.providedBy.slice(control.providedBy.indexOf(":") + 1),
    router,
  };
}
