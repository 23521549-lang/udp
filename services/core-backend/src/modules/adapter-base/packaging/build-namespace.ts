import { RAW_CHART } from "../database.js";
import type { HelmCompanion } from "../helm.js";
import { BUILD_NAMESPACE, BUILDER_SERVICE_ACCOUNT } from "./build-script.js";

/**
 * [Plan #61 QĐ-12] Nơi build của ba CI chạy TRONG cluster (Jenkins, Tekton, Drone): namespace `udp-build`, tách khỏi
 * `udp-system` — pod build chạy mã của khách (và BuildKit cần seccomp `Unconfined`), không được nằm cạnh bí mật
 * của nền tảng. Trước Plan #61 agent của Jenkins chạy ngay trong `udp-system`, pod của Drone ở `default`.
 *
 * Một release `raw` đi kèm release chính của CI (Flux áp, nên `udp-tooling` không cần quyền nào ở `udp-build`):
 *  - Namespace, chặn ingress mặc định (pod build không phục vụ ai), egress mở (git, registry, kho gói).
 *  - LimitRange: pod không khai thì nhận mức đủ cho BuildKit và builder Buildpacks.
 *  - ServiceAccount `udp-builder` mà pod build chạy bằng, và Role chỉ cho nó xin token của CHÍNH nó (TokenRequest) —
 *    JWT mà danh tính build trong cloud tin (QĐ-6).
 * Quyền tạo pod ở namespace này đến từ RBAC của chính chart CI (Jenkins `agent.namespace`, Drone
 * `rbac.buildNamespaces`; Tekton có ClusterRole).
 */

export const BUILD_NAMESPACE_RELEASE = "udp-build-namespace";

/** Mức mặc định cho container build không khai tài nguyên */
const LIMITS = {
  defaultRequest: { cpu: "250m", memory: "512Mi" },
  default: { cpu: "2", memory: "4Gi" },
};

export function buildNamespaceManifests(): Record<string, unknown>[] {
  const labels = {
    "app.kubernetes.io/managed-by": "udp",
    "udp.dev/purpose": "build",
  };
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: BUILD_NAMESPACE, labels },
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: BUILDER_SERVICE_ACCOUNT,
        namespace: BUILD_NAMESPACE,
        labels,
      },
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: {
        name: `${BUILDER_SERVICE_ACCOUNT}-token`,
        namespace: BUILD_NAMESPACE,
        labels,
      },
      rules: [
        {
          apiGroups: [""],
          resources: ["serviceaccounts/token"],
          resourceNames: [BUILDER_SERVICE_ACCOUNT],
          verbs: ["create"],
        },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: {
        name: `${BUILDER_SERVICE_ACCOUNT}-token`,
        namespace: BUILD_NAMESPACE,
        labels,
      },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: `${BUILDER_SERVICE_ACCOUNT}-token`,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name: BUILDER_SERVICE_ACCOUNT,
          namespace: BUILD_NAMESPACE,
        },
      ],
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: {
        name: "udp-build-defaults",
        namespace: BUILD_NAMESPACE,
        labels,
      },
      spec: { limits: [{ type: "Container", ...LIMITS }] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: "udp-build-deny-ingress",
        namespace: BUILD_NAMESPACE,
        labels,
      },
      spec: { podSelector: {}, policyTypes: ["Ingress"] },
    },
  ];
}

/**
 * Release đi kèm: áp TRƯỚC release chính của CI (namespace phải có trước khi CI tạo Role trong nó). `shared`: CÙNG tên
 * ở cả ba CI trong cluster — đổi Jenkins sang Tekton không được gỡ namespace mà CI mới đang cần.
 */
export const buildNamespaceCompanion: HelmCompanion = {
  releaseName: BUILD_NAMESPACE_RELEASE,
  chart: RAW_CHART,
  before: true,
  shared: true,
  values: () => ({ resources: buildNamespaceManifests() }),
};
