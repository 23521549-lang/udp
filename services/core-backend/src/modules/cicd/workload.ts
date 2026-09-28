import type { ObjectRef } from "@udp/adapter-core";
import { REGISTRY_PULL_SECRET } from "../cluster/bootstrap.js";

/**
 * Workload mà webhook deploy chạm (§8.3, Plan #36 QĐ-4) — hàm THUẦN, không gọi cluster.
 *
 * Hai loại, đúng hai tài nguyên `udp-workload` được ghi (§12.2): `Deployment` và `Rollout` của Argo
 * Rollouts (khi progressive delivery là Argo Rollouts thì workload là `Rollout`). Cả hai có cùng
 * `spec.template`, khác nhau ở cách nói "xong" và "hỏng".
 *
 * Patch là JSON merge patch (`ClusterAccess` gửi `application/merge-patch+json`), mà merge patch
 * THAY CẢ MẢNG: gửi `containers: [{name, image}]` là xoá port, env, probe, resource của mọi
 * container. Nên patch mang lại NGUYÊN mảng đã đọc, chỉ đổi `image` của đúng một container, kèm
 * `metadata.resourceVersion` làm điều kiện: ai sửa workload giữa lúc đọc và lúc ghi thì API server
 * trả 409 chứ không để bản cũ đè lên.
 */

export type Verdict = "rolling" | "done" | "stuck";

type Container = Record<string, unknown> & { name: string; image?: string };

export interface WorkloadState {
  metadata?: { generation?: number; resourceVersion?: string };
  spec?: {
    replicas?: number;
    progressDeadlineSeconds?: number;
    template?: {
      spec?: {
        containers?: Container[];
        imagePullSecrets?: { name: string }[];
      };
    };
  };
  status?: {
    /** Deployment: số; Rollout: chuỗi số */
    observedGeneration?: number | string;
    replicas?: number;
    updatedReplicas?: number;
    availableReplicas?: number;
    conditions?: { type: string; status: string; reason?: string }[];
    /** Chỉ Rollout: Healthy | Progressing | Paused | Degraded */
    phase?: string;
  };
}

export interface WorkloadKind {
  apiVersion: string;
  kind: "Deployment" | "Rollout";
  verdict(state: WorkloadState): Verdict;
}

const observed = (s: WorkloadState): boolean =>
  Number(s.status?.observedGeneration ?? 0) >= (s.metadata?.generation ?? 0);

/** Cùng luật với `kubectl rollout status` */
function deploymentVerdict(s: WorkloadState): Verdict {
  const progressing = s.status?.conditions?.find(
    (c) => c.type === "Progressing",
  );
  if (
    progressing?.status === "False" &&
    progressing.reason === "ProgressDeadlineExceeded"
  ) {
    return "stuck";
  }
  const want = s.spec?.replicas ?? 1;
  return observed(s) &&
    (s.status?.updatedReplicas ?? 0) >= want &&
    (s.status?.availableReplicas ?? 0) >= want &&
    (s.status?.replicas ?? 0) <= want
    ? "done"
    : "rolling";
}

/** Argo Rollouts tự kết luận vào `status.phase` — `Degraded` là quá hạn hay bị huỷ */
function rolloutVerdict(s: WorkloadState): Verdict {
  if (s.status?.phase === "Degraded") return "stuck";
  return observed(s) && s.status?.phase === "Healthy" ? "done" : "rolling";
}

/** Thứ tự tra: Deployment trước (trường hợp chung), Rollout khi không có Deployment cùng tên */
export const WORKLOAD_KINDS: readonly WorkloadKind[] = [
  { apiVersion: "apps/v1", kind: "Deployment", verdict: deploymentVerdict },
  {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Rollout",
    verdict: rolloutVerdict,
  },
];

export const workloadRef = (
  kind: WorkloadKind,
  namespace: string,
  name: string,
): ObjectRef => ({
  apiVersion: kind.apiVersion,
  kind: kind.kind,
  namespace,
  name,
});

export const imageOf = (
  state: WorkloadState,
  container: string,
): string | undefined =>
  state.spec?.template?.spec?.containers?.find((c) => c.name === container)
    ?.image;

/** Nhãn pod mang phiên bản đang chạy — manifest Golden Path đọc nó vào `service.version` (§6.6) */
export const VERSION_LABEL = "app.kubernetes.io/version";

const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;

/**
 * [Plan #48 QĐ-3] Phiên bản của một image thành giá trị nhãn Kubernetes: tag (`…/web:0123456` ⇒
 * `0123456`), digest ⇒ 12 chữ số hex đầu, không tag ⇒ `latest`. `null` khi không thành nhãn hợp lệ
 * (dài quá 63 ký tự, ký tự lạ) — patch khi đó không đụng nhãn, thay vì bị API server từ chối cả lần áp.
 */
export function versionLabelOf(image: string): string | null {
  const at = image.indexOf("@");
  const name = image.slice(image.lastIndexOf("/") + 1);
  const colon = name.lastIndexOf(":");
  const version =
    at >= 0
      ? image
          .slice(at + 1)
          .replace(/^sha256:/, "")
          .slice(0, 12)
      : colon >= 0
        ? name.slice(colon + 1)
        : "latest";
  return version.length <= 63 && LABEL_VALUE.test(version) ? version : null;
}

/**
 * Patch đổi image của MỘT container và thêm `udp-registry-pull` vào `imagePullSecrets` nếu chưa có
 * (Plan #35) — không gì khác: không `spec.strategy`, không trạng thái rollout (I25). `null` khi
 * workload không có container mang tên đó: thêm một container mới vào pod là việc của Golden
 * Path, không phải của webhook.
 *
 * [Plan #48 QĐ-3] Kèm nhãn pod `app.kubernetes.io/version` = phiên bản của image: `service.version`
 * trên metric (qua Downward API trong manifest) đi CÙNG image, cả lúc áp lẫn lúc rollback — không có
 * nó thì canary SERVICE_LEVEL so hai phiên bản mang cùng một nhãn. Merge patch GỘP `labels`, nhãn
 * khác của pod giữ nguyên.
 */
export function imagePatch(
  state: WorkloadState,
  container: string,
  image: string,
): Record<string, unknown> | null {
  const containers = state.spec?.template?.spec?.containers ?? [];
  if (!containers.some((c) => c.name === container)) return null;
  const pullSecrets = state.spec?.template?.spec?.imagePullSecrets ?? [];
  const version = versionLabelOf(image);
  return {
    metadata: { resourceVersion: state.metadata?.resourceVersion },
    spec: {
      template: {
        ...(version === null
          ? {}
          : { metadata: { labels: { [VERSION_LABEL]: version } } }),
        spec: {
          containers: containers.map((c) =>
            c.name === container ? { ...c, image } : c,
          ),
          imagePullSecrets: pullSecrets.some(
            (s) => s.name === REGISTRY_PULL_SECRET,
          )
            ? pullSecrets
            : [...pullSecrets, { name: REGISTRY_PULL_SECRET }],
        },
      },
    },
  };
}
