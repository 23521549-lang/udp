import { LOOKUP_INDETERMINATE } from "@udp/config/constants";
import type { CreatedResource, ResourceQuota, ResourceStep } from "../cloud.js";
import type { CloudProvider, ResolvedCredential } from "../credential.js";
import type { ProvisionStep } from "../ledger.js";
import {
  LookupIndeterminateError,
  rethrowIfFatal,
  StepFailedError,
} from "./errors.js";
import type { Fence, Ledger, RunnerObserver } from "./index.js";

/**
 * [v4.10] `CloudAdapterRunner` — lõi dùng chung chạy danh sách `ResourceStep` (ADR-07).
 *
 * Adapter KHÔNG tự chạy vòng lặp tạo tài nguyên. Nó khai báo các step; lõi này điều phối,
 * và vì nó là **một** lõi cho mọi adapter, ngữ nghĩa thất bại của §4.5 được cưỡng chế ở
 * một chỗ thay vì được hứa ở ba adapter.
 *
 * Mười bốn bất biến, mỗi cái có ít nhất một test:
 *
 * | # | Bất biến | Đóng điểm crash nào |
 * | --- | --- | --- |
 * | RUN1 | `lookup()` chạy TRƯỚC mọi `create()` | K1, K2, K3, K7 |
 * | RUN2 | Ghi sổ `CREATING` TRƯỚC `create()` | K2, K3 |
 * | RUN3 | `found` ⇒ gắn `provider_id` vào hàng ĐÃ CÓ, **không** `create()` | K3 |
 * | RUN4 | `indeterminate` ⇒ **cấm** `create()`, chờ rồi tra lại | K2b |
 * | RUN5 | Hết lượt `indeterminate` ⇒ hàng giữ `CREATING`, KHÔNG compensation | K2b |
 * | RUN6 | Chỉ `READY` là xong; `CREATED` chưa phải | K4 |
 * | RUN7 | `lookupById` là đường dự phòng khi tra theo tag không ra | K8 |
 * | RUN8 | Compensation theo thứ tự NGƯỢC của `steps`, không của sổ | K6 |
 * | RUN9 | `delete()` với thứ đã mất là THÀNH CÔNG | K6 |
 * | RUN10 | Quota kiểm TRƯỚC mọi lời gọi cloud | §4.4 lớp 1 |
 * | RUN11 | `fence.assert()` ở sáu chốt | K9 |
 * | RUN12 | `prior` chỉ chứa step ĐỨNG TRƯỚC, khoá theo `name` | hợp đồng §4.2 |
 * | RUN13 | `rethrowIfFatal` là câu lệnh đầu của mọi `catch` | mọi ô |
 * | RUN14 | Runner KHÔNG giữ state ở phạm vi module | mọi ô |
 *
 * RUN14 là bất biến quan trọng nhất và cũng vô hình nhất: nếu runner giữ bất cứ thứ gì ở
 * module scope — một cache lookup, một map `prior`, một danh sách id đã tạo — thì resume
 * thành công **nhờ bộ nhớ** chứ không nhờ sổ và tag, và toàn bộ ADR-08 không được kiểm.
 * Vì vậy mọi state sống trong `run()`, và mỗi lượt resume dựng một thực thể mới.
 */

