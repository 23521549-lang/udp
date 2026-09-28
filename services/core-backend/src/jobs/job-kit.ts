import type {
  CloudAdapter,
  ClusterAccess,
  ClusterInfo,
  ControlPlaneIdentity,
  ResolvedCredential,
} from "@udp/adapter-core";
import {
  FatalRunnerError,
  FenceLostError,
  type Fence,
  type RunnerObserver,
} from "@udp/adapter-core/runner";
import { isGatewayError, safeMessage } from "@udp/cloud-adapters";
import { keepLease, type PrismaClient } from "@udp/db";
import { logger } from "@udp/http";
import type { CloudPlatform } from "../modules/cloud/cloud.platform.js";
import { activeEnvelope } from "../modules/cloud/cloud.repository.js";
import type { ResolvedAccess } from "../modules/cluster/cluster-access-cache.js";
import type {
  AdminToken,
  ClusterRuntime,
} from "../modules/cluster/cluster-runtime.js";
import type { IssuedClusterToken } from "../modules/cluster/cluster-token.js";
import { resolveCredential } from "../modules/credential/credential.resolver.js";
import type { DomainAdapterRegistry } from "../modules/domain/domain-adapter.registry.js";
import type {
  DomainPhaseInput,
  PhaseEnvironment,
} from "../modules/provisioning/domain-phase.js";
import { domainApplyPayloadSchema } from "../modules/domain/domain-apply.payload.js";
import { environmentApplyPayloadSchema } from "../modules/environment/environment-apply.payload.js";
import { createPrismaLedger } from "../modules/provisioning/prisma-ledger.js";
import {
  provisionPayloadSchema,
  tagsOf,
  type ProvisionPayload,
} from "../modules/provisioning/provision-plan.js";
import {
  claim,
  createPrismaFence,
  currentState,
  release,
  renew,
  TERMINAL_STATES,
  transition,
  type JobLease,
  type Transition,
} from "../modules/provisioning/provisioning-job.repository.js";

/**
 * Bộ đồ nghề chung của mọi job trên `ProvisioningJob` (Plan #28, Plan #29 QĐ-4): giành và
 * giữ lease, fence, credential ngắn hạn, đọc cluster của project, dựng đầu vào cho Domain
 * Adapter. PROVISION và TEARDOWN khác nhau ở VIỆC làm, không ở cách giữ quyền làm việc —
 * hai bản sao của đoạn lease là hai chỗ để một bản sửa lọt mất một bên.
 */

export interface JobKitDeps {
  prisma: PrismaClient;
  platform: CloudPlatform;
  domainRegistry: () => Promise<DomainAdapterRegistry>;
  clusters: ClusterRuntime;
  /** Egress guard (§12 T11) — `ctx.fetch` của Domain Adapter */
  egressFetch: typeof fetch;
  workerId: string;
  lease: { leaseMs: number; renewIntervalMs: number; errorRetryMs: number };
  /** Quan sát runner — lưới crash tiêm vào; mặc định im lặng */
  observer?: RunnerObserver;
  sleep?: (ms: number) => Promise<void>;
}

/** Thất bại mà thử lại không đổi được — đi thẳng nhánh bù trừ */
export class PhaseFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseFailedError";
  }
}

