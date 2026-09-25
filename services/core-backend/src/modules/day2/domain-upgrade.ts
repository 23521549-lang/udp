import type {
  DomainAdapter,
  DomainAdapterContext,
  DomainToolConfig,
} from "@udp/adapter-core";
import type { CapabilityBinding } from "@udp/shared-types";
import {
  validateAndOrder,
  type ProviderPreference,
  type ResolvableAdapter,
  type ValidationErrorCode,
  type ValidationIssue,
} from "../capability/capability.resolver.js";

/**
 * [v4.10] §8.6 nhánh B - nâng cấp một domain, với bốn quy tắc của luồng thành bốn nhánh mã.
 *
 * | Quy tắc của §8.6 | Ở đâu trong tệp này |
 * | --- | --- |
 * | Nâng cấp chạy lại validator TRƯỚC khi chạm cluster | bước 2, và nó trả `422` mà không gọi adapter lần nào |
 * | Nâng cấp thất bại thì hạ về bản cũ, không để lửng lơ | bước 4-5, `rollback()` cộng trạng thái `ROLLBACK_FAILED` |
 * | `adapter_version` chỉ đổi SAU khi healthcheck xanh | bước 6, và nó cùng transaction với rebind |
 * | Rebind dùng lại đúng cơ chế CASE 3 | `persist` gọi `applyDomainChange`, `notify` gọi `notifyDependents` |
 *
 * Cộng một quy tắc thứ năm nằm ở ghi chú của §8.6, và nó là quy tắc dễ bỏ sót nhất: nâng
 * một domain cung cấp `metrics.query` hoặc `traffic.control` trong khi project có
 * `RolloutSession` đang `IN_PROGRESS` bị **từ chối 409**. Lý do không phải là sự cẩn thận
 * chung chung: §7.4 so cửa sổ metric của canary với cửa sổ trước đó, và đổi nguồn metric
 * giữa chừng làm hai cửa sổ không còn cùng một hệ quy chiếu - một quyết định rollback dựa
 * trên hai nguồn khác nhau là một quyết định không có ý nghĩa.
 *
 * **Cái gì KHÔNG ở đây:** `requireProjectRole(MAINTAINER)` và xác nhận hai bước cho
 * environment production là việc của controller (§9), cùng chỗ với mọi phép kiểm quyền
 * khác. Route `POST /projects/:id/domains/:type/upgrade` và lịch biểu `pg-boss` nằm
 * trong sổ nợ - phần QUYẾT ĐỊNH của luồng kiểm được mà không cần dựng hàng đợi, và đó là
 * cùng lý lẽ đã dùng ở P5 cho TTL và orphan-scan.
 */

export type UpgradeStatus =
  | "UPGRADED"
  | "ROLLED_BACK"
  /** Hạ về bản cũ cũng thất bại - trạng thái phải KÊU TO, xem bước 5 */
  | "ROLLBACK_FAILED"
  | "REFUSED";

export type UpgradeRefusalCode = "ROLLOUT_IN_PROGRESS" | "CAPABILITY_INVALID";

export interface UpgradeOutcome {
  status: UpgradeStatus;
  code?: UpgradeRefusalCode;
  /** Mã HTTP mà controller trả - 409, 422, hoặc 202 cho một lượt đã chạy */
  httpStatus: 202 | 409 | 422;
  message?: string;
  errors?: ValidationIssue<ValidationErrorCode>[];
  /** Binding đã đổi endpoint hoặc version - đầu vào của `notifyDependents` */
  changed?: CapabilityBinding[];
}

export interface UpgradeRequest {
  /** Adapter bản MỚI - `adapter.version` là version đích */
  target: DomainAdapter;
  /** `DomainConfig.adapter_version` đang lưu */
  fromVersion: string;
  config: DomainToolConfig;
  /** Capability mà bản CŨ provide - để dọn preference mồ côi nếu bản mới bỏ bớt */
  capabilitiesOfOldVersion: readonly string[];
  currentBindings: readonly CapabilityBinding[];
}

export interface DomainUpgradePorts {
  rolloutInProgress: () => Promise<boolean>;
  /**
   * Tập khai báo SAU nâng cấp: adapter đích đã thay bản cũ trong danh sách.
   *
   * Người gọi dựng danh sách này, vì chỉ nó biết project đang bật những tool nào. Điểm
   * quan trọng là validator chạy trên khai báo MỚI: ví dụ thật của §8.6 là nâng Prometheus
   * lên bản đổi `metrics.query` từ `2.0.0` lên `3.0.0`, việc đó phá `constraint: "^2"` của
   * Flagger, và bắt được ở đây nghĩa là người dùng thấy một thông báo thay vì thấy canary
   * analysis hỏng sau khi đã nâng xong.
   */
  declarationsAfterUpgrade: () => readonly ResolvableAdapter[];
  preferences?: () => readonly ProviderPreference[];
  contextFor: () => Promise<DomainAdapterContext>;
  /**
   * Hạ về bản cũ.
   *
   * Là một cổng chứ không phải một lời gọi `target.upgrade(...)` ngược lại, vì `target` LÀ
   * bản mới: lớp nền Helm từ chối một `fromVersion` không phải version của chính nó, và
   * nó từ chối đúng. Chỉ người gọi có trong tay instance adapter bản cũ, nên chỉ nó hạ
   * được. Trả về `status` để bước 5 biết lần hạ có thành công không.
   */
  rollback: () => Promise<{ status: string; message?: string }>;
  /** Ghi `adapter_version` MỚI cùng rebind, trong MỘT transaction (CASE 3) */
  persist: (args: {
    adapterVersion: string;
    bindings: readonly CapabilityBinding[];
    capabilitiesOfOldVersion: readonly string[];
  }) => Promise<void>;
  recordError: (message: string) => Promise<void>;
}

