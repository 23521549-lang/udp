import type {
  CreatedResource,
  ResolvedCredential,
  ResourceStatus,
} from "@udp/adapter-core";
import { Prisma } from "@udp/db";
import { redact } from "@udp/http";
import { teardownDomains } from "../modules/provisioning/domain-phase.js";
import { createPrismaLedger } from "../modules/provisioning/prisma-ledger.js";
import { phaseSteps } from "../modules/provisioning/provision-plan.js";
import { currentState } from "../modules/provisioning/provisioning-job.repository.js";
import {
  PhaseFailedError,
  type JobInput,
  type JobKit,
  type Run,
} from "./job-kit.js";

/**
 * Job TEARDOWN (§9 `DELETE /projects/:id`, Plan #29 QĐ-1/QĐ-2): dọn MỌI thứ project đã
 * dựng trên cloud của khách.
 *
 * 1. Gỡ domain ngược bậc khi còn chạm được cluster (Service LoadBalancer, PVC do chart tạo).
 * 2. Thu tài nguyên từ HAI nguồn: tag trên cloud (ADR-08, kèm tài nguyên Kubernetes sinh
 *    cho cluster) và hàng sổ còn sống tra lại bằng `lookupById` — kind không gắn được tag
 *    lúc tạo (GCP/Azure) chỉ thấy qua đường thứ hai.
 * 3. `adapter.teardown`: chín bậc §4.2, chờ tài nguyên Kubernetes biến mất TRƯỚC bậc mạng.
 * 4. Sổ: `DELETING` trước lời gọi, rồi `DELETED` hay `ORPHAN_SUSPECTED` theo kết quả.
 *
 * Trạng thái job: `QUEUED → COMPENSATING → DONE | COMPENSATION_FAILED` (QĐ-2). Chạy lại là
 * an toàn: hàng đã `DELETED` không ai chạm, tài nguyên đã mất là `not-found` = thành công.
 * Lỗi tạm ném ra cho pg-boss thử lại; lượt cuối chết thì đối soát gửi lại chính job này.
 */

export interface TeardownJob {
  run(jobId: string): Promise<void>;
}

/** Hàng sổ còn có thể là tài nguyên thật trên cloud */
const LIVE: readonly ResourceStatus[] = [
  "CREATING",
  "CREATED",
  "READY",
  "DELETING",
];

interface SweepOutcome {
  /** id không xoá được — kể cả tài nguyên Kubernetes không có hàng sổ */
  failed: string[];
  domainFailures: string[];
  /** Hàng `ORPHAN_SUSPECTED` từ trước: không chạm, cần người vận hành */
  pendingOrphans: string[];
}

