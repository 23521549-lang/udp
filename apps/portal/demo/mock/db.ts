import type {
  AdminUserWire,
  AuditEntryWire,
  CicdStatusWire,
  CloudCredentialWire,
  CostWire,
  DeploymentLogsWire,
  DeploymentWire,
  DomainDriftWire,
  DomainVersionsWire,
  FlagDetailWire,
  JobDetailWire,
  ProjectClusterWire,
  ProjectDomainWire,
  ProvisionPreviewWire,
  PublicEnvironmentWire,
  PublicMemberWire,
  PublicProjectWire,
  PublicUserWire,
  RolloutDetailWire,
  RuleWire,
  SdkKeyWire,
  SegmentDetailWire,
} from "@udp/shared-types/wire";

/**
 * Trạng thái của bản xem thử — "database" sống trong trang. Mỗi route của lớp giả lập đọc và ghi ở đây, nên thao
 * tác trên Portal (bật flag, thêm rule, promote rollout) hiện lại ở mọi màn hình cho tới khi tải lại trang.
 */

export interface FlagRecord {
  detail: FlagDetailWire;
  /** Rule theo id environment */
  rules: Record<string, RuleWire[]>;
  rulesUpdatedAt: Record<string, string>;
  /** Số lượt đánh giá mỗi ngày trong 30 ngày, cũ → mới, theo id environment */
  daily: Record<string, number[]>;
  /** Tỉ lệ variant quan sát được (key → phần) theo id environment */
  mix: Record<string, Record<string, number>>;
  lastEvaluatedAt: string | null;
  stale?: "UNUSED" | "SETTLED" | "STALE_DRAFT";
}

export interface JobRecord {
  detail: JobDetailWire;
  /** Mô phỏng một job đang chạy: tiến theo thời gian kể từ lúc mở trang */
  live?: LiveJob;
}

export interface LiveJob {
  /** Giây kể từ lúc mở trang mà job vào mỗi trạng thái */
  schedule: { state: JobDetailWire["job"]["state"]; at: number }[];
  /** Tài nguyên theo pha — hiện dần khi job tới pha đó */
  plan: JobDetailWire["resources"];
  domains: JobDetailWire["domains"];
}

export interface LiveRollout {
  /** Mốc (ms) mà `from` đúng — lúc mở trang, lúc tạo, hay lúc tiếp tục sau tạm dừng */
  startedAt: number;
  /** Phần trăm ở `startedAt`, bước tăng, nhịp (giây) và trần của mô phỏng */
  from: number;
  step: number;
  everySeconds: number;
  upTo: number;
  flagId: string;
  ruleId: string;
  targetVariantId: string;
  otherVariantId: string;
}

export interface DomainState {
  domainSetVersion: number;
  domains: ProjectDomainWire[];
  preferences: { capabilityId: string; providerToolId: string }[];
  drift: Record<string, DomainDriftWire>;
  versions: Record<string, DomainVersionsWire>;
}

export interface ProjectRecord {
  project: PublicProjectWire;
  environments: PublicEnvironmentWire[];
  cluster: ProjectClusterWire | null;
  members: PublicMemberWire[];
  audit: AuditEntryWire[];
  sdkKeys: Record<string, SdkKeyWire[]>;
  flags: FlagRecord[];
  segments: SegmentDetailWire[];
  rollouts: RolloutDetailWire[];
  liveRollouts: Record<string, LiveRollout>;
  deployments: Record<string, DeploymentWire[]>;
  deploymentLogs: Record<string, DeploymentLogsWire["events"]>;
  domains: DomainState;
  jobs: JobRecord[];
  cloud: CloudCredentialWire | null;
  cost: CostWire | null;
  preview: ProvisionPreviewWire;
  cicd: CicdStatusWire | null;
  /** Project mà người đang xem KHÔNG là thành viên — chỉ trang quản trị thấy */
  adminOnly: boolean;
}

export interface Db {
  me: PublicUserWire;
  signedIn: boolean;
  users: AdminUserWire[];
  projects: ProjectRecord[];
  configVersion: number;
}
