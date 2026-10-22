import type {
  CreatedResource,
  ResolvedCredential,
  ResourceStep,
} from "@udp/adapter-core";
import {
  CloudAdapterRunner,
  FatalRunnerError,
  inheritFromLedger,
  silentObserver,
  type RunOutcome,
  type RunPlan,
  type RunnerObserver,
} from "@udp/adapter-core/runner";
import {
  Prisma,
  type DeploymentEventType,
  type JobState,
  type ProjectStatus,
} from "@udp/db";
import { redact } from "@udp/http";
import {
  runDomainPhase,
  teardownDomains,
} from "../modules/provisioning/domain-phase.js";
import { createPrismaLedger } from "../modules/provisioning/prisma-ledger.js";
import { phaseSteps } from "../modules/provisioning/provision-plan.js";
import {
  currentState,
  JobCancelledError,
} from "../modules/provisioning/provisioning-job.repository.js";
import type { Attempt } from "./boss.js";
import {
  messageOf,
  PhaseFailedError,
  type JobInput,
  type JobKit,
  type Run,
} from "./job-kit.js";

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

export interface ProvisionJob {
  run(jobId: string, attempt: Pick<Attempt, "final">): Promise<void>;
  /** Đối soát gửi khi lượt cuối đã chết giữa chừng */
  compensate(jobId: string): Promise<void>;
}

/**
 * Trạng thái project do worker ghi — có điều kiện: project đã xoá mềm (Plan #29 QĐ-3) không
 * bao giờ sống lại vì một lượt provisioning kết thúc sau lệnh xoá.
 */
async function setProjectStatus(
  tx: Prisma.TransactionClient,
  projectId: string,
  data: Prisma.ProjectUpdateManyMutationInput,
): Promise<void> {
  await tx.project.updateMany({
    where: { id: projectId, status: { not: "DELETED" } },
    data,
  });
}

export function createProvisionJob(kit: JobKit): ProvisionJob {
  const { deps, advance, withCredential, fenceOf, clusterOf, domainInput } =
    kit;
  const { prisma } = deps;
  const log = kit.log;

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
          await setProjectStatus(tx, projectId, { status: "PROVISIONING" });
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
          await setProjectStatus(tx, projectId, {
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
        await setProjectStatus(tx, projectId, { status: "ACTIVE" });
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
      const access = await kit.clusterAccessOf(input, credential);
      const domainFailures =
        access === null
          ? []
          : await teardownDomains(await domainInput(run, input, access));
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
        await setProjectStatus(tx, projectId, {
          status: projectStatus,
          // Cluster đã bị xoá (hay đang mồ côi): không trỏ Portal và job sau vào nó
          clusterAccess: Prisma.DbNull,
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

  const isPermanent = (e: unknown): boolean =>
    e instanceof PhaseFailedError || e instanceof JobCancelledError;

  return {
    run: (jobId, attempt) =>
      kit.withLease(jobId, async (run) => {
        const input = await kit.load(jobId);
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
      kit.withLease(jobId, async (run) => {
        await compensateAll(
          run,
          await kit.load(jobId),
          "lượt cuối của worker đã dừng giữa chừng — đối soát bù trừ",
        );
      }),
  };
}
