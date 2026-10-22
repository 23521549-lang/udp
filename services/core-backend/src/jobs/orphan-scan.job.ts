import { STALE_CREATING_MINUTES } from "@udp/config";
import { createPrismaLedger } from "../modules/provisioning/prisma-ledger.js";
import { phaseSteps } from "../modules/provisioning/provision-plan.js";
import { TERMINAL_STATES } from "../modules/provisioning/provisioning-job.repository.js";
import { messageOf, type JobKit } from "./job-kit.js";

/**
 * Lịch `orphan-scan` (§2.2 quy trình ghi sổ, §4.4 lớp 4, Plan #29 QĐ-6).
 *
 * Hàng `CREATING` quá `STALE_CREATING_MINUTES` là chỗ điểm crash K3 để lại: cloud có thể đã
 * tạo xong mà sổ chưa kịp biết id. Lịch này tra lại theo tag (`lookup`), hay theo
 * `provider_id` nếu sổ đã có — thấy ⇒ `markCreated` (hàng có id, teardown dọn được); không
 * thấy ⇒ GIỮ NGUYÊN, vì §4.5 chỉ cho đổi trạng thái khi tra ra một sự thật, và `absent` của
 * một tag nhất quán cuối chưa phải sự thật đó. Không bao giờ xoá tài nguyên.
 *
 * Project đang có job chạy bị bỏ qua: hàng `CREATING` của nó là của worker đang giữ lease,
 * và hai bên cùng ghi một hàng là thứ fencing sinh ra để chặn.
 */

export interface OrphanSweepOutcome {
  /** Khoá idempotency đã gắn được `provider_id` */
  resolved: string[];
  /** Vẫn không tra ra — còn nằm ở `CREATING`, hiện ở trang tài nguyên mồ côi */
  unresolved: string[];
  /** Project không quét được lượt này (credential, cloud) — kèm lý do */
  skipped: { projectId: string; reason: string }[];
}

export async function sweepOrphans(
  kit: JobKit,
  options: {
    now?: () => Date;
    /** Giới hạn lượt quét vào các project này — test dùng, lịch thật quét hết */
    only?: readonly string[];
  } = {},
): Promise<OrphanSweepOutcome> {
  const now = options.now ?? (() => new Date());
  const { prisma } = kit.deps;
  const out: OrphanSweepOutcome = { resolved: [], unresolved: [], skipped: [] };
  const staleBefore = new Date(
    now().getTime() - STALE_CREATING_MINUTES * 60_000,
  );
  const stale = await prisma.provisionedResource.findMany({
    where: {
      status: "CREATING",
      updatedAt: { lt: staleBefore },
      ...(options.only === undefined
        ? {}
        : { projectId: { in: [...options.only] } }),
    },
    select: {
      projectId: true,
      jobId: true,
      idempotencyKey: true,
      providerId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const byProject = new Map<string, typeof stale>();
  for (const row of stale) {
    byProject.set(row.projectId, [
      ...(byProject.get(row.projectId) ?? []),
      row,
    ]);
  }

  for (const [projectId, rows] of byProject) {
    const busy = await prisma.provisioningJob.count({
      where: { projectId, state: { notIn: [...TERMINAL_STATES] } },
    });
    const first = rows[0];
    if (busy > 0 || first === undefined) continue;
    try {
      const input = await kit.load(first.jobId);
      await kit.withCredential(projectId, async (credential) => {
        const steps = phaseSteps(input.adapter, projectId, input.payload);
        const all = [...steps.network, ...steps.cluster];
        for (const row of rows) {
          const step = all.find((s) => s.idempotencyKey === row.idempotencyKey);
          const outcome =
            step === undefined
              ? null
              : row.providerId === null
                ? await step.lookup(credential)
                : await step.lookupById(credential, row.providerId);
          if (outcome?.kind === "found") {
            await createPrismaLedger({ prisma, jobId: row.jobId }).markCreated(
              row.idempotencyKey,
              outcome.resource.id,
            );
            out.resolved.push(row.idempotencyKey);
          } else {
            out.unresolved.push(row.idempotencyKey);
          }
        }
      });
    } catch (e) {
      out.skipped.push({ projectId, reason: messageOf(e) });
    }
  }
  return out;
}
