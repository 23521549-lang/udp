import type {
  CloudAdapter,
  ClusterAccess,
  ClusterInfo,
  CreatedResource,
  ResolvedCredential,
  ResourceStep,
} from "@udp/adapter-core";
import {
  CloudAdapterRunner,
  FatalRunnerError,
  FenceLostError,
  inheritFromLedger,
  silentObserver,
  type Fence,
  type RunOutcome,
  type RunPlan,
  type RunnerObserver,
} from "@udp/adapter-core/runner";
import { isGatewayError, safeMessage } from "@udp/cloud-adapters";
import {
  keepLease,
  type DeploymentEventType,
  type JobState,
  Prisma,
  type PrismaClient,
  type ProjectStatus,
} from "@udp/db";
import { logger, redact } from "@udp/http";
import type { CloudPlatform } from "../modules/cloud/cloud.platform.js";
import { activeEnvelope } from "../modules/cloud/cloud.repository.js";
import type {
  AdminToken,
  ClusterRuntime,
} from "../modules/cluster/cluster-runtime.js";
import { resolveCredential } from "../modules/credential/credential.resolver.js";
import type { DomainAdapterRegistry } from "../modules/domain/domain-adapter.registry.js";
import {
  runDomainPhase,
  teardownDomains,
  type DomainPhaseInput,
  type PhaseEnvironment,
} from "../modules/provisioning/domain-phase.js";
import { createPrismaLedger } from "../modules/provisioning/prisma-ledger.js";
import {
  phaseSteps,
  provisionPayloadSchema,
  tagsOf,
  type ProvisionPayload,
} from "../modules/provisioning/provision-plan.js";
import {
  claim,
  createPrismaFence,
  currentState,
  JobCancelledError,
  release,
  renew,
  TERMINAL_STATES,
  transition,
  type JobLease,
  type Transition,
} from "../modules/provisioning/provisioning-job.repository.js";
import type { Attempt } from "./boss.js";

/**
 * Job PROVISION (§8.1 giai đoạn 2, Plan #28 QĐ-2..QĐ-5): NETWORK → CLUSTER → CLUSTER_ACCESS
 * → DOMAINS → DONE, chạy trong worker của Service 1.
 *
 * Ba loại thất bại, ba nhánh — phân biệt chúng là toàn bộ độ khó của tệp này:
 *
 *  - **Chí tử** (`FatalRunnerError`: mất lease, crash mô phỏng): dừng NGAY, không ghi gì
 *    nữa. Job không còn là của worker này; pg-boss giao lại, worker sau đọc sổ và `lookup`.
 *  - **Vĩnh viễn** (`PhaseFailedError`: step vỡ và runner đã bù trừ pha đó, vượt quota,
 *    credential bị từ chối, domain lỗi) hoặc người dùng HỦY: bù trừ CẢ kế hoạch ngay —
 *    thử lại không đổi được kết cục mà tài nguyên đã tạo đang tính tiền.
 *  - **Tạm** (mạng, tra cứu bất định, cluster chưa sẵn sàng): nhả lease và ném để pg-boss
 *    thử lại; resume đi qua sổ. Chỉ lượt CUỐI mới bù trừ (§8.1 "hết lượt retry ⇒
 *    COMPENSATING").
 *
 * Mọi đổi `state` đi qua `transition` (fencing theo `version`) cùng các ghi nghiệp vụ của
 * bước đó trong MỘT transaction.
 */

