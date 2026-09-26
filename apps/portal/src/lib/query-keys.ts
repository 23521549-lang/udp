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
  /** [Plan #41] Một trang danh sách project */
  projects: (offset: number) => ["projects", offset] as const,
  project: (projectId: string) => ["project", projectId] as const,
  members: (projectId: string) => ["members", projectId] as const,
  audit: (projectId: string, filters: Record<string, string | undefined>) =>
    ["audit", projectId, filters] as const,
  sdkKeys: (projectId: string, envId: string) =>
    ["sdkKeys", projectId, envId] as const,

  /** [Plan #41] `page` trong key: mỗi trang, mỗi lần tìm là một mục cache riêng */
  flags: (
    projectId: string,
    envId: string,
    include: "stats" | "none" | "count",
    page: Readonly<Record<string, string | number | boolean | undefined>>,
  ) => ["flags", projectId, envId, include, page] as const,
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

  deployments: (projectId: string, envId: string) =>
    ["deployments", projectId, envId] as const,
  /** §10.14: `range` trong key — đổi khoảng mà số không đổi là key thiếu `range` */
  dora: (projectId: string, envId: string, days: number) =>
    ["dora", projectId, envId, days] as const,

  /** §10.14: `["catalog"]`, staleTime vô hạn — registry chỉ đổi khi triển khai lại */
  catalog: () => ["catalog"] as const,
  domains: (projectId: string) => ["domains", projectId] as const,
  domain: (projectId: string, type: string) =>
    ["domain", projectId, type] as const,
  domainDrift: (projectId: string, type: string) =>
    ["drift", projectId, type] as const,
  /** §10.12 kiểm trực tiếp: khoá theo nội dung trạng thái đích đã chuẩn hoá */
  domainValidation: (projectId: string, target: string) =>
    ["domainValidation", projectId, target] as const,
  /** Plan #36: webhook CI/CD của project — đường, secret đã sinh chưa (không bao giờ giá trị) */
  cicd: (projectId: string) => ["cicd", projectId] as const,
  pipelineTemplate: (projectId: string) =>
    ["pipelineTemplate", projectId] as const,
  /** Plan #38: chi phí THỰC của project; `days` trong key — đổi cửa sổ mà số không đổi là thiếu nó */
  cost: (projectId: string, days: number) => ["cost", projectId, days] as const,
  cloud: (projectId: string) => ["cloud", projectId] as const,
  cloudSetup: (projectId: string, provider: string) =>
    ["cloudSetup", projectId, provider] as const,
  provisionPreview: (projectId: string) =>
    ["provisionPreview", projectId] as const,
  jobs: (projectId: string) => ["jobs", projectId] as const,
  job: (projectId: string, jobId: string) => ["job", projectId, jobId] as const,

  adminUsers: (search: string) => ["admin", "users", search] as const,
  adminProjects: (status: string) => ["admin", "projects", status] as const,
  adminCredentials: () => ["admin", "credentials"] as const,
  adminJobs: (state: string) => ["admin", "jobs", state] as const,
  /** §10.14: `["orphans"]` — invalidate khi dọn một tài nguyên */
  adminOrphans: () => ["admin", "orphans"] as const,
  adminSystem: () => ["admin", "system"] as const,
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
  "deployments",
  "dora",
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
  catalog: "danh mục của cả hệ thống, dựng từ registry (§5.3)",
  domains: "domain cấu hình theo project; binding theo env tới sau job (§2.2)",
  domain: "một domain của project",
  domainDrift: "drift của một domain, quét ở phạm vi cluster",
  domainValidation: "kiểm trạng thái đích của cả project",
  cicd: "webhook CI/CD của project; environment nằm trong thân webhook (§8.3)",
  pipelineTemplate: "một pipeline cho MỌI env của project, env chọn theo nhánh",
  cost: "chi phí cả project, chia theo environment ngay trong response",
  cloud: "credential cloud thuộc project, một bản cho mọi env (§4.3)",
  cloudSetup: "dữ liệu setup theo project và cloud, không theo env",
  provisionPreview: "hạ tầng của cả project: một cluster cho mọi env (§8.1)",
  jobs: "job provisioning thuộc project, không theo env",
  job: "một job provisioning dựng hạ tầng cho mọi env",
  adminUsers: "toàn hệ thống, không thuộc project nào",
  adminProjects: "toàn hệ thống",
  adminCredentials: "toàn hệ thống",
  adminJobs: "toàn hệ thống",
  adminOrphans: "toàn hệ thống",
  adminSystem: "toàn hệ thống",
} as const satisfies Partial<Record<QueryKeyName, string>>;

/**
 * TIỀN TỐ để invalidate mọi biến thể của một họ key (mọi env, mọi tham số) — dùng khi một
 * thay đổi chạm tới tất cả, ví dụ bật flag ở một env làm đổi danh sách của env đó VÀ ma
 * trận. Tiền tố không dùng để ĐỌC, nên không thuộc I38.
 */
export const qkPrefix = {
  /** [Plan #41] Mọi trang danh sách project — tạo, xoá, đổi chủ làm lệch mọi trang */
  projectsAll: () => ["projects"] as const,
  flagsOf: (projectId: string) => ["flags", projectId] as const,
  flagOf: (projectId: string, flagId: string) =>
    ["flag", projectId, flagId] as const,
  /** [Plan #40] Ma trận env của MỌI flag — thêm/xoá environment đổi số cột */
  flagEnvsOf: (projectId: string) => ["flagEnvs", projectId] as const,
  staleFlagsOf: (projectId: string) => ["staleFlags", projectId] as const,
  /**
   * [Plan #41] MỌI key đọc cấu hình flag/segment của project — thứ đổi khi `config_version` của
   * một environment tiến (luồng `flag_changed`, §10.14). Không gồm số đếm telemetry.
   */
  configOf: (projectId: string) =>
    [
      ["flags", projectId],
      ["flag", projectId],
      ["flagRules", projectId],
      ["flagEnvs", projectId],
      ["staleFlags", projectId],
      ["segments", projectId],
      ["segment", projectId],
    ] as const,
  adminUsersAll: () => ["admin", "users"] as const,
} as const;
