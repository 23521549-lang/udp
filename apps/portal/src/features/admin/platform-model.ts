import type { AdminPlatformWire } from "@udp/shared-types/wire";
import type { Tone } from "../../components/StatusLabel";

/**
 * [Plan #53 QĐ-6] Phán quyết cho từng tín hiệu nền tảng — THUẦN, `now` truyền vào để test không
 * phụ thuộc đồng hồ. Mỗi hàm trả tone và MỘT câu; màn hình không tự suy thêm gì.
 */

type Ok<K extends keyof AdminPlatformWire> = Extract<
  AdminPlatformWire[K],
  { state: "ok" }
>;
type Unavailable = Extract<AdminPlatformWire["node"], { state: "unavailable" }>;

/** Sức khoẻ một service (`GET /admin/system/health`) — trang Tổng quan và trang Hệ thống dùng chung */
export const SERVICE_STATUS: Record<
  "up" | "down" | "unknown",
  { tone: Tone; label: string }
> = {
  up: { tone: "ok", label: "Ổn định" },
  down: { tone: "error", label: "Không phản hồi" },
  unknown: { tone: "unknown", label: "Không rõ" },
};

export const PLATFORM_REASON: Record<Unavailable["reason"], string> = {
  NOT_IN_CLUSTER: "UDP không chạy trong Kubernetes (máy dev)",
  NOT_CONFIGURED: "Chưa dựng trong cụm",
  FORBIDDEN: "ServiceAccount của Service 1 thiếu quyền đọc",
  UNAVAILABLE: "Không đọc được lúc này",
};

/**
 * Ngưỡng "rảnh" của Oracle Always Free: máy có CPU (và RAM với shape A1) dưới 20% suốt 7 ngày có thể
 * bị thu hồi. Portal chỉ thấy mức LÚC NÀY, nên câu nói đúng điều đó — lịch sử 7 ngày ở Oracle Console.
 */
export const ORACLE_IDLE_RATIO = 0.2;

export function idleRisk(node: Ok<"node">): { tone: Tone; text: string } {
  const cpu = node.cpuUsedCores / node.cpuCores;
  const mem = node.memoryUsedBytes / node.memoryBytes;
  if (cpu < ORACLE_IDLE_RATIO && mem < ORACLE_IDLE_RATIO) {
    return {
      tone: "warn",
      text: "Lúc này CPU và RAM đều dưới 20%. Nếu kéo dài 7 ngày, Oracle có thể thu hồi máy Always Free.",
    };
  }
  return {
    tone: "ok",
    text: "Lúc này trên ngưỡng rảnh 20% của Oracle. Lịch sử 7 ngày xem ở Oracle Console.",
  };
}

const DAY_MS = 86_400_000;

/** Sao lưu: lần hỏng gần hơn lần thành công là lỗi; chưa thành công lần nào, hoặc quá 2 ngày, là cảnh báo */
export function backupVerdict(
  b: Ok<"backup">,
  now: number = Date.now(),
): { tone: Tone; label: string } {
  const success = b.lastSuccessAt === null ? null : Date.parse(b.lastSuccessAt);
  const failure = b.lastFailureAt === null ? null : Date.parse(b.lastFailureAt);
  if (failure !== null && (success === null || failure > success)) {
    return { tone: "error", label: "Lần gần nhất thất bại" };
  }
  if (success === null)
    return { tone: "warn", label: "Chưa có lần thành công" };
  if (now - success > 2 * DAY_MS) {
    return { tone: "warn", label: "Quá 2 ngày chưa sao lưu" };
  }
  return { tone: "ok", label: "Đều đặn" };
}

/** Chứng chỉ: chưa sẵn sàng hoặc đã hết hạn là lỗi; còn dưới 14 ngày là cảnh báo (cert-manager gia hạn ở 30) */
export function certificateVerdict(
  c: Ok<"certificate">,
  now: number = Date.now(),
): { tone: Tone; label: string } {
  const notAfter = c.notAfter === null ? null : Date.parse(c.notAfter);
  if (!c.ready || (notAfter !== null && notAfter <= now)) {
    return { tone: "error", label: "Không hợp lệ" };
  }
  if (notAfter !== null && notAfter - now < 14 * DAY_MS) {
    return { tone: "warn", label: "Sắp hết hạn" };
  }
  return { tone: "ok", label: "Hợp lệ" };
}
