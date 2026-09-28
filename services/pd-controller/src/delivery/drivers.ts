import type { KubernetesClient, ObjectRef } from "@udp/adapter-core";
import { ClusterCallFailedError } from "@udp/cluster-access";
import type { TrafficMatch } from "@udp/shared-types";
import {
  isPauseStep,
  nextWeightAfter,
  observeArgo,
  observeFlagger,
  weightAt,
  type ArgoRollout,
  type FlaggerCanary,
  type Observation,
} from "./observe.js";

/**
 * Hai công cụ giao hàng qua đúng quyền của `udp-traffic` (§12.2, D-P39) [Plan #51 QĐ-8]: ĐỌC `Rollout`/`Canary`,
 * GHI `rollouts/status` (promote, promote-full, abort — đúng các patch của `kubectl argo rollouts`) và route header
 * trong `VirtualService`. Không phương thức nào ở đây chạm `spec` của `Rollout` hay `Deployment` — API server cũng
 * không cho (I25).
 *
 * Flagger không có API ghi nào: Service 3 điều khiển nó qua webhook gate (`gate.ts`), nên driver của nó chỉ đọc.
 */

type Json = Record<string, unknown>;

export interface SessionTarget {
  namespace: string;
  workloadName: string;
  createdAt: Date;
}

export type PromoteResult =
  | { kind: "applied"; to: number }
  /** Rollout không đứng ở bậc session đang chờ (vòng trước đã promote, ai đó bấm tay) — không patch */
  | { kind: "stale" };

export interface ArgoDriver {
  readonly tool: "argo-rollouts";
  observe(): Promise<Observation | null>;
  /**
   * Promote ĐÚNG MỘT bậc: chỉ khi Rollout đang dừng ở bậc `pause` mà trọng số của nó bằng `sessionWeight`
   * (observed = expected, §7.3), và patch mang `resourceVersion` của lần đọc đó.
   */
  promote(sessionWeight: number): Promise<PromoteResult>;
  promoteFull(): Promise<void>;
  /** Bỏ pause TRƯỚC rồi mới abort — abort trên Rollout đang ở `pause: {}` từng lặp vô hạn (argo-rollouts #3756) */
  abort(): Promise<void>;
  /** ATTRIBUTE_SPLIT udp-driven: route khớp header tới service canary, đứng TRƯỚC route của Argo */
  setHeaderRoute(match: TrafficMatch): Promise<void>;
  clearHeaderRoute(): Promise<void>;
}

export interface FlaggerDriver {
  readonly tool: "flagger";
  observe(): Promise<Observation | null>;
}

export type DeliveryDriver = ArgoDriver | FlaggerDriver;

/** Tên route UDP chèn vào `VirtualService` — Argo chỉ sửa trọng số của route có tên trong `trafficRouting` */
export const HEADER_ROUTE = "udp-attribute-split";

const ref = (
  apiVersion: string,
  kind: string,
  target: SessionTarget,
  name = target.workloadName,
): ObjectRef => ({ apiVersion, kind, namespace: target.namespace, name });

const conflict = (err: unknown): boolean =>
  err instanceof ClusterCallFailedError && err.status === 409;

interface VirtualService {
  metadata?: { resourceVersion?: string };
  spec?: { http?: Json[] };
}

export function createArgoDriver(
  client: KubernetesClient,
  target: SessionTarget,
): ArgoDriver {
  const rolloutRef = ref("argoproj.io/v1alpha1", "Rollout", target);
  const statusRef: ObjectRef = { ...rolloutRef, subresource: "status" };
  const read = () => client.read<ArgoRollout>("get", rolloutRef);
  const patchStatus = (status: Json, resourceVersion?: string) =>
    client.write("patch", statusRef, {
      ...(resourceVersion === undefined
        ? {}
        : { metadata: { resourceVersion } }),
      status,
    });

  /** VirtualService và service canary mà strategy của Rollout trỏ tới */
  async function routing(): Promise<{ vs: ObjectRef; canaryHost: string }> {
    const canary = (await read())?.spec?.strategy?.canary;
    const istio = canary?.trafficRouting?.istio;
    const name =
      istio?.virtualService?.name ?? istio?.virtualServices?.[0]?.name;
    if (name === undefined || canary?.canaryService === undefined) {
      throw new Error(
        "Rollout không trỏ VirtualService/canaryService của Istio — không định tuyến theo header được",
      );
    }
    return {
      vs: ref("networking.istio.io/v1beta1", "VirtualService", target, name),
      canaryHost: canary.canaryService,
    };
  }

  async function rewriteRoutes(
    edit: (http: Json[], canaryHost: string) => Json[] | null,
  ): Promise<void> {
    const { vs, canaryHost } = await routing();
    const current = await client.read<VirtualService>("get", vs);
    if (current === null)
      throw new Error(`không có VirtualService ${String(vs.name)}`);
    const http = edit(current.spec?.http ?? [], canaryHost);
    if (http === null) return;
    // Merge patch THAY cả mảng `http` — điều kiện resourceVersion để không đè sửa đổi của Argo giữa chừng
    await client.write("patch", vs, {
      metadata: { resourceVersion: current.metadata?.resourceVersion },
      spec: { http },
    });
  }

  return {
    tool: "argo-rollouts",
    async observe() {
      const rollout = await read();
      return rollout === null ? null : observeArgo(rollout);
    },
    async promote(sessionWeight) {
      const rollout = await read();
      if (rollout === null) return { kind: "stale" };
      const seen = observeArgo(rollout);
      const steps = rollout.spec?.strategy?.canary?.steps ?? [];
      const index = seen.stepIndex;
      if (
        !seen.pausedAtStep ||
        index === undefined ||
        !isPauseStep(steps[index]) ||
        weightAt(steps, index) !== sessionWeight
      ) {
        return { kind: "stale" };
      }
      try {
        await patchStatus({ pauseConditions: null }, seen.resourceVersion);
      } catch (err: unknown) {
        if (conflict(err)) return { kind: "stale" };
        throw err;
      }
      return { kind: "applied", to: nextWeightAfter(steps, index) };
    },
    async promoteFull() {
      await patchStatus({ promoteFull: true, pauseConditions: null });
    },
    async abort() {
      const rollout = await read();
      if (rollout !== null && observeArgo(rollout).pausedAtStep) {
        await patchStatus({ pauseConditions: null });
      }
      await patchStatus({ abort: true });
    },
    async setHeaderRoute(match) {
      await rewriteRoutes((http, canaryHost) => {
        const route = {
          name: HEADER_ROUTE,
          match: [
            {
              headers: { [match.header.toLowerCase()]: { exact: match.value } },
            },
          ],
          route: [{ destination: { host: canaryHost }, weight: 100 }],
        };
        const existing = http.find((r) => r["name"] === HEADER_ROUTE);
        if (JSON.stringify(existing) === JSON.stringify(route)) return null;
        return [route, ...http.filter((r) => r["name"] !== HEADER_ROUTE)];
      });
    },
    async clearHeaderRoute() {
      await rewriteRoutes((http) =>
        http.some((r) => r["name"] === HEADER_ROUTE)
          ? http.filter((r) => r["name"] !== HEADER_ROUTE)
          : null,
      );
    },
  };
}

export function createFlaggerDriver(
  client: KubernetesClient,
  target: SessionTarget,
): FlaggerDriver {
  const canaryRef = ref("flagger.app/v1beta1", "Canary", target);
  return {
    tool: "flagger",
    async observe() {
      const canary = await client.read<FlaggerCanary>("get", canaryRef);
      return canary === null ? null : observeFlagger(canary, target.createdAt);
    },
  };
}
