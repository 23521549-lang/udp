import type { AdminPlatformWire } from "@udp/shared-types/wire";
import type { Tone } from "../../components/StatusLabel";
import { messagesOf } from "../../i18n";
import { adminMessages } from "./admin.messages";

/**
 * [Plan #53 QĐ-6] Phán quyết cho từng tín hiệu nền tảng — THUẦN, `now` truyền vào để test không
 * phụ thuộc đồng hồ. Mỗi hàm trả tone và MỘT câu; màn hình không tự suy thêm gì.
 *
 * [Plan #54] Câu đọc theo ngôn ngữ LÚC GỌI (`messagesOf`), chữ ở `admin.messages.tsx`; component gọi các
 * hàm này đã theo dõi ngôn ngữ qua chữ của chính nó.
 */

type Ok<K extends keyof AdminPlatformWire> = Extract<
  AdminPlatformWire[K],
  { state: "ok" }
>;
type Unavailable = Extract<AdminPlatformWire["node"], { state: "unavailable" }>;
export type PlatformUnavailableReason = Unavailable["reason"];
type ServiceState = "up" | "down" | "unknown";

const copy = () => messagesOf(adminMessages).platform;

const SERVICE_TONE: Record<ServiceState, Tone> = {
  up: "ok",
  down: "error",
  unknown: "unknown",
};

/** Sức khoẻ một service (`GET /admin/system/health`) — trang Tổng quan và trang Hệ thống dùng chung */
export const serviceStatus = (
  status: ServiceState,
): { tone: Tone; label: string } => ({
  tone: SERVICE_TONE[status],
  label: copy().service[status],
});

/** Vì sao một tín hiệu của cụm không đọc được */
export const platformReason = (reason: PlatformUnavailableReason): string =>
  copy().reason[reason];

/**
 * Ngưỡng "rảnh" của Oracle Always Free: máy có CPU (và RAM với shape A1) dưới 20% suốt 7 ngày có thể
 * bị thu hồi. Portal chỉ thấy mức LÚC NÀY, nên câu nói đúng điều đó — lịch sử 7 ngày ở Oracle Console.
 */
export const ORACLE_IDLE_RATIO = 0.2;

export function idleRisk(node: Ok<"node">): { tone: Tone; text: string } {
  const cpu = node.cpuUsedCores / node.cpuCores;
  const mem = node.memoryUsedBytes / node.memoryBytes;
  if (cpu < ORACLE_IDLE_RATIO && mem < ORACLE_IDLE_RATIO) {
    return { tone: "warn", text: copy().idle.risk };
  }
  return { tone: "ok", text: copy().idle.safe };
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
    return { tone: "error", label: copy().backup.failed };
  }
  if (success === null) return { tone: "warn", label: copy().backup.never };
  if (now - success > 2 * DAY_MS) {
    return { tone: "warn", label: copy().backup.stale };
  }
  return { tone: "ok", label: copy().backup.regular };
}

/** Chứng chỉ: chưa sẵn sàng hoặc đã hết hạn là lỗi; còn dưới 14 ngày là cảnh báo (cert-manager gia hạn ở 30) */
export function certificateVerdict(
  c: Ok<"certificate">,
  now: number = Date.now(),
): { tone: Tone; label: string } {
  const notAfter = c.notAfter === null ? null : Date.parse(c.notAfter);
  if (!c.ready || (notAfter !== null && notAfter <= now)) {
    return { tone: "error", label: copy().certificate.invalid };
  }
  if (notAfter !== null && notAfter - now < 14 * DAY_MS) {
    return { tone: "warn", label: copy().certificate.expiring };
  }
  return { tone: "ok", label: copy().certificate.valid };
}
