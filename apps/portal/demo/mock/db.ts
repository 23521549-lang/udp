import type { BuildSettings } from "@udp/shared-types/build";
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
  GrantableProjectRoleWire,
  JobDetailWire,
  ProjectClusterWire,
  ProjectDomainWire,
  ProjectInvitationWire,
  ProvisionPreviewWire,
  PublicEnvironmentWire,
  PublicMemberWire,
  PublicProjectWire,
  PublicUserWire,
  RolloutDetailWire,
  RuleWire,
  SdkKeyWire,
  SegmentDetailWire,
  TeamInvitationWire,
  TeamMemberWire,
} from "@udp/shared-types/wire";
import type { DemoSetup } from "./persona";

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
  /** Credential đã bị thay (xoay khoá, đổi cách xác thực): trang Credential của quản trị hiện "Không dùng" */
  retiredClouds: RetiredCloud[];
  cost: CostWire | null;
  preview: ProvisionPreviewWire;
  cicd: CicdStatusWire | null;
  /**
   * Người đang xem KHÔNG vào được project — không là thành viên, không ở nhóm nào có quyền — nên chỉ trang quản
   * trị thấy. [Plan #55] Tính lại bằng `refreshMyAccess` sau mọi thay đổi nhóm hay quyền của nhóm.
   */
  adminOnly: boolean;
  /** [Plan #55] Nhóm có quyền trên project */
  teamGrants: TeamGrant[];
  /** [Plan #55] Lời mời đang chờ vào project */
  invitations: ProjectInvitationWire[];
  /** [Plan #61] Cài đặt build đã lưu — vắng là mặc định (như `projects.build_settings` NULL) */
  build?: BuildSettings;
}

export interface RetiredCloud {
  id: string;
  cloud: CloudCredentialWire;
}

/** [Plan #55] Một nhóm có vai trên một project — không bao giờ OWNER */
export interface TeamGrant {
  teamId: string;
  projectRole: GrantableProjectRoleWire;
  createdAt: string;
}

/** [Plan #55] Nhóm và lời mời đang chờ của nó */
export interface TeamRecord {
  id: string;
  name: string;
  createdAt: string;
  members: TeamMemberWire[];
  invitations: TeamInvitationWire[];
}

/**
 * [Plan #55] Token của lời mời mà bản xem thử còn nhớ — như máy chủ thật chỉ giữ hash, đây chỉ có token của lời
 * mời tạo trong phiên xem, cộng MỘT lời mời mẫu mở được từ màn hình (`DEMO_INVITE_TOKEN`).
 */
export interface InvitationToken {
  token: string;
  invitationId: string;
  kind: "PROJECT" | "TEAM";
  targetId: string;
}

export interface Db {
  me: PublicUserWire;
  signedIn: boolean;
  users: AdminUserWire[];
  projects: ProjectRecord[];
  teams: TeamRecord[];
  invitationTokens: InvitationToken[];
  configVersion: number;
  /** Người đang xem và tình huống nền tảng mà dải "Bản xem thử" chọn */
  demo: DemoSetup;
}
