import { createHash, createPublicKey } from "node:crypto";
import { ValidationError } from "@udp/http";
import { kmsCloudOf, type BuildSettings } from "@udp/shared-types";

/**
 * [Plan #61 QĐ-14] Khoá ký của project: khoá bí mật ở KMS của cloud, Service 1 chỉ giữ khoá CÔNG KHAI (cổng deploy kiểm
 * chữ ký) và URI (pipeline gọi KMS ký). Dấu vân tay và ngày thêm do máy chủ điền — Portal không tự tính.
 */

/** Dấu vân tay: 16 hex đầu SHA-256 trên DER (SPKI) của khoá công khai */
export function keyIdOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/**
 * Chuẩn hoá phần ký trước khi lưu: khoá phải là ECDSA P-256 (khoá KMS mà script tạo) và cùng cloud với danh tính;
 * điền `id`, `addedAt`; bỏ khoá trùng (giữ bản đứng trước — đầu danh sách là khoá đang ký).
 */
export function canonicalSigning(
  settings: BuildSettings,
  now: Date,
): BuildSettings["signing"] {
  const seen = new Set<string>();
  const keys: BuildSettings["signing"]["keys"] = [];
  for (const key of settings.signing.keys) {
    let curve: string | undefined;
    try {
      curve = createPublicKey(key.publicKey).asymmetricKeyDetails?.namedCurve;
    } catch {
      throw new ValidationError("Khoá ký không đọc được");
    }
    if (curve !== "prime256v1") {
      throw new ValidationError("Khoá ký phải là ECDSA P-256");
    }
    const cloud = kmsCloudOf(key.kms);
    if (settings.identity !== null && cloud !== settings.identity.cloud) {
      throw new ValidationError(
        `Khoá ${key.kms} không thuộc cloud của danh tính build (${settings.identity.cloud})`,
      );
    }
    const id = keyIdOf(key.publicKey);
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({
      id,
      publicKey: key.publicKey,
      kms: key.kms,
      addedAt: key.addedAt ?? now.toISOString(),
    });
  }
  return { ...settings.signing, keys };
}
