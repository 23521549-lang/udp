import type { Tone } from "../../components/StatusLabel";
import type { AdminCredentialRow } from "./admin-api";

export type CredentialState = "ok" | "never" | "inactive";

/**
 * [Plan #58 UX-7] Credential không còn dùng, hay chưa kiểm lần nào, là điều người vận hành cần thấy (cam): project đó
 * chưa chắc dựng được hạ tầng. Trước đây hai trường hợp này chỉ là một ô "–" và chữ "chưa".
 */
export function credentialState(
  c: Pick<AdminCredentialRow, "isActive" | "lastValidatedAt">,
): { state: CredentialState; tone: Tone } {
  if (!c.isActive) return { state: "inactive", tone: "warn" };
  if (c.lastValidatedAt === null) return { state: "never", tone: "warn" };
  return { state: "ok", tone: "ok" };
}
