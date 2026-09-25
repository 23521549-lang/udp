import { UnprocessableError } from "@udp/http";
import { z, type ZodTypeAny } from "zod";
import {
  decryptCredential,
  encryptCredential,
  type CredentialIdentity,
  type EncryptedCredential,
} from "../credential/credential.crypto.js";

/**
 * Bí mật trong `tool_config` (§2.2, §5.2, Plan #31 QĐ-1).
 *
 * Adapter đánh dấu một trường là bí mật bằng `.describe("secret")` trong `configSchema`. Giá
 * trị của trường đó:
 *
 * - **lúc lưu** (bảng `domain_configs`, payload job): niêm phong envelope AES-256-GCM — cùng
 *   máy mã hoá với credential cloud (§4.3) — với AAD gắn `DOMAIN:field | project`: dán
 *   ciphertext sang trường khác hay project khác là thất bại xác thực;
 * - **trên dây**: `{ "$udpSecret": "kept" }` — Portal biết "đã lưu", không bao giờ thấy giá trị;
 * - **gửi lại** đúng giá trị giữ chỗ đó ⇒ giữ bản đã lưu; gửi chuỗi ⇒ bản mới;
 * - **dùng**: chỉ worker mở ra, trong bộ nhớ, ngay trước lời gọi adapter.
 *
 * Chỉ NIÊM PHONG và GIẢI GIỮ CHỖ cần `configSchema` (để biết trường nào là bí mật); mở và che
 * đi theo hình của giá trị — mọi chỗ đọc bảng làm được mà không phải tra adapter trước.
 */

export const SECRET_DESCRIPTION = "secret";
export const KEPT_SECRET = { $udpSecret: "kept" } as const;

/** Phiên bản DEK của bí mật tool — xoay DEK là việc riêng, như credential cloud */
const TOOL_SECRET_DEK_VERSION = 1;

export interface SealedSecret extends EncryptedCredential {
  $udpSecret: 1;
}

type Config = Record<string, unknown>;

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const isSealed = (v: unknown): v is SealedSecret =>
  record(v) && v.$udpSecret === 1 && typeof v.encryptedPayload === "string";

export const isKept = (v: unknown): boolean =>
  record(v) && v.$udpSecret === "kept" && Object.keys(v).length === 1;

/** Trường có `.describe("secret")` ở bất kỳ lớp bọc nào (`optional`, `default`, `nullable`) */
function isSecretField(schema: ZodTypeAny): boolean {
  let node: ZodTypeAny = schema;
  for (;;) {
    if (node.description === SECRET_DESCRIPTION) return true;
    if (node instanceof z.ZodOptional || node instanceof z.ZodNullable) {
      node = node.unwrap() as ZodTypeAny;
    } else if (node instanceof z.ZodDefault) {
      node = node.removeDefault() as ZodTypeAny;
    } else {
      return false;
    }
  }
}

/** Tên các trường bí mật cấp một của `configSchema` — schema không phải object ⇒ không có */
export function secretFieldsOf(schema: ZodTypeAny): string[] {
  let node: ZodTypeAny = schema;
  while (
    node instanceof z.ZodOptional ||
    node instanceof z.ZodNullable ||
    node instanceof z.ZodDefault
  ) {
    node =
      node instanceof z.ZodDefault
        ? (node.removeDefault() as ZodTypeAny)
        : (node.unwrap() as ZodTypeAny);
  }
  if (!(node instanceof z.ZodObject)) return [];
  const shape = node.shape as Record<string, ZodTypeAny>;
  return Object.entries(shape)
    .filter(([, field]) => isSecretField(field))
    .map(([key]) => key);
}

const identityOf = (
  projectId: string,
  domainType: string,
  field: string,
): CredentialIdentity => ({
  credentialId: `domain:${domainType}:${field}`,
  projectId,
  dekVersion: TOOL_SECRET_DEK_VERSION,
});

export interface SecretScope {
  schema: ZodTypeAny;
  projectId: string;
  domainType: string;
}

/**
 * Trước khi kiểm bằng `configSchema`: thay giá trị giữ chỗ bằng bản rõ của bí mật ĐÃ LƯU
 * (`previous` là `tool_config` đang nằm trong bảng). Giữ chỗ mà không có gì đã lưu là lỗi
 * của người gửi: 422, không đoán.
 */
export function resolveKept(
  scope: SecretScope,
  config: Config,
  previous: Config | null,
): Config {
  const out: Config = { ...config };
  for (const field of secretFieldsOf(scope.schema)) {
    if (!isKept(out[field])) continue;
    const stored = previous?.[field];
    if (!isSealed(stored)) {
      throw new UnprocessableError(
        `Trường bí mật ${field} của ${scope.domainType} chưa từng được lưu — nhập giá trị`,
      );
    }
    out[field] = decryptCredential(
      stored,
      identityOf(scope.projectId, scope.domainType, field),
    ).toString("utf8");
  }
  return out;
}

/** Niêm phong mọi trường bí mật dạng chuỗi — gọi SAU khi đã kiểm bằng `configSchema` */
export function sealSecrets(scope: SecretScope, config: Config): Config {
  const out: Config = { ...config };
  for (const field of secretFieldsOf(scope.schema)) {
    const value = out[field];
    if (typeof value !== "string") continue;
    const sealed: SealedSecret = {
      $udpSecret: 1,
      ...encryptCredential(
        Buffer.from(value, "utf8"),
        identityOf(scope.projectId, scope.domainType, field),
      ),
    };
    out[field] = sealed;
  }
  return out;
}

/**
 * Mở mọi bí mật đã niêm phong — CHỈ trong bộ nhớ, ngay trước lời gọi adapter. Theo HÌNH
 * của giá trị, không theo schema: tên trường nằm trong AAD, nên mở sai trường là thất bại
 * xác thực chứ không phải một giá trị lạ lọt qua.
 */
export function openSecrets(
  scope: { projectId: string; domainType: string },
  config: Config,
): Config {
  const out: Config = { ...config };
  for (const [field, value] of Object.entries(out)) {
    if (!isSealed(value)) continue;
    out[field] = decryptCredential(
      value,
      identityOf(scope.projectId, scope.domainType, field),
    ).toString("utf8");
  }
  return out;
}

/** Cấu hình lên dây: mọi bí mật đã niêm phong thành giá trị giữ chỗ */
export function maskSecrets(config: Config): Config {
  const out: Config = { ...config };
  for (const [field, value] of Object.entries(out)) {
    if (isSealed(value)) out[field] = { ...KEPT_SECRET };
  }
  return out;
}
