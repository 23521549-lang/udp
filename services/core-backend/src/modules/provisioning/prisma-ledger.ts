import {
  allowedSourcesOf,
  LedgerMissingRowError,
  LedgerTransitionError,
  type ProvisionedResourceRow,
  type ResourceStatus,
} from "@udp/adapter-core";
import type { Ledger, LedgerIntent } from "@udp/adapter-core/runner";
import {
  Prisma,
  type CloudProvider as DbCloudProvider,
  type PrismaClient,
} from "@udp/db";
import { providerFromDb, providerToDb } from "./provider-codec.js";

/**
 * [v4.10] Hiện thực Postgres của cổng `Ledger` (§4.5, ADR-08 quy tắc 1).
 *
 * Nó là hiện thực THỨ HAI. Bản thứ nhất (`InMemoryLedger`) chạy 91 ô của lưới khôi phục
 * tầng 1 mà không cần database, và toàn bộ giá trị chứng minh của 91 ô đó phụ thuộc vào
 * một điều kiện: hai hiện thực cùng ngữ nghĩa. Nếu chúng lệch, 91 ô vẫn xanh nhưng đang
 * chứng minh một thứ khác, và **không ô nào đỏ**. Vì vậy cả hai đi qua cùng một
 * `LEDGER_CONTRACT_CHECKS`, và đó là cổng của P9 chứ không phải một test thêm cho đẹp.
 *
 * Ba quyết định đáng nói:
 *
 * **1. Máy trạng thái cưỡng chế bằng MỘT câu `UPDATE ... WHERE status IN (...)`.**
 * Đọc-rồi-ghi ("lấy hàng, kiểm trạng thái, rồi update") để hở đúng khe mà điểm crash K9
 * nói tới: worker cũ đọc thấy `CREATING`, worker mới đổi sang `CREATED`, worker cũ ghi
 * đè. Một câu thì Postgres khoá hàng và khe đó không tồn tại. Danh sách `IN` **suy từ**
 * `LEDGER_TRANSITIONS` qua `allowedSourcesOf` — viết tay là để một cạnh mới của §4.5 bị
 * bỏ sót âm thầm.
 *
 * **2. `job_id` là tham số của HIỆN THỰC, không phải của `LedgerIntent`.**
 * Nó hằng trong suốt một lượt provision (một job tạo cả 13 hàng), nên đưa vào mỗi
 * `intend` là lặp cùng một giá trị 13 lần và mở ra một trạng thái vô nghĩa: hai `job_id`
 * khác nhau trong cùng một lượt. Sau một lần crash, pg-boss có thể giao lại cho worker
 * khác, nhưng vẫn là **cùng một** `ProvisioningJob.id` — nên hằng số này sống qua resume.
 *
 * **3. Lý do của trạng thái đi vào `audit_logs`, không vào một cột mới.**
 * `provisioned_resources` không có cột nào cho `reason`, và plan này không thêm
 * migration. Nhưng nuốt lý do thì §4.5 vỡ ở đúng chỗ nó nói "**không im lặng bỏ qua**":
 * `GET /admin/orphan-resources` hiện một hàng `ORPHAN_SUSPECTED` mà không nói được vì
 * sao. `audit_logs` là bảng append-only đã có, `udp_s1` có INSERT, và nó có sẵn index
 * `(target_type, target_id, occurred_at DESC)` — đúng câu hỏi "lịch sử của đối tượng
 * này". Hai lần ghi nằm trong **cùng một transaction**: tách ra là để một lần crash ở
 * giữa sinh ra đúng cái hàng không có lý do mà ta đang tránh.
 */

/** `target_type` của hàng audit mang lý do — hằng, vì `reasonOf` phải tìm lại được */
export const LEDGER_AUDIT_TARGET_TYPE = "provisioned_resource";

/** `action` của hàng audit mang lý do, một mã cho mỗi trạng thái cần giải thích */
export const LEDGER_AUDIT_ACTIONS: Readonly<Partial<Record<ResourceStatus, string>>> =
  {
    ORPHAN_SUSPECTED: "RESOURCE_ORPHAN_SUSPECTED",
    CREATING: "RESOURCE_RECREATING",
  };

export interface PrismaLedgerOptions {
  prisma: PrismaClient;
  /** `ProvisioningJob.id` của lượt provision này — xem quyết định 2 ở chú thích trên */
  jobId: string;
}

/** Hình của `after` trên hàng audit: lý do đi KÈM trạng thái mà nó giải thích */
interface ReasonNote {
  status: ResourceStatus;
  reason: string;
}

const ROW_SELECT = {
  id: true,
  projectId: true,
  step: true,
  kind: true,
  idempotencyKey: true,
  providerId: true,
  provider: true,
  region: true,
  status: true,
} as const;

type SelectedRow = {
  id: string;
  projectId: string;
  step: ProvisionedResourceRow["step"];
  kind: string;
  idempotencyKey: string;
  providerId: string | null;
  provider: DbCloudProvider;
  region: string;
  status: ResourceStatus;
};

