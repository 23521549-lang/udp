import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { currentKekVersion, kekFor } from "./kek.js";

/**
 * [v4.10] Envelope encryption AES-256-GCM có AAD cho credential cloud (§4.3).
 *
 * Một bản dump database MỘT MÌNH là vô dụng: payload được mã bằng DEK riêng của từng
 * project, và DEK được bọc bằng KEK nằm NGOÀI database.
 *
 * **AAD = `credentialId | projectId | dek_version`**, và cả ba thành phần đều có việc:
 *
 *  - `credentialId | projectId` chống **hoán đổi ciphertext** giữa hai hàng: không có
 *    chúng, một ciphertext hợp lệ của hàng A dán sang hàng B vẫn xác thực thành công và
 *    GCM không phát hiện gì.
 *  - `dek_version` chống **phát lại** một payload cũ sau khi DEK đã xoay.
 *
 * **Vì sao KHÔNG phải `kek_version`** (và đây là bản sửa của v4.10): xoay KEK tăng
 * `kek_version`, nên nếu AAD chứa nó thì `auth_tag` của payload cũ không còn khớp — sau
 * lần xoay KEK đầu tiên, **mọi credential của mọi tenant không giải mã được**. Lỗi đó chỉ
 * lộ ra ở production, vào đúng lúc người ta đang xoay khoá vì nghi khoá bị lộ.
 *
 * **Vì sao nonce là HEX mà auth_tag là BASE64** — hai cột đều `CHAR(24)`, và đã đo:
 *
 * | Giá trị | hex | base64 |
 * | --- | --- | --- |
 * | nonce 12 byte | **24** | 16 |
 * | auth_tag 16 byte | 32 | **24** |
 *
 * Chỉ đúng một tổ hợp cho 24 ký tự. Mã kiểu khác thì `CHAR(24)` **đệm dấu cách** cho đủ
 * độ dài, và lần đọc lại nhận một chuỗi có dấu cách ở cuối: `Buffer.from` bỏ qua ký tự
 * lạ nên nó không ném, chỉ trả về một nonce sai — và GCM thất bại xác thực với thông điệp
 * "Unsupported state or unable to authenticate data", không hề nói gì về dấu cách.
 */

const ALGO = "aes-256-gcm";
const DEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Độ dài cột `CHAR(24)` — cả hai cột, và hai cách mã khác nhau để cùng ra 24 */
export const NONCE_CHARS = 24;
export const AUTH_TAG_CHARS = 24;

export interface CredentialIdentity {
  credentialId: string;
  projectId: string;
  dekVersion: number;
}

/** Bốn cột mã hoá của một hàng `cloud_credentials`, đúng tên cột đã map */
export interface EncryptedCredential {
  encryptedPayload: string;
  encryptedDek: string;
  kekVersion: number;
  dekVersion: number;
  nonce: string;
  authTag: string;
}

export class CredentialDecryptError extends Error {
  readonly code = "CREDENTIAL_DECRYPT_FAILED";
  constructor(readonly reason: string) {
    /**
     * Thông điệp KHÔNG mang lỗi gốc của OpenSSL và KHÔNG mang một byte ciphertext nào.
     *
     * Lỗi giải mã là thứ đi vào log và có thể đi tới Portal. Một thông điệp mang ciphertext
     * là một kênh rò; một thông điệp mang lỗi OpenSSL nguyên vẹn thì vô hại nhưng vô
     * nghĩa với người đọc. `reason` ở đây là mô tả do ta viết, không phải do thư viện.
     */
    super(`không giải mã được credential: ${reason}`);
    this.name = "CredentialDecryptError";
  }
}

/** `credentialId|projectId|dek_version` — thứ tự CỐ ĐỊNH, xem chú thích đầu tệp */
export function aadOf(identity: CredentialIdentity): Buffer {
  return Buffer.from(
    `${identity.credentialId}|${identity.projectId}|${String(identity.dekVersion)}`,
    "utf8",
  );
}

/**
 * Bọc DEK bằng KEK — blob TỰ CHỨA.
 *
 * `nonce` và `auth_tag` của lớp DEK nằm TRONG blob, không ở hai cột riêng, vì hai cột đó
 * thuộc lớp payload: `rewrapDek` phải đổi `encrypted_dek` mà **không đổi một byte nào**
 * của `encrypted_payload` và `nonce` (§4.3 dòng KEK). Nếu hai lớp dùng chung hai cột thì
 * xoay KEK buộc phải ghi lại cột `nonce`, và tuyên bố đó vỡ.
 */
function wrapDek(dek: Buffer, kekVersion: number): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, kekFor(kekVersion), nonce);
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

function unwrapDek(encryptedDek: string, kekVersion: number): Buffer {
  const raw = Buffer.from(encryptedDek, "base64");
  if (raw.length !== NONCE_BYTES + TAG_BYTES + DEK_BYTES) {
    throw new CredentialDecryptError(
      `blob DEK dài ${String(raw.length)} byte, phải là ` +
        `${String(NONCE_BYTES + TAG_BYTES + DEK_BYTES)}`,
    );
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const body = raw.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, kekFor(kekVersion), nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CredentialDecryptError("DEK không xác thực được bằng KEK này");
  }
}

