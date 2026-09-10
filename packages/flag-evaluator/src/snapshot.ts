import { createHash } from "node:crypto";

/**
 * Chuẩn hoá snapshot và tính `config_hash` (§2.2, ADR-05).
 *
 * Vì sao ở package dùng chung chứ không trong Service 2: đây là **hợp đồng liên
 * tiến trình**. S2 ghi `config_hash` vào `environments`; SDK trong ứng dụng của
 * khách dựng lại snapshot từ các delta đã nhận, tính lại hash mỗi 60 giây, và so
 * với con số S2 ghi. Hai bên phải cho ra **cùng từng bit** — I15c nói đúng chữ
 * đó. Hai bản cài đặt song song thì chỉ khớp nhờ may mắn.
 *
 * `config_version` là số ĐẾM, `config_hash` là checksum NỘI DUNG. Đó là lý do
 * tồn tại của hàm này: một replica có thể đúng version nhưng sai nội dung (áp
 * delta hỏng), và chỉ checksum nội dung bắt được.
 */

/** Flag bình thường trong snapshot */
export interface SnapshotFlag {
  key: string;
  flagType: string;
  stickinessAttribute: string;
  defaultVariantId: string | null;
  variants: { id: string; key: string; value: unknown }[];
  isEnabled: boolean;
  envDefaultVariantId: string | null;
  rules: {
    id: string;
    ruleType: string;
    priority: number;
    bucketSalt: string;
    condition: unknown;
    serve: unknown;
  }[];
}

/**
 * Flag đã lưu trữ vẫn CÓ MẶT trong snapshot, dưới dạng bia mộ.
 *
 * §6.5: bỏ hẳn flag `ARCHIVED` khỏi payload làm SDK trả `FLAG_NOT_FOUND` thay vì
 * `DISABLED` — hai thứ khác nhau với người viết ứng dụng: cái đầu nghĩa là "gõ
 * sai tên flag", cái sau nghĩa là "flag có thật, đang tắt". Đây là chi tiết duy
 * nhất của §6.5 mà lát cắt đầu không hoãn được, vì `config_hash` đóng băng định
 * dạng snapshot ngay từ hôm nay.
 */
export interface SnapshotTombstone {
  key: string;
  archived: true;
}

export type SnapshotEntry = SnapshotFlag | SnapshotTombstone;

/**
 * Dạng chuẩn của một giá trị bất kỳ, đệ quy.
 *
 * `JSON.stringify` trần KHÔNG dùng được ở đây, vì bốn lý do đã đo:
 *
 *   - **Thứ tự khoá**: `sha({a,b})` khác `sha({b,a})`. Tệ hơn, Postgres lưu
 *     `jsonb` với khoá đã sắp lại theo (độ dài, byte) của CHÍNH nó, nên thứ tự
 *     đọc về không phải thứ tự đã ghi.
 *   - **`undefined` biến mất im lặng**: `JSON.stringify({a:1,b:undefined})` cho
 *     `{"a":1}`, nên "trường vắng mặt" và "trường bằng undefined" ra cùng chuỗi
 *     trong khi chúng đến từ hai truy vấn `select` khác nhau.
 *   - **Số thực**: `0.1+0.2` ra `"0.30000000000000004"`, `1e21` ra `"1e+21"`.
 *   - **Unicode**: NFC và NFD của cùng một tên cho hai chuỗi khác nhau; iOS gửi
 *     NFD còn Android gửi NFC.
 *
 * Sắp khoá bằng so sánh mã đơn vị (`<`) chứ KHÔNG dùng `localeCompare`: thứ tự
 * của `localeCompare` phụ thuộc locale và bản dựng ICU của Node. Hai tiến trình
 * cùng mã nguồn nhưng khác ICU sẽ ra hai hash khác nhau, và triệu chứng là
 * `changefeed_hash_mismatch_total` tăng mãi mà không ai tìm ra nguyên nhân.
 */
function canonical(value: unknown, path: string): unknown {
  if (value === null) return null;

  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(
        `Snapshot chứa số không nguyên tại ${path}: ${String(value)}. ` +
          `Số thực không có biểu diễn thập phân ổn định, nên hash sẽ đổi theo nền tảng.`,
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => canonical(item, `${path}[${String(i)}]`));
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v, `${path}.${k}`)] as const);
    return Object.fromEntries(entries);
  }

  throw new Error(
    `Snapshot chứa giá trị không tuần tự hoá ổn định được tại ${path}: ${typeof value}. ` +
      `\`undefined\` bị JSON.stringify nuốt im lặng, \`bigint\` thì ném.`,
  );
}

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonical(value, "$"));

/**
 * Sắp flag theo `key` và rule theo `priority` (§2.2 nói đúng hai điều này).
 *
 * KHÔNG sắp `weights`. Thứ tự mảng đó mang ngữ nghĩa — đảo nó là gán mọi người
 * dùng sang variant khác — nên sắp ở đây sẽ làm hai cấu hình có hành vi khác
 * nhau ra cùng `config_hash`, tức I15a mù đúng chỗ nguy hiểm nhất. Thứ tự chuẩn
 * của `weights` phải được ép ở tầng GHI, không phải ở tầng băm.
 */
export function normalizeSnapshot(entries: SnapshotEntry[]): SnapshotEntry[] {
  return [...entries]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) =>
      "archived" in entry
        ? entry
        : {
            ...entry,
            rules: [...entry.rules].sort((x, y) => x.priority - y.priority),
          },
    );
}

/** SHA-256 hex của snapshot đã chuẩn hoá — vừa đúng 64 ký tự của `VARCHAR(64)` */
export const configHashOf = (entries: SnapshotEntry[]): string =>
  createHash("sha256")
    .update(canonicalJson(normalizeSnapshot(entries)))
    .digest("hex");
