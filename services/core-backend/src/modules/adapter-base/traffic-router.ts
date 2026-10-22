import type { CapabilityBinding, CapabilityId } from "@udp/shared-types";

/**
 * Hợp đồng binding của đường traffic (Plan #33 QĐ-1): `mesh.traffic-split` và
 * `ingress.traffic-split` nói BỘ ĐỊNH TUYẾN nào đứng sau (`attributes.provider`), để Flagger đặt
 * `meshProvider` và Argo Rollouts chọn traffic router đúng — không đoán từ tên tool.
 */

export const TRAFFIC_ROUTERS = [
  "istio",
  "linkerd",
  "consul",
  "kuma",
  "nginx",
  "traefik",
] as const;
export type TrafficRouter = (typeof TRAFFIC_ROUTERS)[number];

type SplitCapability = Extract<
  CapabilityId,
  "mesh.traffic-split" | "ingress.traffic-split"
>;

export function trafficSplitBinding(
  id: SplitCapability,
  providedBy: string,
  router: TrafficRouter,
  endpoint?: string,
): CapabilityBinding {
  return {
    id,
    version: "1.0.0",
    providedBy,
    ...(endpoint === undefined ? {} : { endpoint }),
    attributes: { provider: router },
  };
}

const isRouter = (value: unknown): value is TrafficRouter =>
  typeof value === "string" &&
  (TRAFFIC_ROUTERS as readonly string[]).includes(value);

/**
 * Bộ định tuyến mà consumer (Flagger, Argo Rollouts) phải điều khiển — từ binding mesh hay
 * ingress đã resolve; preference đã chọn MỘT trước khi tới đây (§5.3). NÉM khi không có hay
 * không nói provider: controller cấu hình nhầm router thì mọi bậc canary đi vào hư không.
 */
export function trafficRouterOf(
  resolved: Readonly<Partial<Record<CapabilityId, CapabilityBinding>>>,
): TrafficRouter {
  const binding =
    resolved["mesh.traffic-split"] ?? resolved["ingress.traffic-split"];
  const provider = binding?.attributes?.provider;
  if (!isRouter(provider)) {
    throw new Error("thiếu binding mesh/ingress.traffic-split nói provider");
  }
  return provider;
}