export interface ProvisionWorkerDeps {
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

export interface ProvisionWorker {
  /** Handler của hàng `udp-provision` */
  provision(jobId: string, attempt: Pick<Attempt, "final">): Promise<void>;
  /** Handler của hàng `udp-compensate` — đối soát gửi khi lượt cuối đã chết */
  compensate(jobId: string): Promise<void>;
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

interface JobInput {
  jobId: string;
  projectId: string;
  payload: ProvisionPayload;
  environments: PhaseEnvironment[];
  adapter: CloudAdapter;
}

/** Lượt đang giữ lease: `lease` đổi sau mỗi `transition` (version mới là fence mới) */
interface Run {
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

const messageOf = (e: unknown): string =>
  isGatewayError(e)
    ? safeMessage(e)
    : e instanceof Error
      ? e.message
      : String(e);

export function createProvisionWorker(
  deps: ProvisionWorkerDeps,
): ProvisionWorker {
  const { prisma } = deps;
  const log = (jobId: string, message: string): void => {
    logger.info({ jobId }, message);
  };

  async function load(jobId: string): Promise<JobInput> {
    const job = await prisma.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        projectId: true,
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
    const payload = provisionPayloadSchema.parse(job.payload);
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

  /** Chốt hủy hợp tác ở đầu mỗi step: runner coi nó là step vỡ và bù trừ pha đang chạy */
  const cancellable = (jobId: string): RunnerObserver => ({
    async onPhase(phase, stepName) {
      await (deps.observer ?? silentObserver).onPhase(phase, stepName);
      if (
        phase === "before-lookup" &&
        (await currentState(prisma, jobId)) === "CANCEL_REQUESTED"
      ) {
        throw new JobCancelledError(jobId);
      }
    },
  });

  const runnerFor = (run: Run, jobId: string): CloudAdapterRunner =>
    new CloudAdapterRunner({
      ledger: createPrismaLedger({ prisma, jobId }),
      fence: fenceOf(run),
      observer: cancellable(jobId),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });

  const planOf = (
    input: JobInput,
    credential: ResolvedCredential,
    step: RunPlan["step"],
    steps: readonly ResourceStep[],
    inherited: Readonly<Record<string, CreatedResource>> = {},
  ): RunPlan => ({
    projectId: input.projectId,
    provider: input.payload.provider,
    region: input.payload.region,
    step,
    steps,
    credential,
    quota: input.payload.quota,
    inherited,
    ...(step === "CLUSTER" ? { plannedNodes: input.payload.nodeCount } : {}),
  });

  function createdOf(outcome: RunOutcome): Record<string, CreatedResource> {
    switch (outcome.status) {
      case "SUCCESS":
        return outcome.created;
      case "RETRYABLE":
        // Tra cứu bất định: hàng giữ CREATING, lượt sau tra lại (RUN5)
        throw new Error(
          `tra cứu bất định ở ${outcome.atStep}: ${outcome.reason}`,
        );
      case "QUOTA_REJECTED":
        throw new PhaseFailedError(`vượt quota: ${outcome.reason}`);
      case "COMPENSATED":
        throw new PhaseFailedError(`${outcome.failedStep}: ${outcome.reason}`);
      case "COMPENSATION_FAILED":
        throw new PhaseFailedError(
          `${outcome.failedStep}: bù trừ còn ${String(outcome.orphans.length)} tài nguyên`,
        );
    }
  }

  const advance = (run: Run, t: Transition): Promise<void> =>
    exclusive(run, async () => {
      run.lease = await transition(prisma, run.lease, t);
    });

  /** Sự kiện deploy cho MỌI environment — cùng `deployment_id` là id của job (§2.2) */
  const deployEvents = (
    input: JobInput,
    eventType: DeploymentEventType,
    metadata: Prisma.InputJsonObject,
  ) => ({
    data: input.environments.map((e) => ({
      projectId: input.projectId,
      environmentId: e.id,
      deploymentId: input.jobId,
      eventType,
      triggeredBy: "MANUAL" as const,
      metadata: { jobType: "PROVISION", ...metadata },
    })),
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

  /** Chạy từ `state` hiện tại tới DONE; mọi thất bại ném ra cho `provision` phân loại */
  async function forward(
    run: Run,
    input: JobInput,
    from: JobState,
  ): Promise<void> {
    const { projectId, payload } = input;
    let state = from;
    let network: Record<string, CreatedResource> | undefined;

    if (state === "QUEUED") {
      await advance(run, {
        state: "NETWORK",
        forward: true,
        effects: async (tx) => {
          await tx.project.update({
            where: { id: projectId },
            data: { status: "PROVISIONING" },
          });
          await tx.deploymentEvent.createMany(
            deployEvents(input, "DEPLOY_START", {}),
          );
        },
      });
      state = "NETWORK";
    }

    if (state === "NETWORK") {
      network = await withCredential(projectId, async (credential) =>
        createdOf(
          await runnerFor(run, input.jobId).run(
            planOf(
              input,
              credential,
              "NETWORK",
              phaseSteps(input.adapter, projectId, payload).network,
            ),
          ),
        ),
      );
      await advance(run, { state: "CLUSTER", forward: true });
      state = "CLUSTER";
    }

    if (state === "CLUSTER") {
      await withCredential(projectId, async (credential) => {
        // Resume sau khi worker chết giữa hai pha: tài nguyên mạng dựng lại từ SỔ + cloud
        const inherited =
          network ??
          (await inheritFromLedger({
            steps: phaseSteps(input.adapter, projectId, payload).network,
            rows: await createPrismaLedger({
              prisma,
              jobId: input.jobId,
            }).rowsOf(projectId),
            credential,
          }));
        createdOf(
          await runnerFor(run, input.jobId).run(
            planOf(
              input,
              credential,
              "CLUSTER",
              phaseSteps(input.adapter, projectId, payload, inherited).cluster,
              inherited,
            ),
          ),
        );
      });
      await advance(run, { state: "CLUSTER_ACCESS", forward: true });
      state = "CLUSTER_ACCESS";
    }

    if (state === "CLUSTER_ACCESS") {
      const info = await withCredential(projectId, async (credential) => {
        const cluster = await clusterOf(input, credential);
        if (cluster === null) {
          throw new PhaseFailedError(
            "sổ không có cluster READY sau pha CLUSTER",
          );
        }
        await fenceOf(run).assert();
        await deps.clusters.bootstrap(cluster.info, cluster.admin, {
          projectId,
          environments: input.environments,
          quota: payload.quota,
        });
        return cluster.info;
      });
      await advance(run, {
        state: "DOMAINS",
        forward: true,
        effects: async (tx) => {
          // ADR-06, I24: endpoint + CA + tên SA — KHÔNG token, không kubeconfig
          await tx.project.update({
            where: { id: projectId },
            data: {
              clusterAccess: {
                clusterId: info.clusterId,
                clusterName: info.clusterName,
                apiEndpoint: info.apiEndpoint,
                caData: info.caData,
                ...(info.controlPlaneServiceAccounts === undefined
                  ? {}
                  : {
                      controlPlaneServiceAccounts: {
                        ...info.controlPlaneServiceAccounts,
                      },
                    }),
              },
            },
          });
        },
      });
      state = "DOMAINS";
    }

    if (state !== "DOMAINS") {
      throw new PhaseFailedError(`job ở trạng thái lạ ${state}`);
    }
    const outcome = await withCredential(projectId, async (credential) => {
      const cluster = await clusterOf(input, credential);
      if (cluster === null) {
        throw new PhaseFailedError("sổ không có cluster READY ở pha DOMAINS");
      }
      return runDomainPhase(
        await domainInput(
          run,
          input,
          deps.clusters.accessFor(cluster.info, cluster.admin),
        ),
      );
    });
    if (outcome.status === "FAILED") {
      throw new PhaseFailedError(
        `domain ${outcome.domainType}: ${outcome.message}`,
      );
    }
    await advance(run, {
      state: "DONE",
      forward: true,
      release: true,
      effects: async (tx) => {
        await tx.project.update({
          where: { id: projectId },
          data: { status: "ACTIVE" },
        });
        await tx.deploymentEvent.createMany(
          deployEvents(input, "DEPLOY_SUCCESS", {
            domains: outcome.deployed,
          }),
        );
      },
    });
  }

  /**
   * Bù trừ CẢ kế hoạch rồi kết thúc job (§8.1 nhánh thất bại): gỡ domain (load balancer do
   * Kubernetes tạo giữ VPC), xoá tài nguyên cloud ngược thứ tự, rồi FAILED hoặc
   * COMPENSATION_FAILED. Hủy theo yêu cầu mà dọn sạch ⇒ project về DRAFT: không còn gì
   * trên cloud, người dùng sửa cấu hình rồi chạy lại.
   */
  async function compensateAll(
    run: Run,
    input: JobInput,
    reason: string,
  ): Promise<void> {
    const { projectId, payload } = input;
    const cancelled =
      (await currentState(prisma, input.jobId)) === "CANCEL_REQUESTED";
    await advance(run, { state: "COMPENSATING" });
    log(input.jobId, `bù trừ: ${reason}`);

    const outcome = await withCredential(projectId, async (credential) => {
      const cluster = await clusterOf(input, credential).catch((e: unknown) => {
        log(
          input.jobId,
          `không chạm được cluster để gỡ domain: ${messageOf(e)}`,
        );
        return null;
      });
      const domainFailures =
        cluster === null
          ? []
          : await teardownDomains(
              await domainInput(
                run,
                input,
                deps.clusters.accessFor(cluster.info, cluster.admin),
              ),
            );
      const steps = phaseSteps(input.adapter, projectId, payload);
      const cloud = await runnerFor(run, input.jobId).compensate(
        planOf(input, credential, "CLUSTER", [
          ...steps.network,
          ...steps.cluster,
        ]),
        reason,
      );
      return { cloud, domainFailures };
    });

    const clean = outcome.cloud.status === "COMPENSATED";
    const projectStatus: ProjectStatus = clean && cancelled ? "DRAFT" : "ERROR";
    const lastError = redact({
      step: "COMPENSATION",
      message: cancelled ? "hủy theo yêu cầu" : reason,
      orphans:
        outcome.cloud.status === "COMPENSATION_FAILED"
          ? [...outcome.cloud.orphans]
          : [],
      domainTeardownFailures: outcome.domainFailures,
      at: new Date().toISOString(),
    });
    await advance(run, {
      state: clean ? "FAILED" : "COMPENSATION_FAILED",
      release: true,
      lastError,
      effects: async (tx) => {
        await tx.project.update({
          where: { id: projectId },
          data: {
            status: projectStatus,
            // Cluster đã bị xoá (hay đang mồ côi): không trỏ Portal và job sau vào nó
            clusterAccess: Prisma.DbNull,
          },
        });
        // Hủy khi job còn QUEUED: chưa có lượt deploy nào bắt đầu, không có gì để khép lại
        const started = await tx.deploymentEvent.count({
          where: { deploymentId: input.jobId, eventType: "DEPLOY_START" },
        });
        if (started > 0) {
          await tx.deploymentEvent.createMany(
            deployEvents(input, "DEPLOY_FAILURE", {
              reason: cancelled ? "CANCELLED" : "FAILED",
            }),
          );
        }
      },
    });
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

  const isPermanent = (e: unknown): boolean =>
    e instanceof PhaseFailedError || e instanceof JobCancelledError;

  return {
    provision: (jobId, attempt) =>
      withLease(jobId, async (run) => {
        const input = await load(jobId);
        const state = await currentState(prisma, jobId);
        if (state === "CANCEL_REQUESTED" || state === "COMPENSATING") {
          await compensateAll(run, input, "tiếp tục bù trừ dang dở");
          return;
        }
        try {
          await forward(run, input, state ?? "QUEUED");
        } catch (e) {
          if (e instanceof FatalRunnerError) throw e;
          if (!isPermanent(e) && !attempt.final) throw e;
          await compensateAll(run, input, messageOf(e));
        }
      }),

    compensate: (jobId) =>
      withLease(jobId, async (run) => {
        await compensateAll(
          run,
          await load(jobId),
          "lượt cuối của worker đã dừng giữa chừng — đối soát bù trừ",
        );
      }),
  };
}
