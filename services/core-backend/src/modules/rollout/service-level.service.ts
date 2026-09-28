import type { KubernetesClient, ObjectRef } from "@udp/adapter-core";
import { ClusterCallFailedError } from "@udp/cluster-access";
import { env, ROLLOUT_TIMING } from "@udp/config";
import {
  AppError,
  ConflictError,
  flaggerGateToken,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from "@udp/http";
import type { Request } from "express";
import type { AppDeps } from "../../core/app-deps.js";
import { PhaseFailedError } from "../../jobs/job-kit.js";
import { deliveryTargetFor } from "../capability/delivery-tool.resolver.js";
import { metricsSourceFor } from "../capability/metrics-source.resolver.js";
import {
  imageOf,
  imagePatch,
  imageWithTag,
  versionLabelOf,
  type WorkloadState,
} from "../cicd/workload.js";
import {
  compensateCreate,
  minWindowOf,
  probeWorkload,
} from "./create-support.js";
import {
  argoAnalysisTemplate,
  argoRolloutPatch,
  argoStrategy,
  previewService,
  type BaseStrategy,
  type ServicePort,
} from "./delivery/argo.js";
import {
  DELIVERY_ANNOTATIONS,
  type DeliverySpec,
  type DeliveryTool,
  type Manifest,
} from "./delivery/delivery.types.js";
import { flaggerCanary } from "./delivery/flagger.js";
import { supportIssue } from "./delivery/matrix.js";
import { mergePatches } from "./delivery/merge.js";
import * as repository from "./rollout.repository.js";
import type { CreateServiceRolloutInput } from "./rollout.types.js";

/**
 * Tạo rollout SERVICE_LEVEL (§8.5, §7.3) [Plan #51 QĐ-7] — Service 1 là bên ghi SPEC của đối tượng giao hàng
 * (`udp-workload`, §12.2); Service 3 sau đó chỉ promote/abort qua `status` hoặc trả lời gate (ADR-01).
 *
 * Thứ tự từ rẻ tới đắt và từ "chưa ghi gì" tới "đã ghi", như nhánh FLAG_LEVEL: kiểm cấu hình (database) → probe
 * pha 1 (metrics) → đọc cluster và dựng đối tượng giao hàng (chưa ghi) → INSERT (lease khai sinh) → ghi cluster →
 * bù trừ nếu ghi hỏng. Mọi lỗi trước INSERT không để lại gì.
 */

type Json = Record<string, unknown>;

interface RolloutState extends WorkloadState {
  spec?: WorkloadState["spec"] & { strategy?: BaseStrategy };
}

interface ServiceState {
  spec?: { ports?: ServicePort[]; selector?: Record<string, string> };
}

interface CanaryState {
  status?: { phase?: string };
}

/** Pha của `Canary` mà một lượt mới bắt đầu được: đã khởi tạo xong, hoặc lượt trước đã kết thúc */
const FLAGGER_READY: ReadonlySet<string> = new Set([
  "Initialized",
  "Succeeded",
  "Failed",
]);

const ref = (
  apiVersion: string,
  kind: string,
  namespace: string,
  name: string,
): ObjectRef => ({ apiVersion, kind, namespace, name });

const refOf = (m: Manifest): ObjectRef =>
  ref(m.apiVersion, m.kind, m.metadata.namespace, m.metadata.name);

/** Kết quả đọc cluster: phiên bản hai phía và cách ghi — chưa ghi gì */
interface DeliveryPlan {
  versionOld: string;
  versionNew: string;
  apply(sessionId: string): Promise<void>;
}

interface PlanInput {
  client: KubernetesClient;
  spec: Omit<DeliverySpec, "sessionId">;
  imageTag: string;
  prometheusUrl: string | undefined;
  gateBaseUrl: string | null;
}

/** Hai phía của phép so SERVICE_LEVEL (§7.4: `service_version` mới vs cũ) */
function versionsOf(
  running: string | undefined,
  workloadName: string,
  imageTag: string,
): { image: string; versionOld: string; versionNew: string } {
  if (running === undefined) {
    throw new UnprocessableError(
      `Workload không có container "${workloadName}" — container phải trùng tên workload (§8.3)`,
    );
  }
  const versionOld = versionLabelOf(running) ?? running;
  if (versionOld === imageTag) {
    throw new UnprocessableError(
      `Workload đang chạy đúng phiên bản "${imageTag}" — rollout cần một phiên bản mới`,
    );
  }
  return {
    image: imageWithTag(running, imageTag),
    versionOld,
    versionNew: imageTag,
  };
}

async function planArgo(input: PlanInput): Promise<DeliveryPlan> {
  const { client, spec } = input;
  const rolloutRef = ref(
    "argoproj.io/v1alpha1",
    "Rollout",
    spec.namespace,
    spec.workloadName,
  );
  const state = await client.read<RolloutState>("get", rolloutRef);
  if (state === null) {
    throw new UnprocessableError(
      `Không có Rollout "${spec.workloadName}" ở ${spec.namespace} — environment dùng Argo Rollouts nên workload phải là Rollout (§8.3)`,
    );
  }
  if (state.status?.phase !== "Healthy") {
    throw new ConflictError(
      `Rollout đang ${state.status?.phase ?? "chưa sẵn sàng"} — chờ lượt hiện tại xong rồi tạo rollout mới`,
      undefined,
      "ROLLOUT_IN_PROGRESS",
    );
  }
  const { image, versionOld, versionNew } = versionsOf(
    imageOf(state, spec.workloadName),
    spec.workloadName,
    input.imageTag,
  );
  const annotations = state.metadata?.annotations ?? {};
  const saved = annotations[DELIVERY_ANNOTATIONS.previousStrategy];
  const base: BaseStrategy =
    saved === undefined
      ? (state.spec?.strategy ?? {})
      : (JSON.parse(saved) as BaseStrategy);
  const built = argoStrategy({ ...spec, sessionId: "" }, base);
  if ("issue" in built) throw new UnprocessableError(built.issue);

  let active: ServiceState | null = null;
  if (spec.strategy === "BLUE_GREEN") {
    active = await client.read<ServiceState>(
      "get",
      ref("v1", "Service", spec.namespace, spec.workloadName),
    );
    if (active === null) {
      throw new UnprocessableError(
        `BLUE_GREEN cần Service "${spec.workloadName}" làm activeService`,
      );
    }
  }
  const template = spec.mode === "tool-driven" && spec.strategy === "CANARY";
  if (template && input.prometheusUrl === undefined) {
    throw new UnprocessableError(
      "Argo Rollouts tool-driven tự đo bằng Prometheus TRONG cluster — nguồn metrics của environment không phải Prometheus trong cluster",
    );
  }

  return {
    versionOld,
    versionNew,
    async apply(sessionId) {
      const session: DeliverySpec = { ...spec, sessionId };
      if (template && input.prometheusUrl !== undefined) {
        const manifest = argoAnalysisTemplate(session, {
          prometheusUrl: input.prometheusUrl,
          versionNew,
        });
        await client.write("apply", refOf(manifest), manifest);
      }
      if (active !== null) {
        const preview = previewService(session, active);
        await client.write("apply", refOf(preview), preview);
      }
      const image_ = imagePatch(state, spec.workloadName, image);
      if (image_ === null) {
        throw new UnprocessableError(
          `Workload không có container "${spec.workloadName}"`,
        );
      }
      // MỘT merge patch: strategy + image, điều kiện `resourceVersion` của lần đọc
      await client.write(
        "patch",
        rolloutRef,
        mergePatches(
          argoRolloutPatch(session, built.strategy, base, saved !== undefined),
          image_,
        ),
      );
    },
  };
}

async function planFlagger(input: PlanInput): Promise<DeliveryPlan> {
  const { client, spec } = input;
  const baseUrl = input.gateBaseUrl;
  if (baseUrl === null) {
    throw new UnprocessableError(
      "Flagger udp-driven và ROLLBACK bằng tay cần Service 3 nhận webhook gate — PD_CONTROLLER_WEBHOOK_URL chưa cấu hình",
    );
  }
  const deploymentRef = ref(
    "apps/v1",
    "Deployment",
    spec.namespace,
    spec.workloadName,
  );
  const state = await client.read<WorkloadState>("get", deploymentRef);
  if (state === null) {
    throw new UnprocessableError(
      `Không có Deployment "${spec.workloadName}" ở ${spec.namespace} — Flagger giao hàng cho một Deployment`,
    );
  }
  const service = await client.read<ServiceState>(
    "get",
    ref("v1", "Service", spec.namespace, spec.workloadName),
  );
  const port = service?.spec?.ports?.[0]?.port;
  if (port === undefined) {
    throw new UnprocessableError(
      `Flagger cần Service "${spec.workloadName}" có cổng để dựng primary/canary`,
    );
  }
  const canaryRef = ref(
    "flagger.app/v1beta1",
    "Canary",
    spec.namespace,
    spec.workloadName,
  );
  const canary = await client.read<CanaryState>("get", canaryRef);
  const phase = canary?.status?.phase;
  if (canary === null || phase === undefined || !FLAGGER_READY.has(phase)) {
    throw new ConflictError(
      canary === null
        ? `Workload chưa được Flagger quản lý — tạo Canary "${spec.workloadName}" (Golden Path làm việc đó) rồi chờ Flagger khởi tạo bản primary`
        : `Canary đang ${phase ?? "khởi tạo"} — chờ Flagger xong rồi tạo rollout mới`,
      undefined,
      "ROLLOUT_IN_PROGRESS",
    );
  }
  const { image, versionOld, versionNew } = versionsOf(
    imageOf(state, spec.workloadName),
    spec.workloadName,
    input.imageTag,
  );
  return {
    versionOld,
    versionNew,
    async apply(sessionId) {
      const session: DeliverySpec = { ...spec, sessionId };
      const manifest = flaggerCanary(session, {
        servicePort: port,
        gate: {
          baseUrl,
          token: flaggerGateToken(env.INTERNAL_SERVICE_SECRET, sessionId),
        },
      });
      await client.write("apply", canaryRef, manifest);
      const patch = imagePatch(state, spec.workloadName, image);
      if (patch === null) {
        throw new UnprocessableError(
          `Workload không có container "${spec.workloadName}"`,
        );
      }
      // Flagger thấy phiên bản mới của Deployment và bắt đầu phân tích theo Canary vừa áp
      await client.write("patch", deploymentRef, patch);
    },
  };
}

const PLANNERS: Readonly<
  Record<DeliveryTool, (input: PlanInput) => Promise<DeliveryPlan>>
> = {
  "argo-rollouts": planArgo,
  flagger: planFlagger,
};

/** Kiểm những gì không cần cluster — trước mọi lời gọi mạng */
function assertShape(input: CreateServiceRolloutInput): void {
  if (!Number.isInteger(input.stepPercent) || input.stepPercent >= 100) {
    throw new UnprocessableError(
      "Argo Rollouts và Flagger nhận trọng số nguyên — stepPercent phải là số nguyên dưới 100",
    );
  }
  if (
    input.strategy === "ATTRIBUTE_SPLIT" &&
    input.trafficMatch === undefined
  ) {
    throw new UnprocessableError(
      "ATTRIBUTE_SPLIT cần trafficMatch — header nào đưa người dùng tới phiên bản mới",
    );
  }
  if (
    input.strategy !== "ATTRIBUTE_SPLIT" &&
    input.trafficMatch !== undefined
  ) {
    throw new UnprocessableError("trafficMatch chỉ dùng với ATTRIBUTE_SPLIT");
  }
}

/** Prometheus TRONG cluster của environment — thứ duy nhất AnalysisTemplate của Argo đọc được */
async function inClusterPrometheus(
  deps: AppDeps,
  projectId: string,
  environmentId: string,
): Promise<string | undefined> {
  const source = await metricsSourceFor({
    projectId,
    environmentId,
    registry: await deps.domainRegistry(),
  });
  return source?.kind === "prometheus" &&
    source.inCluster &&
    source.basicAuth === undefined
    ? source.baseUrl
    : undefined;
}

/** Lỗi trong lúc nói với cluster: lỗi nghiệp vụ đi nguyên; phần còn lại không bao giờ mang lỗi gốc (I12) */
function clusterFailure(err: unknown): Error {
  if (err instanceof AppError) return err;
  if (err instanceof PhaseFailedError) {
    return new UnprocessableError(
      `SERVICE_LEVEL chạy trên cluster của project — ${err.message} (ADR-06)`,
    );
  }
  if (err instanceof ClusterCallFailedError && err.status === 409) {
    return new ConflictError(
      "Workload vừa bị sửa giữa lúc đọc và lúc ghi — thử lại",
      undefined,
      "OPTIMISTIC_LOCK",
    );
  }
  return new ServiceUnavailableError("Không đọc/ghi được cluster của project");
}

/** Lỗi gốc kèm phần bù trừ nói rollout đã ra sao (đã xoá / đã yêu cầu huỷ / không huỷ được) */
function suffixed(err: Error, suffix: string): AppError {
  const message = `${err.message}${suffix}`;
  if (err instanceof ConflictError) {
    return new ConflictError(message, undefined, err.problemCode);
  }
  if (err instanceof UnprocessableError) {
    return new UnprocessableError(message, undefined, err.problemCode);
  }
  return new ServiceUnavailableError(message);
}

export async function createServiceLevel(
  deps: AppDeps,
  projectId: string,
  input: CreateServiceRolloutInput,
  actorUserId: string,
  request: Request,
): Promise<string> {
  assertShape(input);
  const namespace = await repository.namespaceOf(projectId, input.envId);
  if (namespace === undefined) {
    throw new NotFoundError("Không tìm thấy environment trong project này");
  }
  const delivery = await deliveryTargetFor({
    projectId,
    environmentId: input.envId,
  });
  const issue = supportIssue(
    delivery.toolId,
    input.controlMode,
    input.strategy,
    delivery.router,
  );
  if (issue !== undefined) throw new UnprocessableError(issue);
  const tool = delivery.toolId as DeliveryTool;

  const probed = await probeWorkload(
    deps,
    { projectId, environmentId: input.envId, namespace },
    input.workloadName,
    input.metricQueries,
  );
  if (!probed.hasSeries) {
    throw new UnprocessableError(
      `Workload "${input.workloadName}" ở namespace "${namespace}" chưa xuất metric HTTP — cài udpMetricsMiddleware() (§6.6, §11.1)`,
      { namespace, workloadName: input.workloadName },
      "METRICS_NOT_AVAILABLE",
    );
  }
  const minWindow = minWindowOf(probed.scrapeIntervalSec);
  if (
    input.metricWindowSeconds !== undefined &&
    input.metricWindowSeconds < minWindow
  ) {
    throw new UnprocessableError(
      `metricWindowSeconds phải ≥ ${String(minWindow)} (4 × scrape interval ${String(probed.scrapeIntervalSec)}s)`,
    );
  }
  const metricWindowSeconds =
    input.metricWindowSeconds ??
    Math.max(ROLLOUT_TIMING.metricWindowSeconds, minWindow);

  const withCluster = deps.provisioning.withCluster;
  if (withCluster === null) {
    throw new ServiceUnavailableError(
      "Tiến trình này không truy cập được cluster để tạo rollout SERVICE_LEVEL",
    );
  }
  const prometheusUrl =
    tool === "argo-rollouts" &&
    input.controlMode === "tool-driven" &&
    input.strategy === "CANARY"
      ? await inClusterPrometheus(deps, projectId, input.envId)
      : undefined;
  const spec: Omit<DeliverySpec, "sessionId"> = {
    tool,
    mode: input.controlMode,
    strategy: input.strategy,
    workloadName: input.workloadName,
    namespace,
    router: delivery.router,
    stepPercent: input.stepPercent,
    stepIntervalSeconds: input.stepIntervalSeconds,
    analysisIntervalSeconds: input.analysisIntervalSeconds,
    metricWindowSeconds,
    thresholds: input.thresholds,
    ...(input.trafficMatch === undefined
      ? {}
      : { trafficMatch: input.trafficMatch }),
  };

  return withCluster(projectId, async (access) => {
    const plan = await PLANNERS[tool]({
      client: await access.getClient("workload"),
      spec,
      imageTag: input.imageTag,
      prometheusUrl,
      gateBaseUrl: deps.provisioning.flaggerGateBaseUrl,
    });
    let session: repository.NewSession;
    try {
      session = await repository.insertServiceSession({
        projectId,
        environmentId: input.envId,
        target: input,
        versionOld: plan.versionOld,
        versionNew: plan.versionNew,
        metricWindowSeconds,
        actorUserId,
        request,
      });
    } catch (err: unknown) {
      if (err instanceof repository.ActiveRolloutExists) {
        const conflict = new ConflictError(
          "Workload này đã có một rollout SERVICE_LEVEL đang chạy (§8.5)",
          undefined,
          "ROLLOUT_IN_PROGRESS",
        );
        throw err.activeRolloutId === undefined
          ? conflict
          : conflict.withResource(err.activeRolloutId);
      }
      throw err;
    }
    try {
      await plan.apply(session.id);
    } catch (err: unknown) {
      const failure = clusterFailure(err);
      await compensateCreate({
        projectId,
        session,
        reason: `ghi đối tượng giao hàng hỏng: ${failure.message}`,
        failure: (suffix) => suffixed(failure, suffix),
        actorUserId,
        request,
      });
    }
    await repository.recordServiceDeployStart({
      projectId,
      environmentId: input.envId,
      sessionId: session.id,
      workloadName: input.workloadName,
      imageTag: plan.versionNew,
      metadata: {
        scope: "SERVICE_LEVEL",
        tool,
        controlMode: input.controlMode,
        strategy: input.strategy,
        versionOld: plan.versionOld,
      } satisfies Json,
    });
    return session.id;
  }).catch((err: unknown) => {
    throw clusterFailure(err);
  });
}
