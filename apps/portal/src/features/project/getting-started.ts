import type { ArchitectureWire, SdkKeyWire } from "@udp/shared-types/wire";

/**
 * [Plan #58 UX-12] Danh sách việc "Bắt đầu" của một project mới — THUẦN, test được không cần DOM. Mỗi việc tự đánh
 * dấu từ dữ liệu trang Tổng quan đọc được (GOV.UK task list: làm thứ tự nào cũng được, mỗi việc dẫn tới chỗ làm nó).
 * `undefined` = chưa biết (đang tải hay lỗi): thẻ không đánh dấu "Xong" khi chưa chắc.
 */
export const START_TASKS = [
  "sdkKey",
  "flag",
  "cloud",
  "domains",
  "deploy",
] as const;
export type StartTask = (typeof START_TASKS)[number];
export type StartFacts = Record<StartTask, boolean | undefined>;

export interface StartInput {
  /** Danh sách key của TỪNG environment; một phần tử `undefined` = env đó chưa tải xong */
  keysByEnv: readonly (readonly SdkKeyWire[] | undefined)[];
  /** Tổng số flag của project (mọi env thấy cùng một bộ flag) */
  flagTotal: number | undefined;
  architecture: ArchitectureWire | undefined;
  /** Deploy gần nhất của TỪNG environment */
  latestByEnv: readonly ({ deployment: object | null } | undefined)[];
}

/** "Có ở ÍT NHẤT một env" — biết ngay khi một env có; chỉ kết luận "không" khi mọi env đã trả lời */
function anyOf<T>(
  items: readonly (T | undefined)[],
  hit: (item: T) => boolean,
): boolean | undefined {
  if (items.some((i) => i !== undefined && hit(i))) return true;
  return items.every((i) => i !== undefined) ? false : undefined;
}

export function startFacts(input: StartInput): StartFacts {
  const arch = input.architecture;
  return {
    sdkKey: anyOf(input.keysByEnv, (keys) =>
      keys.some((k) => k.status === "active"),
    ),
    flag: input.flagTotal === undefined ? undefined : input.flagTotal > 0,
    cloud: arch === undefined ? undefined : arch.cloud !== null,
    domains: arch === undefined ? undefined : arch.tools.length > 0,
    deploy: anyOf(input.latestByEnv, (l) => l.deployment !== null),
  };
}

export const doneCount = (facts: StartFacts): number =>
  START_TASKS.filter((t) => facts[t] === true).length;

export const allDone = (facts: StartFacts): boolean =>
  doneCount(facts) === START_TASKS.length;

/** Ẩn thẻ theo project (người dùng bấm Ẩn, hoặc đã xong hết): sở thích hiển thị, localStorage là đủ */
const hiddenKey = (projectId: string): string =>
  `udp_start_hidden:${projectId}`;

export function isStartHidden(projectId: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(projectId)) === "1";
  } catch {
    return false;
  }
}

export function hideStart(projectId: string): void {
  try {
    localStorage.setItem(hiddenKey(projectId), "1");
  } catch {
    // localStorage bị chặn: thẻ chỉ ẩn trong phiên này
  }
}