/**
 * Binding nào đã ĐỔI so với bản đang lưu - theo endpoint hoặc theo version.
 *
 * Một binding mới xuất hiện cũng tính là đổi: consumer nào đang chờ capability đó phải
 * nghe tin. Ngược lại, một binding y nguyên không được đưa vào danh sách thông báo: gọi
 * `onDependencyChanged` cho một thứ không đổi làm adapter áp lại release không vì lý do
 * gì, và với 16 adapter thì đó là 16 lần chạm cluster mỗi lần nâng cấp bất kỳ.
 */
export function changedBindings(
  before: readonly CapabilityBinding[],
  after: readonly CapabilityBinding[],
): CapabilityBinding[] {
  const key = (b: CapabilityBinding): string => `${b.id}|${b.providedBy}`;
  const previous = new Map(before.map((b) => [key(b), b]));
  return after.filter((b) => {
    const old = previous.get(key(b));
    if (old === undefined) return true;
    return old.endpoint !== b.endpoint || old.version !== b.version;
  });
}

export async function upgradeDomain(
  request: UpgradeRequest,
  ports: DomainUpgradePorts,
): Promise<UpgradeOutcome> {
  // ---- 1. Rollout đang chạy ⇒ 409, và chưa chạm gì cả
  if (await ports.rolloutInProgress()) {
    return {
      status: "REFUSED",
      code: "ROLLOUT_IN_PROGRESS",
      httpStatus: 409,
      message:
        "project có rollout đang chạy: nâng cấp lúc này làm cửa sổ so sánh của canary mất hệ quy chiếu",
    };
  }

  // ---- 2. Validator chạy lại trên khai báo MỚI, TRƯỚC khi chạm cluster
  const validation = validateAndOrder(
    ports.declarationsAfterUpgrade(),
    ports.preferences?.() ?? [],
  );
  if (!validation.valid) {
    return {
      status: "REFUSED",
      code: "CAPABILITY_INVALID",
      httpStatus: 422,
      message: "tổ hợp capability không còn hợp lệ với khai báo của bản mới",
      errors: validation.errors,
    };
  }

  const ctx = await ports.contextFor();

  // ---- 3. Nâng cấp
  const upgraded = await request.target.upgrade(
    ctx,
    request.config,
    request.fromVersion,
  );
  if (upgraded.status !== "SUCCESS" || upgraded.data === undefined) {
    /**
     * `upgrade` thất bại: adapter chưa chắc đã chạm gì, nhưng cũng chưa chắc là chưa.
     *
     * Nên vẫn hạ về bản cũ chứ không chỉ ghi lỗi rồi thôi: một chart áp nửa đường là đúng
     * cái "trạng thái lửng lơ" mà quy tắc thứ ba của §8.6 cấm, và `adapter_version` vẫn
     * đang trỏ bản cũ nên mọi lượt `detectDrift` sau đó sẽ so với bản cũ.
     */
    return await rollbackAfter(
      upgraded.message ??
        "upgrade trả SUCCESS mà không có binding nào - không đủ để ghi version mới",
      request,
      ports,
    );
  }

  // ---- 4. Healthcheck
  const health = await request.target.healthcheck(ctx);
  const healthy = health.status === "SUCCESS" && health.data?.healthy === true;
  if (!healthy) {
    const detail =
      health.status === "SUCCESS"
        ? (health.data?.details ?? "healthcheck trả healthy = false")
        : (health.message ?? "healthcheck thất bại mà không kèm thông điệp");
    return await rollbackAfter(detail, request, ports);
  }

  // ---- 6. Xanh: ghi version MỚI cùng rebind, rồi trả danh sách phải thông báo
  const bindings = upgraded.data;
  await ports.persist({
    adapterVersion: request.target.version,
    bindings,
    capabilitiesOfOldVersion: request.capabilitiesOfOldVersion,
  });

  return {
    status: "UPGRADED",
    httpStatus: 202,
    changed: changedBindings(request.currentBindings, bindings),
  };
}

/**
 * Bước 5 - hạ về bản cũ, và `adapter_version` KHÔNG đổi trong cả hai kết cục.
 *
 * Hai kết cục khác nhau về mức độ nghiêm trọng, nên chúng là hai `status` khác nhau chứ
 * không phải một `ERROR` chung:
 *
 *  - `ROLLED_BACK`: cluster đã về bản cũ, `adapter_version` khớp thực tế. Người dùng thấy
 *    một lần nâng cấp thất bại, và hệ thống vẫn nhất quán.
 *  - `ROLLBACK_FAILED`: cluster ở một trạng thái không ai biết. Đây là ca phải kêu to,
 *    vì `detectDrift` từ giờ so với một `adapter_version` có thể không còn đúng - và một
 *    badge "đã trôi" ở ca này là badge NÓI THẬT, không phải báo động giả.
 */
async function rollbackAfter(
  reason: string,
  request: UpgradeRequest,
  ports: DomainUpgradePorts,
): Promise<UpgradeOutcome> {
  const back = await ports.rollback();
  if (back.status === "SUCCESS") {
    await ports.recordError(
      `nâng cấp thất bại, đã hạ về ${request.fromVersion}: ${reason}`,
    );
    return {
      status: "ROLLED_BACK",
      httpStatus: 202,
      message: reason,
    };
  }
  await ports.recordError(
    `nâng cấp thất bại (${reason}) và hạ về ${request.fromVersion} cũng thất bại: ${back.message ?? "không rõ"}`,
  );
  return {
    status: "ROLLBACK_FAILED",
    httpStatus: 202,
    message: reason,
  };
}
