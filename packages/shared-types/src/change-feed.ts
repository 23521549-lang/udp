/**
 * Từ vựng ĐÓNG của `ConfigChangeLog.change_type` (§2.2).
 *
 * Vì sao là một danh sách CHẠY ĐƯỢC chứ không chỉ một union: cột là
 * `VARCHAR(50)` chứ không phải enum của Postgres, nên database không chặn được
 * giá trị lạ — chốt duy nhất là tầng kiểu. Nhưng một union chỉ tồn tại lúc biên
 * dịch, nên không gì so được nó với §2.2, và hai danh sách trôi khỏi nhau im
 * lặng. Đó đúng là hình dạng của lỗi v3 mà §7.1 đã sửa: truy vấn claim và
 * `findReconcilable` giữ hai tập status khác nhau, nên session PAUSED không bao
 * giờ được claim. Có danh sách chạy được thì `design-lint` so được nó với tài
 * liệu, cùng khuôn `ERROR_CATALOG`.
 *
 * Vì sao ở `@udp/shared-types` chứ không ở `@udp/db`: bên đọc từ vựng này không
 * chỉ có bên ghi outbox. Poller của Service 2 rẽ nhánh theo nó, và SDK trong ứng
 * dụng của khách sẽ áp delta theo nó (I15c) — mà SDK không bao giờ được phụ
 * thuộc `@udp/db`.
 */
export const CONFIG_CHANGE_TYPES = [
  "flag.created",
  "flag.updated",
  "flag.archived",
  "rule.replaced",
  /**
   * [v4.1] Service 3 ramp trọng số (C1). Tách khỏi `rule.replaced` để sổ kiểm
   * toán phân biệt được "người sửa rule" với "rollout đổi phần trăm" — câu hỏi
   * "vì sao user thấy X" theo chiều thời gian cần đúng sự phân biệt đó.
   */
  "rule.ramped",
  "envconfig.toggled",
  "variant.updated",
  "segment.updated",
  "sdkkey.revoked",
] as const;

export type ConfigChangeType = (typeof CONFIG_CHANGE_TYPES)[number];

/**
 * Kênh `NOTIFY` của tầng 3 (ADR-05) — tên giữ nguyên §6.3.
 *
 * Ở đây vì có ba bên cùng cần: writer (`writeWithOutbox` của `@udp/db`), replica
 * Service 2 nghe, và kill-switch của Service 3 sau này. Tên kênh lệch một ký tự thì
 * tầng 3 im lặng rơi về polling 500ms — không có lỗi nào báo.
 */
export const CONFIG_CHANGE_CHANNEL = "flag_changed";

/** Payload của một notice: environment nào vừa lên version nào. KHÔNG mang cấu hình */
export interface ConfigChangeNotice {
  environmentId: string;
  configVersion: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dựng payload — writer PHẢI đi qua hàm này, không tự nối JSON. Hai đầu dùng chung
 * một cặp hàm thì lệch tên trường là lỗi biên dịch, không phải tầng 3 điếc im lặng.
 */
export function formatConfigChangeNotice(notice: ConfigChangeNotice): string {
  return JSON.stringify({
    environmentId: notice.environmentId,
    configVersion: notice.configVersion,
  });
}

/**
 * Đọc payload — sai hình dạng thì `null`, KHÔNG ném.
 *
 * Tầng 3 chỉ đánh thức, không mang dữ liệu: một notice hỏng không được làm hỏng
 * replica, và vòng poll kế tiếp vẫn đúng dù notice bị bỏ.
 */
export function parseConfigChangeNotice(
  payload: string,
): ConfigChangeNotice | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;

  const { environmentId, configVersion } = value as Record<string, unknown>;
  if (typeof environmentId !== "string" || !UUID.test(environmentId)) {
    return null;
  }
  if (
    typeof configVersion !== "number" ||
    !Number.isSafeInteger(configVersion) ||
    configVersion < 0
  ) {
    return null;
  }
  return { environmentId, configVersion };
}
