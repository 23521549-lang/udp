import { SecretBuffer, type ResolvedCredential } from "@udp/adapter-core";
import type { CredentialMode } from "@udp/db";
import type { CloudPlatform } from "../cloud/cloud.platform.js";
import type { CredentialEnvelope } from "../cloud/cloud.repository.js";
import { providerFromDb } from "../provisioning/provider-codec.js";
import { decryptCredential } from "./credential.crypto.js";

/**
 * Chiều ĐỌC của Credential Manager (§4.3, Plan #26 QĐ-6): hàng đã mã hoá ⇒ credential
 * ngắn hạn mà adapter dùng được.
 *
 * Plaintext dài hạn không rời hàm này: nó chỉ sống trong một `SecretBuffer` bọc đúng
 * Buffer giải mã (không bản sao), và bị `dispose()` — `fill(0)` — ngay khi đổi token xong,
 * thành công hay thất bại. Thứ ra ngoài là token cloud ≤ 1 giờ (federation) hoặc bản
 * STATIC có hạn 15 phút; bên gọi `dispose()` nó sau khi dùng.
 */
export async function resolveCredential(
  row: CredentialEnvelope,
  platform: CloudPlatform,
): Promise<ResolvedCredential> {
  const stored = new SecretBuffer(
    decryptCredential(row, {
      credentialId: row.id,
      projectId: row.projectId,
      dekVersion: row.dekVersion,
    }),
  );
  try {
    return await platform.exchange({
      projectId: row.projectId,
      provider: providerFromDb(row.provider),
      region: row.region,
      mode: row.mode satisfies CredentialMode,
      authKind: row.authKind,
      stored,
    });
  } finally {
    stored.dispose();
  }
}