function toRow(row: SelectedRow): ProvisionedResourceRow {
  return {
    projectId: row.projectId,
    step: row.step,
    kind: row.kind as ProvisionedResourceRow["kind"],
    idempotencyKey: row.idempotencyKey,
    providerId: row.providerId,
    provider: providerFromDb(row.provider),
    region: row.region,
    status: row.status,
  };
}

export function createPrismaLedger(options: PrismaLedgerOptions): Ledger {
  const { prisma, jobId } = options;

  /**
   * Một lần đổi trạng thái, cưỡng chế bằng chính câu `UPDATE`.
   *
   * `count === 0` có đúng hai nguyên nhân, và phân biệt chúng là việc phải làm: không có
   * hàng là lỗi của người gọi (`mark*` trên khoá chưa `intend`), còn có hàng mà sai
   * trạng thái là một cạnh không tồn tại trong §4.5. Trả về cùng một lỗi cho hai ca đó
   * làm người đọc log đi sai hướng ngay từ dòng đầu.
   */
  async function transition(
    idempotencyKey: string,
    to: ResourceStatus,
    extra: Prisma.ProvisionedResourceUpdateManyMutationInput = {},
  ): Promise<void> {
    const { count } = await prisma.provisionedResource.updateMany({
      where: { idempotencyKey, status: { in: [...allowedSourcesOf(to)] } },
      data: { status: to, ...extra },
    });
    if (count === 1) return;
    await raiseTransitionFailure(idempotencyKey, to);
  }

  /** Vì sao câu `UPDATE` không đổi hàng nào — đọc SAU khi đã biết nó thất bại */
  async function raiseTransitionFailure(
    idempotencyKey: string,
    to: ResourceStatus,
  ): Promise<never> {
    const row = await prisma.provisionedResource.findUnique({
      where: { idempotencyKey },
      select: { status: true },
    });
    if (row === null) throw new LedgerMissingRowError(idempotencyKey);
    throw new LedgerTransitionError(idempotencyKey, row.status, to);
  }

  /**
   * Đổi trạng thái VÀ ghi lý do, trong cùng một transaction.
   *
   * Thứ tự bên trong không quan trọng vì cả hai cùng commit hoặc cùng không; điều quan
   * trọng là không có trạng thái trung gian nào quan sát được, nên không có hàng
   * `ORPHAN_SUSPECTED` nào tồn tại mà chưa có lý do.
   */
  async function transitionWithReason(
    idempotencyKey: string,
    to: ResourceStatus,
    reason: string,
    extra: Prisma.ProvisionedResourceUpdateManyMutationInput = {},
  ): Promise<void> {
    const action = LEDGER_AUDIT_ACTIONS[to];
    if (action === undefined) {
      throw new Error(`trạng thái ${to} không có mã audit cho lý do`);
    }
    const note: ReasonNote = { status: to, reason };
    const failed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.provisionedResource.updateMany({
        where: { idempotencyKey, status: { in: [...allowedSourcesOf(to)] } },
        data: { status: to, ...extra },
      });
      if (count !== 1) return true;
      const row = await tx.provisionedResource.findUniqueOrThrow({
        where: { idempotencyKey },
        select: { id: true, projectId: true },
      });
      await tx.auditLog.create({
        data: {
          projectId: row.projectId,
          actorType: "SYSTEM",
          action,
          targetType: LEDGER_AUDIT_TARGET_TYPE,
          targetId: row.id,
          after: note as unknown as Prisma.InputJsonValue,
        },
      });
      return false;
    });
    if (failed) await raiseTransitionFailure(idempotencyKey, to);
  }

  return {
    /**
     * `ABSENT → CREATING`, và **idempotent khi hàng đã ở `CREATING`**.
     *
     * Viết trước rồi xử lý `P2002`, không "kiểm rồi ghi": `idempotency_key UNIQUE` là
     * lớp chặn thứ hai của §4.5 sau `lookup()`, và nó chỉ thật khi đường ghi để nó nói.
     * Một lần kiểm trước chỉ dịch cửa sổ chứ không đóng nó, và làm cho lớp chặn thứ hai
     * không bao giờ được thực thi — tức không bao giờ được kiểm.
     */
    async intend(intent: LedgerIntent): Promise<void> {
      /**
       * `INSERT ... ON CONFLICT DO NOTHING`, không phải "kiểm rồi ghi".
       *
       * `idempotency_key UNIQUE` là lớp chặn thứ hai của §4.5 sau `lookup()`, và nó chỉ
       * thật khi đường ghi để nó nói. Một lần kiểm trước chỉ dịch cửa sổ chứ không đóng
       * nó, và làm cho lớp chặn thứ hai không bao giờ được thực thi — tức không bao giờ
       * được kiểm.
       *
       * `skipDuplicates` thay vì bắt `P2002`: cùng một câu SQL, cùng một bảo đảm, nhưng
       * KHÔNG sinh một dòng `prisma:error` cho một đường đi **bình thường**. Mỗi lượt
       * resume sau crash đều đi qua đây, nên bắt ngoại lệ ở đây nghĩa là mọi lần khôi
       * phục thành công đều in một lỗi — và 40 ô của lưới tầng 2 in 40 lỗi giả, đủ để
       * một lỗi thật lẫn vào mà không ai thấy.
       */
      const { count } = await prisma.provisionedResource.createMany({
        data: [
          {
            jobId,
            projectId: intent.projectId,
            step: intent.step,
            kind: intent.kind,
            idempotencyKey: intent.idempotencyKey,
            provider: providerToDb(intent.provider),
            region: intent.region,
            status: "CREATING",
          },
        ],
        skipDuplicates: true,
      });
      if (count === 1) return;

      /** Đã có hàng: chỉ `CREATING` là hợp lệ (K2/K3 resume), còn lại là lỗi thật */
      const existing = await prisma.provisionedResource.findUnique({
        where: { idempotencyKey: intent.idempotencyKey },
        select: { status: true },
      });
      if (existing === null) {
        throw new LedgerMissingRowError(intent.idempotencyKey);
      }
      if (existing.status === "CREATING") return;
      throw new LedgerTransitionError(
        intent.idempotencyKey,
        existing.status,
        "CREATING",
      );
    },

    markCreated(idempotencyKey: string, providerId: string): Promise<void> {
      return transition(idempotencyKey, "CREATED", { providerId });
    },

    markReady(idempotencyKey: string): Promise<void> {
      return transition(idempotencyKey, "READY");
    },

    markDeleting(idempotencyKey: string): Promise<void> {
      return transition(idempotencyKey, "DELETING");
    },

    markDeleted(idempotencyKey: string): Promise<void> {
      return transition(idempotencyKey, "DELETED");
    },

    markOrphanSuspected(idempotencyKey: string, reason: string): Promise<void> {
      return transitionWithReason(idempotencyKey, "ORPHAN_SUSPECTED", reason);
    },

    /** Hàng K7 — `provider_id` bị XOÁ cùng lúc, xem cổng `Ledger` */
    markRecreating(idempotencyKey: string, reason: string): Promise<void> {
      return transitionWithReason(idempotencyKey, "CREATING", reason, {
        providerId: null,
      });
    },

    async byKey(
      idempotencyKey: string,
    ): Promise<ProvisionedResourceRow | null> {
      const row = await prisma.provisionedResource.findUnique({
        where: { idempotencyKey },
        select: ROW_SELECT,
      });
      return row === null ? null : toRow(row);
    },

    /**
     * Theo thứ tự chèn.
     *
     * `created_at` là `TIMESTAMPTZ(3)`, nên hai hàng chèn trong cùng một milli giây có
     * thứ tự không xác định — và `id` là UUIDv7, sinh theo thời gian, nên nó vừa phá thế
     * ngang bằng vừa giữ đúng chiều. Vì sao thế ngang bằng gần như không xảy ra ở đây:
     * người ghi là MỘT worker chạy tuần tự, mỗi lần ghi là một lượt đi về database
     * (~50 ms đã đo ở R24-10), nên 13 hàng của một lượt không thể chung một milli giây.
     * Hai worker ghi song song vào cùng project là một lần mất lease, và fencing chặn
     * chuyện đó trước khi nó tới đây.
     *
     * Thứ tự này là **gợi ý** (§4.5): compensation lấy thứ tự từ danh sách `steps` chứ
     * không từ sổ (RUN8). Nó vẫn nằm trong hợp đồng để hai hiện thực không lệch nhau về
     * một thứ mà người đọc sổ sẽ tin.
     */
    async rowsOf(projectId: string): Promise<ProvisionedResourceRow[]> {
      const rows = await prisma.provisionedResource.findMany({
        where: { projectId },
        select: ROW_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      return rows.map(toRow);
    },

    /**
     * Lý do của TRẠNG THÁI HIỆN TẠI.
     *
     * Đọc hàng audit mới nhất của tài nguyên này rồi so `after.status` với trạng thái
     * đang có. `audit_logs` là append-only nên không có cách xoá lý do cũ; phép so này
     * là cách giữ đúng ngữ nghĩa mà không cần xoá. Thứ tự có HAI khoá vì nhiều hàng
     * audit ghi trong cùng một transaction chia sẻ đúng một `occurred_at`
     * (`CURRENT_TIMESTAMP` là thời điểm mở transaction).
     */
    async reasonOf(idempotencyKey: string): Promise<string | null> {
      const row = await prisma.provisionedResource.findUnique({
        where: { idempotencyKey },
        select: { id: true, status: true },
      });
      if (row === null) return null;
      const audit = await prisma.auditLog.findFirst({
        where: {
          targetType: LEDGER_AUDIT_TARGET_TYPE,
          targetId: row.id,
          action: { in: Object.values(LEDGER_AUDIT_ACTIONS) },
        },
        select: { after: true },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      });
      const note = audit?.after as ReasonNote | null | undefined;
      if (note == null || note.status !== row.status) return null;
      return note.reason;
    },
  };
}