export interface RunnerDeps {
  ledger: Ledger;
  fence: Fence;
  observer: RunnerObserver;
  /** Tiêm vào để test không phụ thuộc đồng hồ máy */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunPlan {
  projectId: string;
  provider: CloudProvider;
  region: string;
  step: ProvisionStep;
  steps: readonly ResourceStep[];
  credential: ResolvedCredential;
  quota: ResourceQuota;
  /** Số tài nguyên mà kế hoạch này sẽ tạo, để kiểm quota TRƯỚC khi gọi cloud */
  plannedNodes?: number;
  plannedLoadBalancers?: number;
}

export type RunOutcome =
  | { status: "SUCCESS"; created: Record<string, CreatedResource> }
  /** Hàng giữ `CREATING`; lượt job sau chạy lại được và hội tụ */
  | { status: "RETRYABLE"; atStep: string; reason: string }
  | { status: "QUOTA_REJECTED"; reason: string }
  | { status: "COMPENSATED"; failedStep: string; reason: string }
  | {
      status: "COMPENSATION_FAILED";
      failedStep: string;
      orphans: readonly string[];
    };

export class CloudAdapterRunner {
  readonly #ledger: Ledger;
  readonly #fence: Fence;
  readonly #observer: RunnerObserver;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(deps: RunnerDeps) {
    this.#ledger = deps.ledger;
    this.#fence = deps.fence;
    this.#observer = deps.observer;
    this.#sleep =
      deps.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  async run(plan: RunPlan): Promise<RunOutcome> {
    /**
     * RUN10: quota kiểm TRƯỚC mọi lời gọi cloud.
     *
     * Vượt quota mà đã gọi cloud rồi mới reject nghĩa là đã tiêu tiền của khách. Phép
     * kiểm tương ứng khẳng định số lời gọi cloud = 0, không chỉ khẳng định có lỗi.
     */
    const quotaProblem = quotaRejection(plan);
    if (quotaProblem !== null) {
      return { status: "QUOTA_REJECTED", reason: quotaProblem };
    }

    // RUN14: toàn bộ state của một lượt sống ở đây, không ở phạm vi module.
    const created: Record<string, CreatedResource> = {};
    const done: ResourceStep[] = [];

    for (const step of plan.steps) {
      await this.#fence.assert(); // RUN11 (1/6)
      try {
        const resource = await this.#runStep(plan, step, created);
        created[step.name] = resource;
        done.push(step);
      } catch (err) {
        rethrowIfFatal(err); // RUN13

        /**
         * RUN5: `indeterminate` hết lượt KHÔNG dẫn tới compensation.
         *
         * Ta không biết tài nguyên có tồn tại hay không. Xoá thứ có thể không tồn tại là
         * vô hại, nhưng xoá thứ CÓ tồn tại mà sổ chưa kịp biết id thì là xoá mù — và
         * hàng ở `CREATING` là trạng thái resume được, nên đường đúng là để lượt sau tra
         * lại.
         */
        if (err instanceof LookupIndeterminateError) {
          return {
            status: "RETRYABLE",
            atStep: err.stepName,
            reason: err.message,
          };
        }

        const failedStep =
          err instanceof StepFailedError ? err.stepName : step.name;
        /**
         * Step VỪA THẤT BẠI cũng vào danh sách compensation, đứng cuối.
         *
         * Nó không nằm trong `done` vì nó chưa xong — nhưng nó CÓ THỂ đã tạo tài nguyên
         * rồi vỡ ở `waitReady`. Bỏ nó lại là rò đúng tài nguyên ta vừa tạo, và hàng sổ
         * kẹt ở `CREATED` mãi mãi. Đây là lý do v4.10 thêm hai cạnh `CREATING → DELETING`
         * và `CREATED → DELETING` vào máy trạng thái §4.5: compensation một hàng chưa
         * `READY` là ca thường xuyên nhất sau một lần vỡ, và bản v4.9 không cho phép nó.
         */
        return await this.#compensate(
          plan,
          [...done, step],
          failedStep,
          describe(err),
        );
      }
    }

    return { status: "SUCCESS", created };
  }

