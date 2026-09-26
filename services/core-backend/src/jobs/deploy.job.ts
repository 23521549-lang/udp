import type { KubernetesClient, ObjectRef } from "@udp/adapter-core";
import type { DeploymentEventType, Prisma, PrismaClient } from "@udp/db";
import { z } from "zod";
import { ClusterCallFailedError } from "../modules/cluster/cluster-access.js";
import {
  imageOf,
  imagePatch,
  WORKLOAD_KINDS,
  workloadRef,
  type WorkloadKind,
  type WorkloadState,
} from "../modules/cicd/workload.js";
import type { Attempt } from "./boss.js";
import { messageOf, PhaseFailedError, type JobKit } from "./job-kit.js";

/**
 * Luồng 3 phần cluster — áp image rồi theo dõi (§8.3, Plan #36 QĐ-4, QĐ-5).
 *
 * Một job trên hàng đợi `udp-deploy` cho mỗi `deploymentId` (id của job pg-boss = `deploymentId`,
 * gửi lại là không làm gì), KHÔNG phải một `ProvisioningJob`. Nguồn sự thật là Event Store:
 * `DEPLOY_START` chưa có kết luận là việc còn phải làm (đối soát gửi lại, `reconcile.ts`), và unique
 * index `(deployment_id, environment_id, event_type)` + `ON CONFLICT DO NOTHING` làm worker thứ hai
 * (lease hết, khởi động lại) đi lại đường cũ mà không ghi hai lần SUCCESS.
 *
 * Quyền: `udp-workload` (§12.2) — chỉ ghi image và `imagePullSecrets`, không bao giờ `spec.strategy`
 * hay trạng thái rollout (I25). Thất bại đọc từ CHÍNH workload (`ProgressDeadlineExceeded` của
 * Deployment, `Degraded` của Rollout) — không cần quyền đọc pod mà `udp-workload` không có.
 */

