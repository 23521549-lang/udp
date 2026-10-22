import { env } from "@udp/config";

/**
 * [v4.10] KEK theo version — MỘT chỗ duy nhất tra khoá bọc (§4.3).
 *
 * Vì sao nó là một module riêng chứ không phải một dòng `env[`UDP_KEK_V${v}`]` tại chỗ
 * dùng: truy cập động vào `env` bằng một khoá dựng từ chuỗi làm mất đúng thứ `env.ts` tồn
 * tại để có — TypeScript không kiểm được tên biến, nên một version chưa khai trả về
 * `undefined`, và `undefined` đi tiếp vào `createCipheriv` thành một lỗi runtime ở chỗ xa
 * nguyên nhân. Ở đây bảng là TƯỜNG MINH, nên thêm version 3 là một lỗi biên dịch tại đúng
 * tệp này.
 *
 * `env.ts` đã cưỡng chế: mọi `v` trong `[1, UDP_KEK_VERSION]` đều có biến tương ứng, và
 * `UDP_KEK_V2 ≠ UDP_KEK_V1`. Nên hàm dưới đây chỉ còn một ca lỗi thật: ai đó gọi với một
 * version **cao hơn** `UDP_KEK_VERSION` — tức đọc một hàng được bọc bằng khoá mà môi
 * trường này chưa có.
 */

export class UnknownKekVersionError extends Error {
  readonly code = "KEK_VERSION_UNKNOWN";
  constructor(readonly version: number) {
    super(
      `không có KEK version ${String(version)}; môi trường này khai tới ` +
        `UDP_KEK_VERSION = ${String(env.UDP_KEK_VERSION)}`,
    );
    this.name = "UnknownKekVersionError";
  }
}

/** Version dùng để bọc DEK MỚI. Đọc thì theo `kek_version` của từng hàng */
export const currentKekVersion = (): number => env.UDP_KEK_VERSION;

/**
 * KEK 32 byte của một version.
 *
 * Trả `Buffer` mới mỗi lần thay vì một hằng số dùng chung: `Buffer` là dữ liệu thô có thể
 * bị ghi đè tại chỗ, và một hằng số dùng chung là một chỗ mà một lỗi ở xa có thể làm hỏng
 * khoá cho mọi lời gọi sau đó.
 */
export function kekFor(version: number): Buffer {
  const table: Readonly<Record<number, string | undefined>> = {
    1: env.UDP_KEK_V1,
    2: env.UDP_KEK_V2,
  };
  const encoded = table[version];
  if (encoded === undefined) throw new UnknownKekVersionError(version);
  return Buffer.from(encoded, "base64");
}