/** Job chưa kết thúc nhưng lease đang ở worker khác — pg-boss thử lại sau, không bỏ job */
export class LeaseBusyError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId} đang được một worker khác giữ lease`);
    this.name = "LeaseBusyError";
  }
}

export interface JobInput {
  jobId: string;
  projectId: string;
  /** Ảnh chụp lúc tạo job; TEARDOWN mang lại payload của lượt PROVISION gần nhất */
  payload: ProvisionPayload;
  environments: PhaseEnvironment[];
  adapter: CloudAdapter;
}

/** Lượt đang giữ lease: `lease` đổi sau mỗi `transition` (version mới là fence mới) */
export interface Run {
  lease: JobLease;
  lost: string | null;
  /**
   * Gia hạn và đổi `state` đi LẦN LƯỢT: gia hạn đọc `version` đúng lúc một `transition` vừa
   * tăng nó sẽ nhận 0 hàng, và keeper coi đó là mất lease thật.
   */
  queue: Promise<unknown>;
}

function exclusive<T>(run: Run, task: () => Promise<T>): Promise<T> {
  const next = run.queue.then(task, task);
  run.queue = next.catch(() => undefined);
  return next;
}

export const messageOf = (e: unknown): string =>
  isGatewayError(e)
    ? safeMessage(e)
    : e instanceof Error
      ? e.message
      : String(e);

export type JobKit = ReturnType<typeof createJobKit>;

export function createJobKit(deps: JobKitDeps) {
  const { prisma } = deps;
  const log = (jobId: string, message: string): void => {
    logger.info({ jobId }, message);
  };

  async function load(jobId: string): Promise<JobInput> {
    const job = await prisma.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        projectId: true,
        jobType: true,
        payload: true,
        project: {
          select: {
            environments: {
              select: {
                id: true,
                name: true,
                k8sNamespace: true,
                isProduction: true,
              },
              orderBy: { rank: "asc" },
            },
          },
        },
      },
    });
    // DOMAIN_APPLY, ENVIRONMENT_APPLY mang hạ tầng trong `infra`; PROVISION, TEARDOWN mang chính nó
    const payload =
      job.jobType === "DOMAIN_APPLY"
        ? domainApplyPayloadSchema.parse(job.payload).infra
        : job.jobType === "ENVIRONMENT_APPLY"
          ? environmentApplyPayloadSchema.parse(job.payload).infra
          : provisionPayloadSchema.parse(job.payload);
    const adapter = deps.platform.adapterFor(payload.provider, payload.region);
    if (adapter === null) {
      throw new PhaseFailedError(
        `cloud ${payload.provider} không bật ở triển khai này`,
      );
    }
    return {
      jobId,
      projectId: job.projectId,
      payload,
      environments: job.project.environments,
      adapter,
    };
  }

  /** Credential ngắn hạn cho MỘT việc rồi huỷ; bị cloud từ chối là thất bại vĩnh viễn */
  async function withCredential<T>(
    projectId: string,
    use: (credential: ResolvedCredential) => Promise<T>,
  ): Promise<T> {
    const envelope = await activeEnvelope(projectId);
    if (envelope === null) {
      throw new PhaseFailedError("project không còn credential cloud");
    }
    let credential: ResolvedCredential;
    try {
      credential = await resolveCredential(envelope, deps.platform);
    } catch (e) {
      if (
        isGatewayError(e) &&
        (e.errorClass === "permission" || e.errorClass === "configuration")
      ) {
        throw new PhaseFailedError(`credential bị từ chối: ${safeMessage(e)}`);
      }
      throw e;
    }
    try {
      return await use(credential);
    } finally {
      credential.dispose();
    }
  }

  const fenceOf = (run: Run): Fence => ({
    assert: () =>
      run.lost === null
        ? createPrismaFence(prisma, run.lease).assert()
        : Promise.reject(new FenceLostError(run.lost)),
  });

  const advance = (run: Run, t: Transition): Promise<void> =>
    exclusive(run, async () => {
      run.lease = await transition(prisma, run.lease, t);
    });

  /** Cluster của project: id từ SỔ (hàng `cluster` READY), trạng thái từ CLOUD */
  async function clusterOf(
    input: JobInput,
    credential: ResolvedCredential,
  ): Promise<{ info: ClusterInfo; admin: AdminToken } | null> {
    const rows = await createPrismaLedger({
      prisma,
      jobId: input.jobId,
    }).rowsOf(input.projectId);
    const row = rows.find(
      (r) => r.kind === "cluster" && r.status === "READY" && r.providerId,
    );
    if (row?.providerId == null) return null;
    const status = await input.adapter.getClusterStatus(
      credential,
      row.providerId,
    );
    if (status.status !== "SUCCESS" || status.data === undefined) {
      throw new Error(`không đọc được cluster: ${String(status.message)}`);
    }
    if (status.data.status !== "READY") {
      throw new Error(`cluster đang ${status.data.status}`);
    }
    const token = await input.adapter.getKubeAuthToken(credential, status.data);
    if (token.status !== "SUCCESS" || token.data === undefined) {
      throw new Error(`không lấy được token cluster: ${String(token.message)}`);
    }
    return { info: status.data, admin: token.data };
  }

  async function domainInput(
    run: Run,
    input: JobInput,
    access: ClusterAccess,
  ): Promise<DomainPhaseInput> {
    return {
      prisma,
      projectId: input.projectId,
      registry: await deps.domainRegistry(),
      access,
      environments: input.environments,
      region: input.payload.region,
      quota: input.payload.quota,
      tags: tagsOf(input.projectId, input.payload),
      fetch: deps.egressFetch,
      fence: fenceOf(run),
      progress: (m) => {
        log(input.jobId, m);
      },
    };
  }

  /**
   * Gỡ domain đang chạy trên cluster của project, nếu còn chạm được cluster — bước đầu của
   * mọi đường dọn (bù trừ, teardown): load balancer do Kubernetes tạo giữ VPC.
   */
  async function clusterAccessOf(
    input: JobInput,
    credential: ResolvedCredential,
  ): Promise<ClusterAccess | null> {
    const cluster = await clusterOf(input, credential).catch((e: unknown) => {
      log(input.jobId, `không chạm được cluster để gỡ domain: ${messageOf(e)}`);
      return null;
    });
    return cluster === null
      ? null
      : deps.clusters.accessFor(cluster.info, cluster.admin);
  }

  /**
   * Cluster của project cho việc ngoài job hạ tầng (theo dõi deploy, hỏi chi phí, đo metrics, cấp token cho
   * Service 3): cluster lấy từ lượt PROVISION xong gần nhất, credential cloud ngắn hạn huỷ ngay sau khi xin
   * token quản trị — mọi thứ dựng từ đây chỉ dựa vào token đó, nên sống tới `expiresAt` của nó (Plan #39).
   * Project chưa có cluster ⇒ `PhaseFailedError` (thử lại không đổi được gì).
   */
  async function projectCluster(
    projectId: string,
  ): Promise<{ info: ClusterInfo; admin: AdminToken }> {
    const job = await prisma.provisioningJob.findFirst({
      where: { projectId, jobType: "PROVISION", state: "DONE" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (job === null) throw new PhaseFailedError("project chưa có cluster");
    const input = await load(job.id);
    return withCredential(projectId, async (credential) => {
      const cluster = await clusterOf(input, credential);
      if (cluster === null) {
        throw new PhaseFailedError("project chưa có cluster");
      }
      return cluster;
    });
  }

  async function projectClusterAccess(
    projectId: string,
  ): Promise<ResolvedAccess> {
    const { info, admin } = await projectCluster(projectId);
    return {
      access: deps.clusters.accessFor(info, admin),
      expiresAt: admin.expiresAt,
    };
  }

  /**
   * [v4.11, Plan #51] Bound token của MỘT identity trên cluster của project, cùng địa chỉ và CA của API
   * server — thứ Service 3 cần để tự dựng `ClusterAccess` mà không bao giờ chạm credential cloud (ADR-06).
   */
  async function projectClusterToken(
    projectId: string,
    identity: ControlPlaneIdentity,
  ): Promise<IssuedClusterToken> {
    const { info, admin } = await projectCluster(projectId);
    const bound = await deps.clusters.boundToken(info, admin, identity);
    return {
      apiEndpoint: info.apiEndpoint,
      caData: info.caData,
      token: bound.token,
      expiresAt: bound.expiresAt,
    };
  }

  async function withProjectCluster<T>(
    projectId: string,
    use: (access: ClusterAccess) => Promise<T>,
  ): Promise<T> {
    return use((await projectClusterAccess(projectId)).access);
  }

  /** Giành lease + giữ nó sống trong suốt `body`; job đã kết thúc thì không làm gì */
  async function withLease(
    jobId: string,
    body: (run: Run) => Promise<void>,
  ): Promise<void> {
    const claimed = await claim({
      prisma,
      jobId,
      workerId: deps.workerId,
      leaseMs: deps.lease.leaseMs,
    });
    if (claimed === null) {
      const state = await currentState(prisma, jobId);
      if (state === null || TERMINAL_STATES.includes(state)) return;
      throw new LeaseBusyError(jobId);
    }
    const run: Run = {
      lease: claimed,
      lost: null,
      queue: Promise.resolve(),
    };
    const keeper = keepLease({
      renewIntervalMs: deps.lease.renewIntervalMs,
      leaseMs: deps.lease.leaseMs,
      errorRetryMs: deps.lease.errorRetryMs,
      renew: () =>
        exclusive(run, () => renew(prisma, run.lease, deps.lease.leaseMs)),
      onLost: (reason) => {
        run.lost = reason;
        log(jobId, reason);
      },
      isAbandoned: () => run.lost !== null,
    });
    try {
      await body(run);
    } catch (e) {
      // Lượt kế (pg-boss thử lại) giành được ngay thay vì chờ hết lease của chính mình
      if (!(e instanceof FatalRunnerError)) {
        await exclusive(run, () => release(prisma, run.lease)).catch(
          () => false,
        );
      }
      throw e;
    } finally {
      keeper.stop();
    }
  }

  return {
    deps,
    log,
    load,
    withCredential,
    fenceOf,
    advance,
    clusterOf,
    clusterAccessOf,
    projectClusterAccess,
    projectClusterToken,
    withProjectCluster,
    domainInput,
    withLease,
  };
}
