import type { ProvisionedResourceRow } from "../ledger.js";
import { isLedgerTransitionAllowed } from "../ledger.js";
import type { Ledger, LedgerIntent } from "../runner/index.js";

/**
 * [v4.10] Sổ tài nguyên trong bộ nhớ — hiện thực thứ nhất của cổng `Ledger`.
 *
 * Nó tồn tại để **lưới khôi phục 130 ô chạy được mà không cần database**: mỗi ô dựng
 * lại sổ, và 130 ô × 13 step × ~3 lượt ghi qua một database ở Singapore (RTT đo được
 * 50,2 ms) là ngân sách thời gian mà không ai giữ được, và hình thức thoái cấp sẽ là
 * bỏ ô.
 *
 * Nhưng một hiện thực thứ hai là một nguồn lệch ngữ nghĩa: nếu bản này dễ tính hơn bản
 * Postgres thì 129/130 ô của tầng 1 mất giá trị chứng minh. Vì vậy **cả hai** hiện thực
 * chạy qua cùng một `LEDGER_CONTRACT_CHECKS`, và tầng 2 của lưới vẫn cho mỗi điểm crash
 * ít nhất một lượt trên sổ thật.
 *
 * `Map` giữ thứ tự chèn theo đặc tả của JavaScript, và `rowsOf` dựa vào đúng tính chất
 * đó: compensation chạy **ngược** danh sách này, vì ADR-08 nói thứ tự compensation không
 * nằm trong sổ mà suy từ thứ tự đã ghi.
 */
export class LedgerTransitionError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(
      `Sổ từ chối chuyển ${from} → ${to} cho ${idempotencyKey}: cạnh này không có trong máy trạng thái §4.5`,
    );
    this.name = "LedgerTransitionError";
  }
}

export class LedgerMissingRowError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Sổ không có hàng ${idempotencyKey}`);
    this.name = "LedgerMissingRowError";
  }
}

export class InMemoryLedger implements Ledger {
  readonly #rows = new Map<string, ProvisionedResourceRow>();
  /** Lý do của `ORPHAN_SUSPECTED`, để test khẳng định nó không bị nuốt */
  readonly #orphanReasons = new Map<string, string>();
  /** Lý do của lần tạo lại, để test khẳng định chứng minh "không còn" được ghi */
  readonly #recreateReasons = new Map<string, string>();

  /**
   * `ABSENT → CREATING`, và **idempotent khi hàng đã ở `CREATING`**.
   *
   * Tính chất thứ hai không phải tiện lợi mà là hợp đồng: sau một lần crash ở K2 hay K3,
   * hàng đã ở `CREATING` và runner gọi lại `intend` trên đúng khoá đó. Nếu `intend` ném
   * thì resume không chạy được, và cả hai ô đó đỏ vì lý do sai.
   *
   * Hàng ở trạng thái KHÁC thì ném: gọi `intend` trên một hàng `READY` nghĩa là ai đó
   * đang tạo lại thứ đã tồn tại, và đó là lỗi cần thấy.
   */
  intend(intent: LedgerIntent): Promise<void> {
    const existing = this.#rows.get(intent.idempotencyKey);
    if (existing !== undefined) {
      if (existing.status === "CREATING") return Promise.resolve();
      throw new LedgerTransitionError(
        intent.idempotencyKey,
        existing.status,
        "CREATING",
      );
    }
    this.#rows.set(intent.idempotencyKey, {
      projectId: intent.projectId,
      step: intent.step,
      kind: intent.kind,
      idempotencyKey: intent.idempotencyKey,
      providerId: null,
      provider: intent.provider,
      region: intent.region,
      status: "CREATING",
    });
    return Promise.resolve();
  }

  markCreated(idempotencyKey: string, providerId: string): Promise<void> {
    const row = this.#require(idempotencyKey);
    this.#transition(row, "CREATED");
    row.providerId = providerId;
    return Promise.resolve();
  }

  /** `READY | CREATED → CREATING` và xoá `provider_id` (hàng K7 — xem cổng `Ledger`) */
  markRecreating(idempotencyKey: string, reason: string): Promise<void> {
    const row = this.#require(idempotencyKey);
    this.#transition(row, "CREATING");
    row.providerId = null;
    this.#recreateReasons.set(idempotencyKey, reason);
    return Promise.resolve();
  }

  markReady(idempotencyKey: string): Promise<void> {
    this.#transition(this.#require(idempotencyKey), "READY");
    return Promise.resolve();
  }

  markDeleting(idempotencyKey: string): Promise<void> {
    this.#transition(this.#require(idempotencyKey), "DELETING");
    return Promise.resolve();
  }

  markDeleted(idempotencyKey: string): Promise<void> {
    this.#transition(this.#require(idempotencyKey), "DELETED");
    return Promise.resolve();
  }

  markOrphanSuspected(idempotencyKey: string, reason: string): Promise<void> {
    this.#transition(this.#require(idempotencyKey), "ORPHAN_SUSPECTED");
    this.#orphanReasons.set(idempotencyKey, reason);
    return Promise.resolve();
  }

  byKey(idempotencyKey: string): Promise<ProvisionedResourceRow | null> {
    const row = this.#rows.get(idempotencyKey);
    return Promise.resolve(row === undefined ? null : { ...row });
  }

  /** Theo thứ tự chèn; compensation chạy ngược danh sách này */
  rowsOf(projectId: string): Promise<ProvisionedResourceRow[]> {
    return Promise.resolve(
      [...this.#rows.values()]
        .filter((r) => r.projectId === projectId)
        .map((r) => ({ ...r })),
    );
  }

  /** Chỉ dùng trong test: lý do của một hàng `ORPHAN_SUSPECTED` */
  orphanReasonOf(idempotencyKey: string): string | undefined {
    return this.#orphanReasons.get(idempotencyKey);
  }

  /** Chỉ dùng trong test: lý do của lần tạo lại gần nhất */
  recreateReasonOf(idempotencyKey: string): string | undefined {
    return this.#recreateReasons.get(idempotencyKey);
  }

  #require(idempotencyKey: string): ProvisionedResourceRow {
    const row = this.#rows.get(idempotencyKey);
    if (row === undefined) throw new LedgerMissingRowError(idempotencyKey);
    return row;
  }

  #transition(
    row: ProvisionedResourceRow,
    to: ProvisionedResourceRow["status"],
  ): void {
    if (!isLedgerTransitionAllowed(row.status, to)) {
      throw new LedgerTransitionError(row.idempotencyKey, row.status, to);
    }
    row.status = to;
  }
}