  async #runStep(
    plan: RunPlan,
    step: ResourceStep,
    created: Record<string, CreatedResource>,
  ): Promise<CreatedResource> {
    await this.#observer.onPhase("before-lookup", step.name);

    /**
     * RUN1 + RUN4: tra cứu TRƯỚC `create()`, và `indeterminate` thì chờ rồi tra lại.
     *
     * Vòng này chạy tối đa `maxAttempts` lần với backoff tuyến tính, và tổng thời gian
     * chờ bị chốt ≤ nửa lease bằng một test riêng — nếu vượt thì chính vòng chờ này tạo
     * ra điểm crash K9.
     */
    let found: CreatedResource | null = null;
    let lastIndeterminate = "";
    for (
      let attempt = 1;
      attempt <= LOOKUP_INDETERMINATE.maxAttempts;
      attempt += 1
    ) {
      const outcome = await step.lookup(plan.credential);
      if (outcome.kind === "found") {
        found = outcome.resource;
        break;
      }
      if (outcome.kind === "absent") {
        /**
         * RUN7: tra theo tag không ra thì thử đường dự phòng theo `provider_id` của sổ.
         *
         * Đây là câu trả lời cho điểm crash K8: khách xoá tag `udp.key` nhưng sổ vẫn còn
         * id. Hai đường độc lập, hỏng một vẫn còn một.
         */
        const row = await this.#ledger.byKey(step.idempotencyKey);
        if (row?.providerId != null) {
          const byId = await step.lookupById(plan.credential, row.providerId);
          if (byId.kind === "found") found = byId.resource;
          else if (byId.kind === "indeterminate") {
            lastIndeterminate = byId.reason;
            await this.#sleep(attempt * LOOKUP_INDETERMINATE.backoffStepMs);
            continue;
          }
        }
        break;
      }
      lastIndeterminate = outcome.reason;
      await this.#sleep(attempt * LOOKUP_INDETERMINATE.backoffStepMs);
    }

    if (found === null && lastIndeterminate !== "") {
      throw new LookupIndeterminateError(
        step.name,
        LOOKUP_INDETERMINATE.maxAttempts,
        lastIndeterminate,
      );
    }

    await this.#observer.onPhase("after-lookup", step.name);
    await this.#fence.assert(); // RUN11 (2/6)

    /**
     * RUN2: ghi ý định TRƯỚC khi hành động (ADR-08 quy tắc 1).
     *
     * Kể cả khi `lookup` đã thấy tài nguyên: hàng có thể chưa tồn tại (ta đang tiếp quản
     * một project ai đó tạo tay), và `intend` là idempotent trên hàng `CREATING`.
     */
    await this.#observer.onPhase("before-intend", step.name);
    /**
     * Hỏi sổ TRƯỚC khi ghi ý định.
     *
     * Sổ cưỡng chế máy trạng thái, nên `intend` trên một hàng đã `CREATED` hay `READY`
     * **ném** — và đó là hành vi đúng của sổ: nó bắt được lỗi thật "đang tạo lại thứ đã
     * tồn tại". Nhưng một lượt resume sau điểm crash K4 gặp đúng hàng `CREATED` đó một
     * cách hợp lệ, nên runner phải hỏi trước thay vì để sổ nới lỏng luật.
     *
     * Ranh giới: sổ giữ luật, runner biết mình đang ở đâu.
     */
    const existingRow = await this.#ledger.byKey(step.idempotencyKey);
    if (existingRow === null || existingRow.status === "CREATING") {
      await this.#ledger.intend({
        projectId: plan.projectId,
        step: plan.step,
        kind: step.kind,
        idempotencyKey: step.idempotencyKey,
        provider: plan.provider,
        region: plan.region,
      });
    }
    await this.#observer.onPhase("after-intend", step.name);

    let resource: CreatedResource;
    if (found !== null) {
      /** RUN3: gắn `provider_id` vào hàng ĐÃ CÓ — đây là cách K3 được đóng */
      resource = found;
    } else {
      await this.#fence.assert(); // RUN11 (3/6)
      await this.#observer.onPhase("before-create", step.name);
      try {
        /** RUN12: `prior` chỉ chứa step đứng trước, khoá theo `name` */
        resource = await step.create(plan.credential, { ...created });
      } catch (err) {
        rethrowIfFatal(err); // RUN13
        throw new StepFailedError(step.name, err);
      }
      await this.#observer.onPhase("after-create-commit", step.name);
      await this.#observer.onPhase("after-create-respond", step.name);
    }

    await this.#observer.onPhase("before-mark-created", step.name);
    const row = await this.#ledger.byKey(step.idempotencyKey);
    if (row?.status === "CREATING") {
      await this.#ledger.markCreated(step.idempotencyKey, resource.id);
    }
    await this.#observer.onPhase("after-mark-created", step.name);
    await this.#fence.assert(); // RUN11 (4/6)

    /**
     * RUN6: chỉ `READY` là xong.
     *
     * Trả sớm ở `CREATED` làm điểm crash K4 sai âm thầm: lưới vẫn xanh 9/10 ô trong khi
     * `waitReady` chưa bao giờ được gọi lại sau resume.
     */
    await this.#observer.onPhase("before-wait-ready", step.name);
    try {
      await step.waitReady(plan.credential, resource);
    } catch (err) {
      rethrowIfFatal(err); // RUN13
      throw new StepFailedError(step.name, err);
    }
    const afterWait = await this.#ledger.byKey(step.idempotencyKey);
    if (afterWait?.status === "CREATED") {
      await this.#ledger.markReady(step.idempotencyKey);
    }
    await this.#observer.onPhase("after-wait-ready", step.name);

    return resource;
  }

  /**
   * RUN8 + RUN9: compensation theo thứ tự NGƯỢC của `steps`, và `NOT_FOUND` là thành công.
   *
   * Thứ tự ngược suy từ `plan.steps`, **không** từ sổ. ADR-08 nói sổ là *gợi ý về thứ tự*
   * — nó ghi ý định, và thứ tự thật của một lần compensation là thứ tự khai báo. Đọc thứ
   * tự từ sổ nghĩa là một hàng thiếu (mất sổ, K10) làm compensation bỏ sót tài nguyên.
   */
  async #compensate(
    plan: RunPlan,
    done: readonly ResourceStep[],
    failedStep: string,
    reason: string,
  ): Promise<RunOutcome> {
    const orphans: string[] = [];

    for (const step of [...done].reverse()) {
      await this.#fence.assert(); // RUN11 (5/6)
      const row = await this.#ledger.byKey(step.idempotencyKey);
      if (row === null || row.status === "DELETED") continue;

      await this.#observer.onPhase("before-delete", step.name);
      await this.#ledger.markDeleting(step.idempotencyKey);

      try {
        const existing =
          row.providerId === null
            ? null
            : await step.lookupById(plan.credential, row.providerId);
        if (existing === null || existing.kind === "absent") {
          /** Khách đã xoá ngoài luồng (K7): coi như đã xong */
          await this.#ledger.markDeleted(step.idempotencyKey);
        } else if (existing.kind === "found") {
          await step.delete(plan.credential, existing.resource);
          await this.#ledger.markDeleted(step.idempotencyKey);
        } else {
          /** Bất định giữa compensation: không xoá mù, đánh dấu cần người xem */
          await this.#ledger.markOrphanSuspected(
            step.idempotencyKey,
            `tra cứu bất định khi teardown: ${existing.reason}`,
          );
          orphans.push(step.idempotencyKey);
        }
      } catch (err) {
        rethrowIfFatal(err); // RUN13
        await this.#ledger.markOrphanSuspected(
          step.idempotencyKey,
          `delete thất bại: ${describe(err)}`,
        );
        orphans.push(step.idempotencyKey);
      }
      await this.#observer.onPhase("after-delete", step.name);
    }

    await this.#fence.assert(); // RUN11 (6/6)
    return orphans.length === 0
      ? { status: "COMPENSATED", failedStep, reason }
      : { status: "COMPENSATION_FAILED", failedStep, orphans };
  }
}

/**
 * Kiểm quota, thuần và không chạm cloud.
 *
 * Trả về lý do nếu bị chặn, `null` nếu qua. Tách thành hàm thuần để phép kiểm "reject
 * TRƯỚC khi gọi cloud" khẳng định được bằng số lời gọi = 0, và để `estimateCost` ở P5
 * dùng lại cùng một phép so.
 */
export function quotaRejection(plan: {
  quota: ResourceQuota;
  plannedNodes?: number;
  plannedLoadBalancers?: number;
}): string | null {
  const { quota } = plan;
  if (plan.plannedNodes !== undefined && plan.plannedNodes > quota.maxNodes) {
    return `kế hoạch cần ${String(plan.plannedNodes)} node, trần của project là ${String(quota.maxNodes)}`;
  }
  if (
    plan.plannedLoadBalancers !== undefined &&
    plan.plannedLoadBalancers > quota.maxLoadBalancers
  ) {
    return `kế hoạch cần ${String(plan.plannedLoadBalancers)} load balancer, trần là ${String(quota.maxLoadBalancers)}`;
  }
  return null;
}

function describe(err: unknown): string {
  if (err instanceof StepFailedError) return describe(err.cause);
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
