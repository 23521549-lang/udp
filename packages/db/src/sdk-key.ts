import { createHash, randomBytes } from "node:crypto";
import { SDK_KEY } from "@udp/config/constants";
import type { SdkKeyType } from "./generated/prisma/enums.js";

/**
 * [v4.9] Vật liệu SDK key (§2.2, §6.2) — MỘT định nghĩa cho nơi phát hành (Service
 * 1), nơi tra (guard của Service 2), seed và fixture test. Trước đây công thức
 * hash/đuôi lặp ở ba nơi; lệch một nơi là khoá phát hành ra không bao giờ khớp.
 *
 * Token có dạng `{typePrefix}{envSlug}_{64 hex}` và KHÔNG BAO GIỜ được parse:
 * environment suy từ hàng DB tra theo hash (ADR-03), nên `envSlug` chỉ là nhãn cho
 * người đọc — đổi tên env sau này không đổi hiệu lực của khoá.
 */

const typePrefixOf = (keyType: SdkKeyType): string =>
  keyType === "SERVER" ? SDK_KEY.serverPrefix : SDK_KEY.clientPrefix;

/**
 * Tên env → nhãn trong token: bỏ dấu, chữ thường, CHỈ `[a-z0-9]`.
 *
 * Không giữ `-` như nhãn namespace K8s: có gạch ngang thì nháy đúp không chọn được
 * cả khoá. `normalize("NFD")` tách dấu thanh khỏi nguyên âm để `\p{M}` xoá được;
 * `đ`/`Đ` không tách ra nên phải thay tay. Rỗng (tên toàn ký tự lạ) ⇒ `env`.
 */
export function envSlugOf(envName: string): string {
  const slug = envName
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, SDK_KEY.envSlugMaxLength);
  return slug === "" ? "env" : slug;
}

/**
 * Token thô mới: `SDK_KEY.randomBytes` byte ngẫu nhiên dạng hex — 256 bit, không
 * bias, không ký tự `-`. Plaintext chỉ sống trong bộ nhớ của bên phát hành và
 * trong response tạo khoá (hiện ĐÚNG MỘT LẦN).
 */
export function issueSdkKeyToken(keyType: SdkKeyType, envName: string): string {
  const random = randomBytes(SDK_KEY.randomBytes).toString("hex");
  return `${typePrefixOf(keyType)}${envSlugOf(envName)}_${random}`;
}

export interface SdkKeyMaterial {
  /** `sha256(token)` hex — thứ duy nhất database giữ để tra */
  keyHash: string;
  /** `SDK_KEY.displaySuffixLength` ký tự CUỐI, để người dùng nhận ra khoá */
  keySuffix: string;
}

export function sdkKeyMaterialOf(token: string): SdkKeyMaterial {
  return {
    keyHash: createHash("sha256").update(token).digest("hex"),
    keySuffix: token.slice(-SDK_KEY.displaySuffixLength),
  };
}

const HEX = "[0-9a-f]";

/** `sha256` hex: 32 byte ra 64 ký tự, không phụ thuộc `SDK_KEY.randomBytes` */
const HASH_LENGTH = 64;

/**
 * [v4.9] Hình dạng của HAI trường mà Service 1 gửi sang Service 2 (§3.2).
 *
 * Khai ở đây, cạnh hàm sinh ra chúng, chứ không ở schema zod của Service 2: biên
 * trong phải từ chối đúng thứ mà biên phát hành không bao giờ tạo ra, và hai bản
 * khai rời nhau là hai thứ trôi khỏi nhau — nới `displaySuffixLength` mà quên
 * sửa regex thì mọi lời gọi tạo khoá trả 400 sau khi token đã sinh.
 */
export const SDK_KEY_HASH_PATTERN = new RegExp(
  `^${HEX}{${String(HASH_LENGTH)}}$`,
);
export const SDK_KEY_SUFFIX_PATTERN = new RegExp(
  `^${HEX}{${String(SDK_KEY.displaySuffixLength)}}$`,
);

/**
 * [v4.9] Mẫu của PLAINTEXT — dùng để QUÉT rò rỉ (INV-23.3), không để parse khoá.
 *
 * Nó sống ở đây vì cùng một lý do: một mẫu chép tay trong test sẽ im lặng ngừng
 * khớp đúng vào ngày định dạng token đổi, và lúc đó phép quét "không có plaintext
 * trong database hay log" vẫn xanh trong khi nó không còn kiểm gì. Suy từ CHÍNH
 * các hằng số mà `issueSdkKeyToken` dùng, nên hai bên không thể lệch.
 *
 * Không neo `^`/`$`: phép quét tìm token NẰM TRONG một chuỗi dài (một hàng JSON,
 * một dòng log), không kiểm một chuỗi có phải token hay không.
 */
export const SDK_KEY_PLAINTEXT_PATTERN = new RegExp(
  `(${SDK_KEY.serverPrefix}|${SDK_KEY.clientPrefix})` +
    `[a-z0-9]{1,${String(SDK_KEY.envSlugMaxLength)}}_${HEX}{${String(HASH_LENGTH)}}`,
);

/**
 * Dạng hiển thị: `udp_sk_…a1b2c3`. Tiền tố lấy theo LOẠI khoá, không dựng lại
 * `envSlug` từ tên env hiện tại — env có thể đã đổi tên, và phần duy nhất đáng tin
 * là đuôi đã lưu.
 */
export function maskedKeyOf(keyType: SdkKeyType, keySuffix: string): string {
  return `${typePrefixOf(keyType)}…${keySuffix}`;
}
