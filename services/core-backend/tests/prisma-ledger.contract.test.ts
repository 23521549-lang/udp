import { randomUUID } from "node:crypto";
import {
  CONTRACT_PROJECT,
  CONTRACT_PROJECT_OTHER,
  runLedgerContract,
} from "@udp/adapter-core/contract";
import type { Ledger } from "@udp/adapter-core/runner";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import {
  createPrismaLedger,
  LEDGER_AUDIT_TARGET_TYPE,
} from "../src/modules/provisioning/prisma-ledger.js";

/**
 * [v4.10] Cổng P9 — `PrismaLedger` đi qua CÙNG bộ hợp đồng với `InMemoryLedger`.
 *
 * Vì sao đây là một cổng chứ không phải một test thêm: lưới khôi phục tầng 1 có 91 ô,
 * tất cả chạy trên `InMemoryLedger`, và giá trị chứng minh của cả 91 ô phụ thuộc vào
 * một điều kiện duy nhất — hai hiện thực cùng ngữ nghĩa. Nếu chúng lệch, **không ô nào
 * đỏ**: 91 ô vẫn xanh, chỉ là chúng đang chứng minh một tính chất của một cái sổ không
 * ai dùng trong sản phẩm.
 *
 * Sổ ở đây nối bằng **`udp_s1`**, không phải owner. Đó là chủ ý: ma trận writer §1.2 nói
 * Service 1 ghi `provisioned_resources` và `audit_logs`, và một bộ hợp đồng chạy bằng
 * owner sẽ xanh kể cả khi GRANT thiếu — tức nó không kiểm được điều mà §1.2 hứa.
 *
 * **Một project, một job, xoá hàng giữa các phép.** Bộ hợp đồng đòi một sổ RỖNG cho mỗi
 * phép, và cách hiển nhiên — một `ProvisioningJob` mới cho mỗi phép — KHÔNG chạy
 * được: `idx_one_active_job_per_project` là unique index một phần cho phép đúng MỘT job
 * chưa kết thúc trên mỗi project (ADR-02: chặn bấm Provision hai lần thành hai cluster
 * trên tài khoản BYOC). Phản ứng đúng không phải là lách nó bằng `state = 'DONE'`, mà là
 * nhận lấy hình thật: một lượt provision là một job tạo cả 13 hàng. Nên có đúng một
 * job, và `freshLedger` xoá hàng tài nguyên giữa các phép.
 */

const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_ledger_contract_admin",
});

/**
 * Hai project của bộ hợp đồng — hằng số **nhập từ** `./contract`, không chép lại.
 *
 * Chép lại hai UUID này là cách môi trường và bộ hợp đồng trôi khỏi nhau một cách
 * im lặng: hợp đồng đọc project A trong khi môi trường dựng project B, và mọi phép
 * đỏ với một lỗi khoá ngoại thay vì một lỗi ngụ nghĩa.
 */
const PROJECTS = [CONTRACT_PROJECT, CONTRACT_PROJECT_OTHER];

let jobId = "";

/**
 * Dọn mọi dấu vết của project hợp đồng.
 *
 * Chạy bằng `admin` vì nó phải xoá được cả `audit_logs` (append-only với `udp_s1`, và
 * đúng như vậy: một đường xoá audit trong mã sản phẩm là một lỗ hổng, nên đường dọn của
 * test phải đi bằng danh tính khác).
 */
async function wipe(): Promise<void> {
  const rows = await admin.provisionedResource.findMany({
    where: { projectId: { in: PROJECTS } },
    select: { id: true },
  });
  if (rows.length > 0) {
    await admin.auditLog.deleteMany({
      where: {
        targetType: LEDGER_AUDIT_TARGET_TYPE,
        targetId: { in: rows.map((r) => r.id) },
      },
    });
  }
  await admin.provisionedResource.deleteMany({
    where: { projectId: { in: PROJECTS } },
  });
}

beforeAll(async () => {
  const owner = await stableOwner(admin);
  await wipe();
  await admin.provisioningJob.deleteMany({
    where: { projectId: { in: PROJECTS } },
  });
  await admin.project.deleteMany({ where: { id: { in: PROJECTS } } });
  await admin.project.createMany({
    data: PROJECTS.map((id, i) => ({
      id,
      ownerId: owner.id,
      name: `hop dong so P9 ${String(i + 1)}`,
      creationMode: "CREATE_NEW" as const,
      languageRuntime: "node20",
      resourceQuota: {},
    })),
  });
  const job = await admin.provisioningJob.create({
    data: {
      id: randomUUID(),
      projectId: CONTRACT_PROJECT,
      jobType: "PROVISION",
      payload: {},
    },
    select: { id: true },
  });
  jobId = job.id;
});

afterAll(async () => {
  await wipe();
  await admin.provisioningJob.deleteMany({
    where: { projectId: { in: PROJECTS } },
  });
  await admin.project.deleteMany({ where: { id: { in: PROJECTS } } });
  await admin.$disconnect();
});

/** Một sổ rỗng cho mỗi phép kiểm — xem ghi chú đầu tệp về vì sao chỉ một job */
async function freshLedger(): Promise<Ledger> {
  await wipe();
  return createPrismaLedger({ prisma: s1, jobId });
}

