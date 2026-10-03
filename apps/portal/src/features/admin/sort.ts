/**
 * [Plan #58 UX-34] Thứ tự của một bảng Bảng điều khiển, nằm trên URL dạng `?sort=cost.desc` (Plan #53 QĐ-9: gửi đường
 * dẫn là gửi đúng màn đang xem). Bảng có đủ dòng ở máy khách (tài nguyên mồ côi, credential) sắp tại chỗ bằng
 * `sortRows`; bảng theo trang (người dùng, project) gửi chiều sắp lên máy chủ.
 */

export type SortDir = "asc" | "desc";
export interface Sort<K extends string> {
  readonly key: K;
  readonly dir: SortDir;
}
export type SortValue<K extends string> = `${K}.${SortDir}`;

/** Đọc `?sort=` — cột lạ hay chiều lạ là `undefined` (màn hình dùng thứ tự mặc định) */
export function parseSort<K extends string>(
  raw: unknown,
  keys: readonly K[],
): Sort<K> | undefined {
  if (typeof raw !== "string") return undefined;
  const [name, dir] = raw.split(".");
  const key = keys.find((k) => k === name);
  return key === undefined || (dir !== "asc" && dir !== "desc")
    ? undefined
    : { key, dir };
}

/** Giá trị ghi lên URL; thứ tự mặc định không ghi ra */
export function sortParam<K extends string>(
  sort: Sort<K>,
  fallback: Sort<K>,
): SortValue<K> | undefined {
  return sort.key === fallback.key && sort.dir === fallback.dir
    ? undefined
    : `${sort.key}.${sort.dir}`;
}

/** Bấm tiêu đề cột: cột đang sắp thì đảo chiều; cột khác bắt đầu ở chiều tự nhiên của nó (`first`) */
export function toggleSort<K extends string>(
  current: Sort<K>,
  key: K,
  first: SortDir,
): Sort<K> {
  return current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: first };
}

/**
 * Sắp theo giá trị của cột. `null` (chưa rõ giá, chưa biết) luôn đứng CUỐI ở cả hai chiều: nó không phải số nhỏ nhất
 * cũng không phải lớn nhất. Cùng giá trị thì giữ thứ tự của máy chủ (sort ổn định).
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: Sort<K>,
  valueOf: (row: T, key: K) => number | string | null,
): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row) => ({ row, v: valueOf(row, sort.key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) {
        return a.v === b.v ? 0 : a.v === null ? 1 : -1;
      }
      const diff =
        typeof a.v === "number" && typeof b.v === "number"
          ? a.v - b.v
          : String(a.v).localeCompare(String(b.v));
      return sign * diff;
    })
    .map((x) => x.row);
}
