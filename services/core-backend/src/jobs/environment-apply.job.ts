import { redact } from "@udp/http";
import { environmentApplyPayloadSchema } from "../modules/environment/environment-apply.payload.js";
import { reconcileEnvironment } from "../modules/provisioning/domain-phase.js";
import { currentState } from "../modules/provisioning/provisioning-job.repository.js";
import { PhaseFailedError, type JobKit } from "./job-kit.js";

/**
 * Job `ENVIRONMENT_APPLY` (Plan #40 QĐ-6, D-P31): thêm hay bớt MỘT environment trên cluster của
 * project đang chạy. Trạng thái `QUEUED → DOMAINS → DONE | FAILED`, như `DOMAIN_APPLY`; không tạo
 * tài nguyên cloud nên không bù trừ cloud — chạy lại là hội tụ về đúng tập environment.
 *
 * - **ADD**: bootstrap cluster với MỌI environment (server-side apply, idempotent — namespace, SA,
 *   Role, NetworkPolicy, ResourceQuota của env mới), rồi `reconcileEnvironment`.
 * - **REMOVE**: hàng environment đã bị xoá khi tạo job, nên `input.environments` đã là tập còn
 *   lại; `reconcileEnvironment` gỡ thứ của env đó, rồi xoá namespace của BẢN CHỤP bằng token quản
 *   trị. Gỡ domain lỗi thì KHÔNG xoá namespace: chạy lại phải còn thấy thứ cần gỡ.
 */

export interface EnvironmentApplyJob {
  run(jobId: string): Promise<void>;
}

export function createEnvironmentApplyJob(kit: JobKit): EnvironmentApplyJob {
  const { prisma, clusters } = kit.deps;

  return {
    run: (jobId) =>
      kit.withLease(jobId, async (run) => {
        const input = await kit.load(jobId);
        const raw = await prisma.provisioningJob.findUniqueOrThrow({
          where: { id: jobId },
          select: { payload: true },
        });
        const { change } = environmentApplyPayloadSchema.parse(raw.payload);
        if ((await currentState(prisma, jobId)) === "QUEUED") {
          await kit.advance(run, { state: "DOMAINS", forward: true });
        }

        let failures: string[];
        try {
          failures = await kit.withCredential(
            input.projectId,
            async (credential) => {
              const cluster = await kit.clusterOf(input, credential);
              if (cluster === null) {
                throw new PhaseFailedError(
                  "không chạm được cluster của project",
                );
              }
              await kit.fenceOf(run).assert();
              if (change.action === "ADD") {
                await clusters.bootstrap(cluster.info, cluster.admin, {
                  projectId: input.projectId,
                  environments: input.environments,
                  quota: input.payload.quota,
                });
              }
              const phase = await kit.domainInput(
                run,
                input,
                clusters.accessFor(cluster.info, cluster.admin),
              );
              const found = await reconcileEnvironment(
                phase,
                change.action,
                change.environment,
              );
              if (change.action === "REMOVE" && found.length === 0) {
                await kit.fenceOf(run).assert();
                await clusters.removeNamespace(
                  cluster.info,
                  cluster.admin,
                  change.environment.k8sNamespace,
                );
              }
              return found;
            },
          );
        } catch (e) {
          if (!(e instanceof PhaseFailedError)) throw e;
          failures = [e.message];
        }

        await kit.advance(run, {
          state: failures.length === 0 ? "DONE" : "FAILED",
          release: true,
          ...(failures.length === 0
            ? {}
            : {
                lastError: redact({
                  step: "ENVIRONMENT_APPLY",
                  message: `${change.action} ${change.environment.name}: ${failures.join("; ")}`,
                  orphans: [],
                  at: new Date().toISOString(),
                }),
              }),
        });
      }),
  };
}
