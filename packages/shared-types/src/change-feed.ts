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
