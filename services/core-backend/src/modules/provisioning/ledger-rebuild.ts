import type { CloudAdapter, ProvisionedResourceRow } from "@udp/adapter-core";
import type { ResolvedCredential } from "@udp/adapter-core";
import type { PrismaClient } from "@udp/db";
import { providerToDb } from "./provider-codec.js";

/**
 * [v4.10] Dựng lại sổ tài nguyên TỪ CLOUD (§4.5 điểm crash K10, ADR-08 quy tắc 2).
 *
 * Mệnh đề bác bỏ được của ADR-08: *"Xóa sạch bảng `ProvisionedResource` giữa lúc đang
 * provisioning, hệ thống vẫn hội tụ đúng. Xóa state file của Terraform, nó mù."* File
 * này là đường ghi làm mệnh đề đó thành sự thật chạy được, không phải một lời hứa.
 *
 * **`job_id` là cột DUY NHẤT không suy được từ tag**, và đó là lý do "mất sạch sổ" có hai
 * nghĩa khác nhau:
 *
 *  - **K10a** — mất `provisioned_resources`, job cũ còn: nối lại vào job đó. Lịch sử
 *    nguyên vẹn.
 *  - **K10b** — mất cả `provisioning_jobs`: không có job nào để nối. Phải tạo một job
 *    **tổng hợp**, và nó mang **đánh dấu tường minh** trong `payload`. Lý do đánh dấu:
 *    nếu job tổng hợp trông y như một job thật thì lịch sử không "mất" mà bị **bịa** —
 *    người đọc sổ sau này thấy 13 tài nguyên thuộc một job chưa từng chạy, và không có
 *    gì trong dữ liệu nói rằng đó là suy đoán. Mất một cách nhìn thấy được thì còn sửa
 *    được; mất một cách im lặng thì không.
 */

/** Khoá đánh dấu trong `payload` của job tổng hợp — `reasonOf` của lịch sử job */
export const SYNTHETIC_JOB_MARKER = "udpSyntheticRebuild";

export interface RebuildOptions {
  prisma: PrismaClient;
  adapter: CloudAdapter;
  credential: ResolvedCredential;
  projectId: string;
  /** Job để nối vào (K10a). Bỏ trống thì tạo job tổng hợp có đánh dấu (K10b) */
  jobId?: string;
}

export interface RebuildResult {
  jobId: string;
  /** `true` khi job này là job tổng hợp vừa được tạo — K10b */
  synthetic: boolean;
  rows: readonly ProvisionedResourceRow[];
  /** Số hàng thực sự ghi được; khác `rows.length` khi có hàng đã tồn tại */
  inserted: number;
  /**
   * Tài nguyên mang `udp.project` mà KHÔNG dựng được thành hàng sổ.
   *
   * Chúng phải đi ra ngoài, không được nuốt. `udp.key` sai hình hay `udp.managed` khác
   * `"true"` nghĩa là ta không biết tài nguyên này là gì — và đoán một `idempotency_key`
   * cho nó là bịa. Nhưng bỏ qua nó thì nó là tài nguyên đang tiêu tiền mà không ai biết,
   * tức đúng thứ `GET /admin/orphan-resources` tồn tại để hiện (§4.4 lớp 4).
   */
  unmatched: readonly { id: string; kind: string }[];
}

/**
 * Tạo job tổng hợp cho K10b.
 *
 * `state` đặt là `COMPENSATING`: job này KHÔNG đang chạy (không có worker nào giữ nó) và
 * cũng chưa xong. `idx_one_active_job_per_project` chỉ loại trừ `DONE`, `FAILED` và
 * `COMPENSATION_FAILED`, nên một job tổng hợp ở `COMPENSATING` vẫn chiếm ô "job đang
 * hoạt động" của project — đúng như phải thế: sau K10b thì project ĐANG ở trạng thái cần
 * người xử lý, và cho phép bấm Provision lần nữa lúc đó là cách tạo cluster thứ hai.
 */
async function createSyntheticJob(
  prisma: PrismaClient,
  projectId: string,
  reason: string,
): Promise<string> {
  const job = await prisma.provisioningJob.create({
    data: {
      projectId,
      jobType: "PROVISION",
      state: "COMPENSATING",
      payload: {
        [SYNTHETIC_JOB_MARKER]: {
          reason,
          rebuiltAt: new Date().toISOString(),
        },
      },
    },
    select: { id: true },
  });
  return job.id;
}

/**
 * Dựng lại sổ từ cloud và GHI xuống Postgres.
 *
 * `createMany` với `skipDuplicates`: một lượt dựng lại chạy hai lần phải không sao. Đây
 * không phải sự lười — `rebuildLedgerFromCloud` là thứ được gọi SAU một lần crash, nên
 * chính nó cũng có thể crash giữa đường, và lượt sau phải tiếp được. `idempotency_key
 * UNIQUE` là thứ làm điều đó an toàn, và `skipDuplicates` là cách dùng nó.
 */
export async function rebuildLedger(
  options: RebuildOptions,
): Promise<RebuildResult> {
  const { prisma, adapter, credential, projectId } = options;

  const result = await adapter.rebuildLedgerFromCloud(credential, projectId);
  if (result.status !== "SUCCESS" || result.data === undefined) {
    throw new Error(
      `dựng lại sổ từ cloud thất bại: ${result.message ?? result.status}`,
    );
  }
  const { rows, unmatched } = result.data;

  const synthetic = options.jobId === undefined;
  const jobId =
    options.jobId ??
    (await createSyntheticJob(
      prisma,
      projectId,
      "bảng provisioning_jobs mất, sổ dựng lại từ tag trên cloud (K10b)",
    ));

  const { count } = await prisma.provisionedResource.createMany({
    data: rows.map((r) => ({
      jobId,
      projectId: r.projectId,
      step: r.step,
      kind: r.kind,
      idempotencyKey: r.idempotencyKey,
      providerId: r.providerId,
      provider: providerToDb(r.provider),
      status: r.status,
      region: r.region,
    })),
    skipDuplicates: true,
  });

  return {
    jobId,
    synthetic,
    rows,
    inserted: count,
    unmatched: unmatched.map((r) => ({ id: r.id, kind: r.kind })),
  };
}
