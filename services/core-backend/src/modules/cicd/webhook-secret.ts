import { randomBytes } from "node:crypto";
import {
  decryptCredential,
  encryptCredential,
  type CredentialIdentity,
  type EncryptedCredential,
} from "../credential/credential.crypto.js";

/**
 * Secret webhook CI/CD của một project (§8.3, Plan #36 QĐ-2).
 *
 * UDP SINH nó — 32 byte ngẫu nhiên, dạng hex — người dùng chỉ dán nó vào CI (biến bí mật
 * `UDP_WEBHOOK_SECRET`). Niêm phong envelope như credential cloud (§4.3) với AAD riêng
 * `cicd:webhook | project` — dán ciphertext sang project khác là thất bại xác thực. Giá trị rõ
 * chỉ xuất hiện ở hai chỗ: response của lượt sinh/xoay (MỘT lần) và bộ nhớ của request webhook
 * lúc kiểm chữ ký.
 */

const WEBHOOK_SECRET_DEK_VERSION = 1;

const identityOf = (projectId: string): CredentialIdentity => ({
  credentialId: "cicd:webhook",
  projectId,
  dekVersion: WEBHOOK_SECRET_DEK_VERSION,
});

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function sealWebhookSecret(
  projectId: string,
  secret: string,
): EncryptedCredential {
  return encryptCredential(Buffer.from(secret, "utf8"), identityOf(projectId));
}

export function openWebhookSecret(
  projectId: string,
  sealed: EncryptedCredential,
): Buffer {
  return decryptCredential(sealed, identityOf(projectId));
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Hình của cột `webhook_secret` — thứ khác (null, hình lạ) là "chưa sinh" */
export const isSealedWebhookSecret = (v: unknown): v is EncryptedCredential =>
  record(v) &&
  typeof v.encryptedPayload === "string" &&
  typeof v.encryptedDek === "string";
