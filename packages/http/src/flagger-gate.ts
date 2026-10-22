import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook gate của Flagger cho SERVICE_LEVEL (§7.3 "udp-driven qua Flagger — dùng webhook gate") [Plan #51 QĐ-9].
 *
 * Service 1 ghi URL + token vào `Canary.spec.analysis.webhooks`; Flagger (trong cluster của tenant) gọi Service 3;
 * Service 3 kiểm token rồi trả 200 (cho đi) hoặc 403 (giữ). MỘT định nghĩa cho cả bên ghi lẫn bên kiểm — hai bản
 * chép là hai cách băm, và mọi gate đóng vĩnh viễn mà không ai biết vì sao.
 *
 * Token là HMAC của id session bằng bí mật nội bộ, có nhãn miền riêng: lộ token của một Canary (nó nằm trong
 * cluster của tenant, ai đọc được CR đều thấy) chỉ mở được gate của ĐÚNG session đó, không suy ra được bí mật,
 * không dùng được cho `/internal/*`.
 */

export const FLAGGER_GATES = [
  "confirm-traffic-increase",
  "confirm-promotion",
  "rollback",
] as const;

export type FlaggerGate = (typeof FLAGGER_GATES)[number];

export const isFlaggerGate = (value: string): value is FlaggerGate =>
  (FLAGGER_GATES as readonly string[]).includes(value);

/** Đường của gate trên Service 3 — nối sau URL gốc mà cluster tenant thấy (`PD_CONTROLLER_WEBHOOK_URL`) */
export const flaggerGatePath = (sessionId: string, gate: FlaggerGate): string =>
  `/webhooks/flagger/${encodeURIComponent(sessionId)}/${gate}`;

export function flaggerGateToken(secret: string, sessionId: string): string {
  return createHmac("sha256", secret)
    .update(`flagger-gate:${sessionId}`)
    .digest("hex");
}

/** So hằng thời gian — độ dài token cố định (hex của SHA-256), nên khác độ dài là sai ngay */
export function flaggerGateTokenMatches(
  secret: string,
  sessionId: string,
  provided: string,
): boolean {
  const expected = Buffer.from(flaggerGateToken(secret, sessionId));
  const given = Buffer.from(provided);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
