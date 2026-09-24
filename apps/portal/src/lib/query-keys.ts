/**
 * MỌI query key của Portal — một nơi duy nhất (§10.14).
 *
 * §10.12 cảnh báo bằng chữ: key của mọi query thuộc phạm vi environment phải chứa
 * `envId`, nếu không dữ liệu của `dev` bị cache lẫn sang `prod`. Một cảnh báo bằng chữ bị
 * quên ở màn hình thứ mười, nên nó thành hai phép kiểm máy (bất biến I38,
 * `tests/i38-query-keys.test.ts`):
 *
 * 1. Mỗi key dưới đây khai phạm vi của nó (`ENV_SCOPED` hoặc `NOT_ENV_SCOPED`), và key
 *    phạm vi env PHẢI nhận `envId` — kiểm bằng cách gọi thật và tìm giá trị đã truyền.
 * 2. Không tệp nào khác trong `src/` được viết `queryKey: [` trần — phải đi qua đây.
 *
 * Miễn trừ phải KHAI, không phải bỏ sót: `flagEnvs` (ma trận hiện MỌI env cùng lúc),
 * `segments`/`segment` (segment thuộc PROJECT, một bản cho mọi env — §2.2).
 */
export const qk = {
  me: () => ["me"] as const,
  projects: () => ["projects"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  members: (projectId: string) => ["members", projectId] as const,
  audit: (projectId: string, filters: Record<string, string | undefined>) =>
    ["audit", projectId, filters] as const,
  sdkKeys: (projectId: string, envId: string) =>
    ["sdkKeys", projectId, envId] as const,

  flags: (projectId: string, envId: string, include: "stats" | "none") =>
    ["flags", projectId, envId, include] as const,
  flag: (projectId: string, flagId: string, envId: string) =>
    ["flag", projectId, flagId, envId] as const,
  flagRules: (projectId: string, flagId: string, envId: string) =>
    ["flagRules", projectId, flagId, envId] as const,
  flagEnvs: (projectId: string, flagId: string) =>
    ["flagEnvs", projectId, flagId] as const,
  flagStats: (
    projectId: string,
    flagId: string,
    envId: string,
    days: number,
    granularity: string,
    tz: string,
  ) => ["flagStats", projectId, flagId, envId, days, granularity, tz] as const,
  staleFlags: (projectId: string, category: string | undefined) =>
    ["staleFlags", projectId, category ?? "all"] as const,

  segments: (projectId: string) => ["segments", projectId] as const,
  segment: (projectId: string, segmentId: string) =>
    ["segment", projectId, segmentId] as const,

  rollouts: (projectId: string, envId: string) =>
    ["rollouts", projectId, envId] as const,
  rollout: (projectId: string, rolloutId: string) =>
    ["rollout", projectId, rolloutId] as const,
  activeRollouts: (projectId: string) =>
    ["rollouts-active", projectId] as const,
} as const;

export type QueryKeyName = keyof typeof qk;

/** Dữ liệu thuộc về MỘT environment — key phải mang `envId` */
export const ENV_SCOPED = [
  "sdkKeys",
  "flags",
  "flag",
  "flagRules",
  "flagStats",
  "rollouts",
] as const satisfies readonly QueryKeyName[];

/**
 * Không thuộc phạm vi env — mỗi dòng một lý do.
 *
 * `rollout`: id rollout đã gắn đúng một env (session có `environment_id`), nên key theo
 * id không thể lẫn giữa env. `activeRollouts`: watcher của cả project (§10.9).
 */
export const NOT_ENV_SCOPED = {
  me: "người dùng hiện tại",
  projects: "danh sách project",
  project: "project và danh sách env của nó",
  members: "thành viên thuộc project",
  audit: "nhật ký của project, lọc env bằng tham số riêng",
  flagEnvs: "ma trận flag × env: cố ý hiện MỌI env (§10.14)",
  staleFlags: "Cleanup Center gộp mọi env (§6.7)",
  segments: "segment thuộc project, một bản cho mọi env (§2.2)",
  segment: "segment thuộc project (§2.2)",
  rollout: "id rollout đã gắn đúng một env",
  activeRollouts: "watcher auto-rollback của cả project (§10.9)",
} as const satisfies Partial<Record<QueryKeyName, string>>;

/**
 * TIỀN TỐ để invalidate mọi biến thể của một họ key (mọi env, mọi tham số) — dùng khi một
 * thay đổi chạm tới tất cả, ví dụ bật flag ở một env làm đổi danh sách của env đó VÀ ma
 * trận. Tiền tố không dùng để ĐỌC, nên không thuộc I38.
 */
export const qkPrefix = {
  flagsOf: (projectId: string) => ["flags", projectId] as const,
  flagOf: (projectId: string, flagId: string) =>
    ["flag", projectId, flagId] as const,
  staleFlagsOf: (projectId: string) => ["staleFlags", projectId] as const,
} as const;
