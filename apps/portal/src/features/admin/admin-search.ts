import type { AdminOverviewWire, AdminUserWire } from "@udp/shared-types/wire";
import { parseSort, type Sort, type SortValue } from "./sort";

/**
 * [Plan #58 UX-28, UX-32, UX-34] Trạng thái trên URL của các danh sách Bảng điều khiển (Plan #53 QĐ-9): bộ lọc, tab,
 * thứ tự, trang và panel project đang mở. Router gọi các hàm `…Search` này; giá trị lạ bị bỏ, giá trị mặc định không
 * ghi ra, nên một đường dẫn chỉ mang đúng điều khác mặc định.
 */

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v : undefined;

const offsetOf = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Chỉ giữ khoá có giá trị: `{ q: undefined }` không thành `?q=` */
const defined = <T extends Record<string, unknown>>(o: T): Defined<T> =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Defined<T>;

/** Đặt hay bỏ MỘT tham số của URL, giữ nguyên các tham số khác (`undefined` là bỏ) */
export function setParam<
  S extends Record<string, unknown>,
  K extends keyof S & string,
>(prev: S, key: K, value: S[K] | undefined): S {
  const { [key]: _old, ...rest } = prev;
  return (value === undefined ? rest : { ...rest, [key]: value }) as S;
}

/** Thứ tự đọc từ URL, hay thứ tự mặc định của bảng */
function sortOf<K extends string>(
  raw: unknown,
  keys: readonly K[],
  fallback: Sort<K>,
): SortValue<K> | undefined {
  const sort = parseSort(raw, keys);
  return sort === undefined ||
    (sort.key === fallback.key && sort.dir === fallback.dir)
    ? undefined
    : `${sort.key}.${sort.dir}`;
}

// ------------------------------------------------------------------ job lỗi

/**
 * [Plan #58 UX-28] "Dọn chưa hết" đứng ĐẦU: tài nguyên còn trên cloud của khách, có thể đang tốn tiền. Tab mặc định
 * tuỳ số liệu (`defaultJobState`), nên trạng thái đã chọn luôn ghi lên URL.
 */
export const ADMIN_JOB_STATES = [
  "COMPENSATION_FAILED",
  "FAILED",
  "CANCEL_REQUESTED",
] as const;
export type AdminJobState = (typeof ADMIN_JOB_STATES)[number];

/** Số job của mỗi tab, từ `GET /admin/overview` (đã có trong cache của khung) */
export const jobCounts = (
  o: AdminOverviewWire,
): Record<AdminJobState, number> => ({
  COMPENSATION_FAILED: o.jobs.compensationFailed,
  FAILED: o.jobs.failed,
  CANCEL_REQUESTED: o.jobs.cancelRequested,
});

/** Còn job dọn chưa hết thì mở tab đó; không thì tab thất bại */
export const defaultJobState = (
  counts: Record<AdminJobState, number> | undefined,
): AdminJobState =>
  counts !== undefined && counts.COMPENSATION_FAILED > 0
    ? "COMPENSATION_FAILED"
    : "FAILED";

export const adminJobsSearch = (
  s: Record<string, unknown>,
): { state?: AdminJobState; offset?: number; project?: string } =>
  defined({
    state: ADMIN_JOB_STATES.find((v) => v === s.state),
    offset: offsetOf(s.offset),
    project: str(s.project),
  });

// ------------------------------------------------------------------ project

export const ADMIN_PROJECT_STATUSES = [
  "DRAFT",
  "PROVISIONING",
  "ACTIVE",
  "ERROR",
  "DELETED",
] as const;
export type AdminProjectStatus = (typeof ADMIN_PROJECT_STATUSES)[number];

/** Bảng theo trang: máy chủ sắp theo ngày tạo, mới nhất trước */
export const CREATED_SORTS = ["created"] as const;
export const CREATED_DEFAULT: Sort<"created"> = {
  key: "created",
  dir: "desc",
};

export const adminProjectsSearch = (
  s: Record<string, unknown>,
): {
  status?: AdminProjectStatus;
  q?: string;
  sort?: SortValue<"created">;
  offset?: number;
  project?: string;
} =>
  defined({
    status: ADMIN_PROJECT_STATUSES.find((v) => v === s.status),
    q: str(s.q),
    sort: sortOf(s.sort, CREATED_SORTS, CREATED_DEFAULT),
    offset: offsetOf(s.offset),
    project: str(s.project),
  });

// ------------------------------------------------------------------ người dùng

export const ADMIN_ROLES = [
  "PLATFORM_ADMIN",
  "USER",
] as const satisfies readonly AdminUserWire["platformRole"][];
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const adminUsersSearch = (
  s: Record<string, unknown>,
): {
  q?: string;
  role?: AdminRole;
  sort?: SortValue<"created">;
  offset?: number;
} =>
  defined({
    q: str(s.q),
    role: ADMIN_ROLES.find((v) => v === s.role),
    sort: sortOf(s.sort, CREATED_SORTS, CREATED_DEFAULT),
    offset: offsetOf(s.offset),
  });

// ------------------------------------------------------------------ tài nguyên mồ côi, credential

/** [Plan #58 UX-33] Đắt nhất trước: tiền đang mất là thứ người vận hành cần thấy đầu tiên */
export const ORPHAN_SORTS = ["cost", "since"] as const;
export type OrphanSortKey = (typeof ORPHAN_SORTS)[number];
export const ORPHAN_DEFAULT: Sort<OrphanSortKey> = { key: "cost", dir: "desc" };

export const adminOrphansSearch = (
  s: Record<string, unknown>,
): { sort?: SortValue<OrphanSortKey>; project?: string } =>
  defined({
    sort: sortOf(s.sort, ORPHAN_SORTS, ORPHAN_DEFAULT),
    project: str(s.project),
  });

export const CREDENTIAL_SORTS = ["created", "validated"] as const;
export type CredentialSortKey = (typeof CREDENTIAL_SORTS)[number];
export const CREDENTIAL_DEFAULT: Sort<CredentialSortKey> = {
  key: "created",
  dir: "desc",
};

export const adminCredentialsSearch = (
  s: Record<string, unknown>,
): { sort?: SortValue<CredentialSortKey>; project?: string } =>
  defined({
    sort: sortOf(s.sort, CREDENTIAL_SORTS, CREDENTIAL_DEFAULT),
    project: str(s.project),
  });