runLedgerContract({ describe, it }, "PrismaLedger (udp_s1)", freshLedger);

/**
 * Hai tính chất KHÔNG nằm trong bộ hợp đồng vì chúng chỉ có nghĩa với sổ bền.
 *
 * Bộ hợp đồng phát biểu ngữ nghĩa dùng chung; những thứ dưới đây là về lớp chặn của
 * database, và `InMemoryLedger` không có chúng để mà kiểm.
 */
describe("tính chất riêng của sổ bền", () => {
  it("lý do ghi vào audit_logs nằm CÙNG transaction với lần đổi trạng thái", async () => {
    const ledger = await freshLedger();
    const key = `${CONTRACT_PROJECT}:NETWORK:vpc:audit`;
    await ledger.intend({
      projectId: CONTRACT_PROJECT,
      step: "NETWORK",
      kind: "vpc",
      idempotencyKey: key,
      provider: "aws",
      region: "ap-southeast-1",
    });
    await ledger.markOrphanSuspected(key, "delete thất bại 5 lần");

    const row = await admin.provisionedResource.findUniqueOrThrow({
      where: { idempotencyKey: key },
      select: { id: true, status: true },
    });
    expect(row.status).toBe("ORPHAN_SUSPECTED");

    const audit = await admin.auditLog.findMany({
      where: { targetType: LEDGER_AUDIT_TARGET_TYPE, targetId: row.id },
      select: { action: true, actorType: true, after: true, projectId: true },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("RESOURCE_ORPHAN_SUSPECTED");
    expect(audit[0]?.actorType).toBe("SYSTEM");
    expect(audit[0]?.projectId).toBe(CONTRACT_PROJECT);
    expect(audit[0]?.after).toEqual({
      status: "ORPHAN_SUSPECTED",
      reason: "delete thất bại 5 lần",
    });
  });

  /**
   * "Cùng một transaction" phải được CƯỠNG CHẾ, không chỉ được chú thích.
   *
   * Tách hai lần ghi ra hai lời gọi rời vẫn làm MỌI phép khác xanh: cả hai lần ghi vẫn
   * xảy ra, chỉ là không còn nguyên tử. Nên tính chất này cần một phép riêng, và cách
   * duy nhất để thấy nó là làm lần ghi thứ hai VỠ rồi xem lần thứ nhất có bị cuốn theo.
   *
   * Client bị đầu độc chỉ thay ĐÚNG `auditLog.create` bên trong `tx`: mọi thứ khác là
   * client thật, nên nếu phép này xanh thì nó xanh vì Postgres đã rollback thật, không
   * vì một bản giả lập của transaction.
   */
  it("audit ghi vỡ thì lần đổi trạng thái CŨNG bị cuốn theo", async () => {
    const ledger = await freshLedger();
    const key = `${CONTRACT_PROJECT}:NETWORK:vpc:atomic`;
    await ledger.intend({
      projectId: CONTRACT_PROJECT,
      step: "NETWORK",
      kind: "vpc",
      idempotencyKey: key,
      provider: "aws",
      region: "ap-southeast-1",
    });

    const poisoned = {
      ...s1,
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        s1.$transaction((tx) =>
          fn({
            ...tx,
            auditLog: {
              create: () => Promise.reject(new Error("audit vỡ cố ý")),
            },
          }),
        ),
    } as unknown as PrismaClient;

    const brittle = createPrismaLedger({ prisma: poisoned, jobId });
    await expect(brittle.markOrphanSuspected(key, "lý do")).rejects.toThrow(
      "audit vỡ cố ý",
    );

    /** Trạng thái phải KHÔNG đổi — không có hàng ORPHAN_SUSPECTED nào thiếu lý do */
    const row = await admin.provisionedResource.findUniqueOrThrow({
      where: { idempotencyKey: key },
      select: { id: true, status: true },
    });
    expect(row.status).toBe("CREATING");
    const audit = await admin.auditLog.count({
      where: { targetType: LEDGER_AUDIT_TARGET_TYPE, targetId: row.id },
    });
    expect(audit).toBe(0);
  });

  /**
   * `idempotency_key UNIQUE` là lớp chặn THỨ HAI của §4.5, sau `lookup()`.
   *
   * Nó chỉ thật khi đường ghi để nó nói — tức `intend` phải INSERT rồi xử lý `P2002`,
   * không phải "đọc xem có chưa rồi mới ghi". Phép này ghi hai hàng cho cùng một khoá
   * bằng `admin` (bỏ qua mọi logic của sổ) và khẳng định database từ chối.
   */
  it("database từ chối hàng thứ hai cho cùng một idempotency_key", async () => {
    const ledger = await freshLedger();
    const key = `${CONTRACT_PROJECT}:NETWORK:vpc:unique`;
    await ledger.intend({
      projectId: CONTRACT_PROJECT,
      step: "NETWORK",
      kind: "vpc",
      idempotencyKey: key,
      provider: "aws",
      region: "ap-southeast-1",
    });
    await expect(
      admin.provisionedResource.create({
        data: {
          jobId,
          projectId: CONTRACT_PROJECT,
          step: "NETWORK",
          kind: "vpc",
          idempotencyKey: key,
          provider: "AWS",
          region: "ap-southeast-1",
        },
      }),
    ).rejects.toThrow();
  });
});