export interface DeployWatchOptions {
  pollMs: number;
  /** Hạn khi workload không khai `progressDeadlineSeconds` */
  defaultProgressDeadlineSeconds: number;
  /** Trần một lượt theo dõi — dưới `expireInSeconds` của hàng đợi `udp-deploy` */
  maxWatchSeconds: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeployStart {
  deploymentId: string;
  projectId: string;
  environmentId: string;
  namespace: string;
  workloadName: string;
  imageRef: string;
  /** Chép sang SUCCESS/FAILURE: DORA đọc `commitTimestamp` ở sự kiện kết luận (lead time) */
  carried: Pick<
    Prisma.DeploymentEventUncheckedCreateInput,
    "pipelineId" | "commitSha" | "commitTimestamp" | "imageTag" | "triggeredBy"
  >;
}

const startMetadataSchema = z.object({ imageRef: z.string().min(1) });

type Db = Pick<PrismaClient, "deploymentEvent">;

/**
 * `DEPLOY_START` chưa kết luận của một lần deploy. `null` ⇒ không còn việc gì: không có START
 * (id lạ), đã có SUCCESS/FAILURE (worker khác xong trước), hay START hỏng — cái sau được kết luận
 * FAILURE ngay tại đây, để đối soát không gửi lại nó mãi.
 */
export async function pendingStartOf(
  prisma: PrismaClient,
  deploymentId: string,
): Promise<DeployStart | null> {
  const start = await prisma.deploymentEvent.findFirst({
    where: { deploymentId, eventType: "DEPLOY_START" },
    select: {
      projectId: true,
      environmentId: true,
      workloadName: true,
      pipelineId: true,
      commitSha: true,
      commitTimestamp: true,
      imageTag: true,
      triggeredBy: true,
      metadata: true,
      environment: { select: { k8sNamespace: true } },
    },
  });
  if (start === null) return null;
  const concluded = await prisma.deploymentEvent.count({
    where: {
      deploymentId,
      environmentId: start.environmentId,
      eventType: { in: ["DEPLOY_SUCCESS", "DEPLOY_FAILURE"] },
    },
  });
  if (concluded > 0) return null;
  // START luôn do webhook hay lượt duyệt ghi, cả hai mang đủ hai trường; thiếu là dữ liệu hỏng
  const meta = startMetadataSchema.safeParse(start.metadata);
  if (start.workloadName === null || !meta.success) {
    await prisma.deploymentEvent.createMany({
      data: [
        {
          projectId: start.projectId,
          environmentId: start.environmentId,
          deploymentId,
          eventType: "DEPLOY_FAILURE",
          workloadName: start.workloadName,
          triggeredBy: start.triggeredBy,
          metadata: { reason: "sự kiện DEPLOY_START thiếu workload hay image" },
        },
      ],
      skipDuplicates: true,
    });
    return null;
  }
  return {
    deploymentId,
    projectId: start.projectId,
    environmentId: start.environmentId,
    namespace: start.environment.k8sNamespace,
    workloadName: start.workloadName,
    imageRef: meta.data.imageRef,
    carried: {
      pipelineId: start.pipelineId,
      commitSha: start.commitSha,
      commitTimestamp: start.commitTimestamp,
      imageTag: start.imageTag,
      triggeredBy: start.triggeredBy,
    },
  };
}

/** Ghi một lần — trùng khoá là không làm gì; `true` = lượt NÀY ghi */
async function recordOnce(
  db: Db,
  start: DeployStart,
  eventType: DeploymentEventType,
  metadata?: Prisma.InputJsonObject,
): Promise<boolean> {
  const { count } = await db.deploymentEvent.createMany({
    data: [
      {
        projectId: start.projectId,
        environmentId: start.environmentId,
        deploymentId: start.deploymentId,
        eventType,
        workloadName: start.workloadName,
        ...start.carried,
        ...(metadata === undefined ? {} : { metadata }),
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}

/**
 * FAILURE, và ROLLBACK nếu đã hoàn tác được — cùng một transaction: chết giữa hai lệnh ghi thì
 * lượt sau thấy FAILURE đã có và bỏ qua, ROLLBACK mất vĩnh viễn và MTTR không nối được.
 */
async function concludeFailure(
  prisma: PrismaClient,
  start: DeployStart,
  reason: string,
  restoredImage: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const first = await recordOnce(tx, start, "DEPLOY_FAILURE", { reason });
    if (!first || restoredImage === null) return;
    await tx.deploymentEvent.create({
      data: {
        projectId: start.projectId,
        environmentId: start.environmentId,
        deploymentId: start.deploymentId,
        eventType: "ROLLBACK",
        restoresDeploymentId: start.deploymentId,
        workloadName: start.workloadName,
        triggeredBy: "AUTO",
        metadata: { restoredImage },
      },
    });
  });
}

/**
 * Image của lần deploy THÀNH CÔNG gần nhất cùng workload — bản để hoàn tác về khi cluster không
 * còn cho biết (lượt thử lại: image mới đã được áp ở lượt trước).
 */
async function lastSuccessfulImage(
  prisma: PrismaClient,
  start: DeployStart,
): Promise<string | undefined> {
  const success = await prisma.deploymentEvent.findFirst({
    where: {
      environmentId: start.environmentId,
      workloadName: start.workloadName,
      eventType: "DEPLOY_SUCCESS",
      deploymentId: { not: start.deploymentId },
    },
    orderBy: { occurredAt: "desc" },
    select: { deploymentId: true },
  });
  if (success === null) return undefined;
  const origin = await prisma.deploymentEvent.findFirst({
    where: { deploymentId: success.deploymentId, eventType: "DEPLOY_START" },
    select: { metadata: true },
  });
  const meta = startMetadataSchema.safeParse(origin?.metadata);
  return meta.success ? meta.data.imageRef : undefined;
}

async function locate(
  client: KubernetesClient,
  start: DeployStart,
): Promise<{
  kind: WorkloadKind;
  ref: ObjectRef;
  state: WorkloadState;
} | null> {
  for (const kind of WORKLOAD_KINDS) {
    const ref = workloadRef(kind, start.namespace, start.workloadName);
    const state = await client.read<WorkloadState>("get", ref);
    if (state !== null) return { kind, ref, state };
  }
  return null;
}

/** Số lần thử lại khi người khác sửa workload giữa lúc đọc và lúc ghi (409) */
const CONFLICT_RETRIES = 3;

/** Đọc — sửa — ghi có điều kiện `resourceVersion`; 409 ⇒ đọc lại và thử lại */
async function setImage(
  client: KubernetesClient,
  ref: ObjectRef,
  container: string,
  image: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const state = await client.read<WorkloadState>("get", ref);
    if (state === null) {
      throw new PhaseFailedError("workload biến mất giữa lúc deploy");
    }
    const patch = imagePatch(state, container, image);
    if (patch === null) {
      throw new PhaseFailedError(`workload không có container "${container}"`);
    }
    try {
      await client.write("patch", ref, patch);
      return;
    } catch (e) {
      const conflict = e instanceof ClusterCallFailedError && e.status === 409;
      if (!conflict || attempt >= CONFLICT_RETRIES) throw e;
    }
  }
}

/**
 * Kết luận FAILURE một lần deploy mà không ai còn theo dõi (đối soát: pg-boss đã bỏ). Không hoàn
 * tác — không biết lượt đã chết có kịp áp ảnh hay chưa; lý do hiện trên Portal cho người vận hành.
 */
export async function abandonDeploy(
  prisma: PrismaClient,
  deploymentId: string,
  reason: string,
): Promise<void> {
  const start = await pendingStartOf(prisma, deploymentId);
  if (start !== null) await concludeFailure(prisma, start, reason, null);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function watchDeploy(
  prisma: PrismaClient,
  client: KubernetesClient,
  start: DeployStart,
  options: DeployWatchOptions,
): Promise<"success" | "failure"> {
  const sleep = options.sleep ?? delay;
  const found = await locate(client, start);
  if (found === null) {
    await concludeFailure(
      prisma,
      start,
      `workload "${start.workloadName}" chưa tồn tại ở environment này`,
      null,
    );
    return "failure";
  }
  const running = imageOf(found.state, start.workloadName);
  if (running === undefined) {
    await concludeFailure(
      prisma,
      start,
      `workload không có container "${start.workloadName}"`,
      null,
    );
    return "failure";
  }
  const previous =
    running !== start.imageRef
      ? running
      : await lastSuccessfulImage(prisma, start);

  await setImage(client, found.ref, start.workloadName, start.imageRef);
  const deadlineSeconds = Math.min(
    found.state.spec?.progressDeadlineSeconds ??
      options.defaultProgressDeadlineSeconds,
    options.maxWatchSeconds,
  );
  // Đếm nhịp thay vì đọc đồng hồ: hai nhịp dư cho controller kịp ghi điều kiện quá hạn
  const polls = Math.ceil((deadlineSeconds * 1000) / options.pollMs) + 2;
  for (let i = 0; i < polls; i++) {
    const state = await client.read<WorkloadState>("get", found.ref);
    const verdict = state === null ? "stuck" : found.kind.verdict(state);
    if (verdict === "done") {
      await recordOnce(prisma, start, "DEPLOY_SUCCESS");
      return "success";
    }
    if (verdict === "stuck") break;
    await sleep(options.pollMs);
  }

  // `rollout undo`: về image trước — version cũ tiếp tục phục vụ
  if (previous !== undefined) {
    await setImage(client, found.ref, start.workloadName, previous);
  }
  await concludeFailure(
    prisma,
    start,
    `rollout không xong trong ${String(deadlineSeconds)} giây`,
    previous ?? null,
  );
  return "failure";
}

export function createDeployJob(kit: JobKit, options: DeployWatchOptions) {
  const { prisma } = kit.deps;

  /** Client `udp-workload` của cluster project — cluster lấy từ lượt PROVISION xong gần nhất */
  async function withWorkloadClient<T>(
    projectId: string,
    use: (client: KubernetesClient) => Promise<T>,
  ): Promise<T> {
    const job = await prisma.provisioningJob.findFirst({
      where: { projectId, jobType: "PROVISION", state: "DONE" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (job === null) throw new PhaseFailedError("project chưa có cluster");
    const input = await kit.load(job.id);
    return kit.withCredential(projectId, async (credential) => {
      const cluster = await kit.clusterOf(input, credential);
      if (cluster === null) {
        throw new PhaseFailedError("project chưa có cluster");
      }
      const access = kit.deps.clusters.accessFor(cluster.info, cluster.admin);
      return use(await access.getClient("workload"));
    });
  }

  return {
    async run(
      deploymentId: string,
      attempt: Pick<Attempt, "final">,
    ): Promise<void> {
      const start = await pendingStartOf(prisma, deploymentId);
      if (start === null) return;
      try {
        await withWorkloadClient(start.projectId, (client) =>
          watchDeploy(prisma, client, start, options),
        );
      } catch (e) {
        // Lỗi tạm (mạng, 409 lặp, cluster chập chờn) ⇒ pg-boss thử lại; lượt cuối hay lỗi vĩnh viễn ⇒ kết luận
        if (!attempt.final && !(e instanceof PhaseFailedError)) throw e;
        await concludeFailure(
          prisma,
          start,
          `không theo dõi được deploy: ${messageOf(e)}`,
          null,
        );
      }
    },
  };
}
