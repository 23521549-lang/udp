import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  INTERNAL_SECRET_HEADER,
  type InternalTarget,
} from "@udp/config/constants";

/**
 * [Plan #67] Phía BÊN GỌI của lớp danh tính `/internal/*`: token chiếu của ServiceAccount, mỗi đích một tệp trong
 * `INTERNAL_TOKEN_DIR` (volume `projected` của Deployment, audience `INTERNAL_AUDIENCE[đích]`).
 */

export type InternalToken = () => Promise<string>;

/** Đọc lại MỖI lời gọi: kubelet xoay token chiếu ở 80% thời hạn, một bản giữ trong bộ nhớ sẽ hết hạn */
export function internalTokenFrom(
  dir: string,
  target: InternalTarget,
): InternalToken {
  const path = join(dir, target);
  return async () => {
    const token = (await readFile(path, "utf8")).trim();
    if (token === "") throw new Error(`Tệp token chiếu ${path} rỗng`);
    return token;
  };
}

/**
 * Đọc thử token của TỪNG đích lúc khởi động: thiếu volume `projected` thì service không mở cổng, thay vì
 * mở cổng rồi để Portal nhận 5xx và Service 3 kẹt reconcile.
 */
export async function assertInternalTokens(
  dir: string,
  targets: readonly InternalTarget[],
): Promise<void> {
  for (const target of targets) {
    try {
      await internalTokenFrom(dir, target)();
    } catch (err) {
      throw new Error(
        `Không đọc được token chiếu cho ${target} trong ${dir} - Deployment thiếu volume projected? ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Header xác thực của một lời gọi `/internal/*`: bí mật dùng chung luôn có; token chiếu khi chạy `token-review`.
 * Gọi BÊN TRONG nhánh bắt lỗi mạng của client: đọc tệp hỏng đi đúng đường "không gọi được", không thành lỗi khác.
 */
export async function internalAuthHeaders(
  secret: string,
  token?: InternalToken,
): Promise<Record<string, string>> {
  return token === undefined
    ? { [INTERNAL_SECRET_HEADER]: secret }
    : {
        [INTERNAL_SECRET_HEADER]: secret,
        authorization: `Bearer ${await token()}`,
      };
}