/**
 * Mã hoá payload credential.
 *
 * `dekVersion` đến từ người gọi, không do hàm này chọn: nó là một phần của AAD, nên nó
 * phải là con số **sẽ được ghi vào cột** `dek_version`. Để hàm tự chọn là mở đường cho
 * một hàng có AAD tính theo version khác với version trong cột của nó, và hàng đó không
 * bao giờ giải mã được.
 */
export function encryptCredential(
  plaintext: Buffer,
  identity: CredentialIdentity,
): EncryptedCredential {
  const dek = randomBytes(DEK_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const kekVersion = currentKekVersion();

  const cipher = createCipheriv(ALGO, dek, nonce);
  cipher.setAAD(aadOf(identity));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    encryptedPayload: body.toString("base64"),
    encryptedDek: wrapDek(dek, kekVersion),
    kekVersion,
    dekVersion: identity.dekVersion,
    /** HEX cho nonce, BASE64 cho tag — xem bảng ở chú thích đầu tệp */
    nonce: nonce.toString("hex"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * Giải mã payload.
 *
 * `.trim()` trên hai cột `CHAR(24)`, và đó không phải sự cẩn thận quá mức: `CHAR(n)` của
 * Postgres **đệm dấu cách** tới đúng `n`, nên một hàng ghi bởi một phiên bản mã hoá sai
 * kiểu (base64 cho nonce: 16 ký tự) sẽ đọc lại thành 16 ký tự cộng 8 dấu cách.
 * `Buffer.from(..., "hex")` bỏ qua ký tự lạ thay vì ném, nên không có `.trim()` thì lỗi
 * hiện ra dưới dạng "không xác thực được" — một thông điệp gửi người đọc đi tìm sai chỗ.
 */
export function decryptCredential(
  row: EncryptedCredential,
  identity: CredentialIdentity,
): Buffer {
  const nonceHex = row.nonce.trim();
  const tagB64 = row.authTag.trim();
  if (nonceHex.length !== NONCE_CHARS) {
    throw new CredentialDecryptError(
      `nonce dài ${String(nonceHex.length)} ký tự sau khi trim, phải là ` +
        `${String(NONCE_CHARS)} (hex của 12 byte)`,
    );
  }

  const dek = unwrapDek(row.encryptedDek, row.kekVersion);
  const decipher = createDecipheriv(ALGO, dek, Buffer.from(nonceHex, "hex"));
  decipher.setAAD(aadOf(identity));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(row.encryptedPayload, "base64")),
      decipher.final(),
    ]);
  } catch {
    /**
     * Một thông điệp, ba nguyên nhân — và KHÔNG đoán giữa chúng.
     *
     * Ciphertext bị sửa, AAD không khớp (hàng bị hoán đổi), hay tag sai: GCM không phân
     * biệt được, và mọi lời "có lẽ là..." ở đây là một suy đoán đi vào log như sự thật.
     */
    throw new CredentialDecryptError(
      "payload không xác thực được — ciphertext bị sửa, hoặc AAD không khớp " +
        "(credentialId / projectId / dek_version khác lúc ghi)",
    );
  }
}

/**
 * Xoay KEK: bọc lại DEK bằng KEK mới, KHÔNG chạm vào payload.
 *
 * Đây là phần cưỡng chế tuyên bố của §4.3 dòng KEK: *"rotate KEK mà không cần giải mã lại
 * toàn bộ dữ liệu — chỉ bọc lại DEK"*. Hàm trả về đúng HAI cột phải ghi, nên một lần gọi
 * không thể vô tình ghi lại `encrypted_payload` hay `nonce`.
 *
 * Nó KHÔNG cần `identity`, và đó là một dấu hiệu tốt: AAD không dính tới KEK, nên xoay
 * KEK không cần biết hàng này thuộc credential nào.
 */
export function rewrapDek(
  row: Pick<EncryptedCredential, "encryptedDek" | "kekVersion">,
  toVersion = currentKekVersion(),
): { encryptedDek: string; kekVersion: number } {
  const dek = unwrapDek(row.encryptedDek, row.kekVersion);
  return { encryptedDek: wrapDek(dek, toVersion), kekVersion: toVersion };
}

/**
 * `fingerprint` = SHA-256 của định danh PUBLIC (roleArn / accessKeyId / …).
 *
 * Nó trả lời "credential này có phải cái tôi đã nhập lần trước không" mà không cần mở
 * envelope. Băm định danh public chứ không băm payload: payload chứa bí mật, và một băm
 * của bí mật là một oracle để dò bí mật ngắn.
 */
export function fingerprintOf(publicIdentifier: string): string {
  return createHash("sha256").update(publicIdentifier, "utf8").digest("hex");
}

/** So fingerprint theo thời gian hằng — nó là dữ liệu public, nhưng so lệch là thói xấu */
export function sameFingerprint(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