export function createTeardownJob(kit: JobKit): TeardownJob {
  const { prisma } = kit.deps;

  async function sweep(
    run: Run,
    input: JobInput,
    credential: ResolvedCredential,
  ): Promise<SweepOutcome> {
    const { projectId, adapter } = input;
    const access = await kit.clusterAccessOf(input, credential);
    const domainFailures =
      access === null
        ? []
        : await teardownDomains(await kit.domainInput(run, input, access));
    await kit.fenceOf(run).assert();

    const ledger = createPrismaLedger({ prisma, jobId: input.jobId });
    const rows = await ledger.rowsOf(projectId);
    const pendingOrphans = rows.filter((r) => r.status === "ORPHAN_SUSPECTED");
    const orphanIds = new Set(pendingOrphans.map((r) => r.providerId));

    const listed = await adapter.listTaggedResources(credential, projectId);
    if (listed.status !== "SUCCESS" || listed.data === undefined) {
      // Quét tag lỗi KHÔNG phải "cloud rỗng": dọn trên kết quả đó là bỏ sót tài nguyên
      throw new Error(`không quét được tag: ${String(listed.message)}`);
    }
    const resources: CreatedResource[] = listed.data.filter(
      (r) => !orphanIds.has(r.id),
    );
    const seen = new Set(resources.map((r) => r.id));

    // Hàng sổ còn sống ⇒ id trên cloud (qua tag hoặc tra lại); `null` = cloud không còn gì
    const steps = phaseSteps(adapter, projectId, input.payload);
    const allSteps = [...steps.network, ...steps.cluster];
    const idOfRow = new Map<string, string | null>();
    const live = rows.filter((r) => LIVE.includes(r.status));
    for (const row of live) {
      if (row.providerId !== null && seen.has(row.providerId)) {
        idOfRow.set(row.idempotencyKey, row.providerId);
        continue;
      }
      const step = allSteps.find(
        (s) => s.idempotencyKey === row.idempotencyKey,
      );
      if (step === undefined) {
        idOfRow.set(row.idempotencyKey, null);
        continue;
      }
      const outcome =
        row.providerId === null
          ? await step.lookup(credential)
          : await step.lookupById(credential, row.providerId);
      if (outcome.kind === "indeterminate") {
        throw new Error(`tra cứu bất định ở ${step.name}: ${outcome.reason}`);
      }
      if (outcome.kind === "absent") {
        idOfRow.set(row.idempotencyKey, null);
        continue;
      }
      idOfRow.set(row.idempotencyKey, outcome.resource.id);
      if (!seen.has(outcome.resource.id)) {
        seen.add(outcome.resource.id);
        resources.push(outcome.resource);
      }
    }

    // Ý định TRƯỚC lời gọi (ADR-08 quy tắc 1)
    for (const row of live) {
      if (row.status !== "DELETING")
        await ledger.markDeleting(row.idempotencyKey);
    }
    await kit.fenceOf(run).assert();
    const result = await adapter.teardown(credential, resources);
    if (result.status !== "SUCCESS" || result.data === undefined) {
      throw new Error(`teardown không chạy được: ${String(result.message)}`);
    }
    const failed = new Set(result.data.failed);
    for (const row of live) {
      const id = idOfRow.get(row.idempotencyKey) ?? null;
      if (id !== null && failed.has(id)) {
        await ledger.markOrphanSuspected(
          row.idempotencyKey,
          "teardown không xoá được hoặc chờ biến mất quá hạn",
        );
      } else {
        await ledger.markDeleted(row.idempotencyKey);
      }
    }
    return {
      failed: [...failed],
      domainFailures,
      pendingOrphans: pendingOrphans.map((r) => r.idempotencyKey),
    };
  }

  async function finish(
    run: Run,
    input: JobInput,
    outcome: SweepOutcome | { error: string },
  ): Promise<void> {
    const clean =
      !("error" in outcome) &&
      outcome.failed.length === 0 &&
      outcome.pendingOrphans.length === 0;
    await kit.advance(run, {
      state: clean ? "DONE" : "COMPENSATION_FAILED",
      release: true,
      ...(clean
        ? {}
        : {
            lastError: redact({
              step: "TEARDOWN",
              message:
                "error" in outcome
                  ? outcome.error
                  : "còn tài nguyên chưa dọn được trên cloud",
              orphans:
                "error" in outcome
                  ? []
                  : [...outcome.failed, ...outcome.pendingOrphans],
              domainTeardownFailures:
                "error" in outcome ? [] : outcome.domainFailures,
              at: new Date().toISOString(),
            }),
          }),
      effects: async (tx) => {
        // Project giữ DELETED (§2.3 không hard-delete); cluster không còn để trỏ vào
        await tx.project.update({
          where: { id: input.projectId },
          data: { clusterAccess: Prisma.DbNull },
        });
      },
    });
  }

  return {
    run: (jobId) =>
      kit.withLease(jobId, async (run) => {
        const input = await kit.load(jobId);
        if ((await currentState(prisma, jobId)) === "QUEUED") {
          await kit.advance(run, { state: "COMPENSATING" });
        }
        let outcome: SweepOutcome;
        try {
          outcome = await kit.withCredential(input.projectId, (credential) =>
            sweep(run, input, credential),
          );
        } catch (e) {
          // Credential bị từ chối: không có cách nào dọn — nói ra, không thử lại vô ích
          if (!(e instanceof PhaseFailedError)) throw e;
          await finish(run, input, { error: e.message });
          return;
        }
        await finish(run, input, outcome);
      }),
  };
}
