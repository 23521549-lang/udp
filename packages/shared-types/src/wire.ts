import { z } from "zod";
import { readAttributeConditionSchema, RULE_TYPES } from "./condition.js";
import { flagServeUnion } from "./evaluation.js";
import { FLAG_TYPES } from "./flag-value.js";
import {
  flagStatsResponseSchema,
  staleFlagsResponseSchema,
} from "./flag-stats.js";
import {
  DECISIONS,
  decisionDetailSchema,
  INTENT_ACTIONS,
  metricQueriesSchema,
  trafficMatchSchema,
} from "./rollout.js";
import {
  cloudAuthKindSchema,
  cloudProviderSchema,
  cloudRegionSchema,
} from "./cloud-api.js";
import { capabilityPreferenceSchema } from "./domain-api.js";
import { PROVISION_BLOCKERS } from "./provisioning-api.js";

/**
 * [v4.11] Hình dạng TRÊN DÂY của những response mà Portal tiêu thụ.
 *
 * "Trên dây" là điểm của cả tệp, và nó sửa một lời nói dối có thật: `PublicProject` của
 * Service 1 khai `createdAt: Date` và `resourceQuota: unknown`, nhưng `res.json()` biến
 * `Date` thành chuỗi ISO. Một client dùng lại interface đó sẽ gọi `createdAt.getTime()`
 * và nổ lúc chạy trong khi `tsc` xanh; còn `unknown` thì không có hợp đồng nào để kiểm.
 *
 * **Đã đếm (24/09/2026): chỉ HAI module nói dối.** `flag.types.ts`, `rollout.types.ts`,
 * `segment.types.ts` và `sdk-key.types.ts` đã dùng `string` cho mọi mốc thời gian, nên
 * schema của chúng là bản soi gương thẳng. Chỗ phải sửa là `project` và `member` (cộng
 * `audit`, vốn trả `occurredAt: Date`).
 *
 * **Mọi object dùng `.strict()`.** Zod mặc định **strip** khoá lạ, nên nếu không strict
 * thì một trường nội bộ lỡ lọt vào `select` của repository sẽ đi thẳng lên dây và không
 * nơi nào đỏ — kể cả test của Portal, vì handler giả cũng parse bằng chính schema này.
 *
 * Server serialize **qua** những schema này (`sendJson` của `@udp/http`), nên response
 * lệch hình là một test đỏ của server chứ không phải một màn hình trắng ở client.
 *
 * **Tên theo response, không theo thực thể.** Mỗi `*ResponseWire` là ĐÚNG phong bì mà
 * một route trả (`{ project, environments }`, `{ member }`…). Một schema thực thể dùng
 * chung cho hai phong bì khác nhau là cách để schema và route lệch nhau mà không ai thấy.
 *
 * **Tệp này chỉ import zod và các module anh em không phụ thuộc Node** — Portal chạy nó
 * trong trình duyệt.
 */

/** ISO 8601 có offset — `JSON.stringify(new Date())` cho dạng `...Z`, hợp lệ */
const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

/** Tham chiếu gọn tới một environment — cùng hình ở flag, rollout, segment */
const envRefWire = z
  .object({ id: uuid, name: z.string(), isProduction: z.boolean() })
  .strict();

// ------------------------------------------------------------- auth

export const platformRoleWire = z.enum(["USER", "PLATFORM_ADMIN"]);

export const publicUserWire = z
  .object({
    id: uuid,
    email: z.string().email(),
    name: z.string(),
    platformRole: platformRoleWire,
  })
  .strict();

/** `POST /auth/register|login|refresh` */
export const authSessionResponseWire = z
  .object({ user: publicUserWire, csrfToken: z.string().min(1) })
  .strict();

/** `GET /auth/me` */
export const meResponseWire = z.object({ user: publicUserWire }).strict();

// ------------------------------------------------------------- project

export const projectRoleWire = z.enum([
  "OWNER",
  "MAINTAINER",
  "DEVELOPER",
  "VIEWER",
]);

export const projectStatusWire = z.enum([
  "DRAFT",
  "PROVISIONING",
  "ACTIVE",
  "ERROR",
  "DELETED",
]);

export const publicEnvironmentWire = z
  .object({
    id: uuid,
    name: z.string(),
    k8sNamespace: z.string(),
    isProduction: z.boolean(),
    rank: z.number().int(),
    autoDeploy: z.boolean(),
  })
  .strict();

/**
 * `resourceQuota` là một OBJECT CÓ HÌNH, không phải `unknown`.
 *
 * Màn hình Quota của Portal sửa đúng những trường này; để `unknown` thì form đó không có
 * gì để dựng và không có gì để kiểm. Mọi trường đều tuỳ chọn vì hàng cũ trong database
 * có thể thiếu một trường — nhưng khoá lạ thì không được, nhờ `.strict()`.
 */
export const resourceQuotaWire = z
  .object({
    maxNodes: z.number().int().nonnegative().optional(),
    maxNodeSize: z.string().optional(),
    maxDatabases: z.number().int().nonnegative().optional(),
    maxStorageGb: z.number().int().nonnegative().optional(),
    maxLoadBalancers: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * `myRole` do SERVER tính — vai HIỆU LỰC của người đang gọi.
 *
 * Nó là kiến thức của server: phương án để client suy từ `GET /projects/:id/members` tốn
 * thêm một request mỗi lần mở project, đòi quyền đọc danh sách thành viên, và đẩy một
 * quyết định phân quyền vào trình duyệt. Client dùng nó để **ẩn hành động**; chặn thật
 * vẫn ở backend, nên ẩn nút không bao giờ là lớp bảo vệ duy nhất.
 */
export const publicProjectWire = z
  .object({
    id: uuid,
    name: z.string(),
    ownerId: uuid,
    creationMode: z.enum(["CREATE_NEW", "IMPORT_EXISTING"]),
    languageRuntime: z.string(),
    repoUrl: z.string().nullable(),
    status: projectStatusWire,
    resourceQuota: resourceQuotaWire,
    expiresAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    myRole: projectRoleWire,
  })
  .strict();

/** `GET /projects` */
/** `GET /projects` — [v4.11, Plan #41] theo trang, `total` là mọi project của người gọi */
export const projectListResponseWire = z
  .object({
    projects: z.array(publicProjectWire),
    total: z.number().int().nonnegative(),
  })
  .strict();

/**
 * [v4.11, Plan #45] Cluster của project (§10.6 ClusterInfoCard) — ĐỊA CHỈ, không quyền vào: không
 * `caData`, không token (ADR-06 không lưu token nào). `null` khi project chưa có cluster.
 */
export const projectClusterWire = z
  .object({
    clusterId: z.string(),
    apiEndpoint: z.string(),
    provider: z.string(),
    region: z.string(),
  })
  .strict();

/** `POST /projects` (201) và `GET /projects/:id` — cùng một phong bì (§8.1) */
export const projectDetailResponseWire = z
  .object({
    project: publicProjectWire,
    environments: z.array(publicEnvironmentWire),
    /** [v4.11, Plan #45] Ở phong bì CHI TIẾT, không ở hàng danh sách (D-P33) */
    cluster: projectClusterWire.nullable(),
  })
  .strict();

/** `PATCH /projects/:id/quota|ttl` */
export const projectResponseWire = z
  .object({ project: publicProjectWire })
  .strict();

// ------------------------------------------------------------- member

export const publicMemberWire = z
  .object({
    userId: uuid,
    projectRole: projectRoleWire,
    createdAt: isoDateTime,
    user: z
      .object({ id: uuid, email: z.string().email(), name: z.string() })
      .strict(),
  })
  .strict();

/** `GET /projects/:id/members` */
export const memberListResponseWire = z
  .object({ members: z.array(publicMemberWire) })
  .strict();

/** `POST /members` (201), `PATCH /members/:userId`, `POST /transfer-ownership` */
export const memberResponseWire = z
  .object({ member: publicMemberWire })
  .strict();

// ------------------------------------------------------------- [v4.11, Plan #55] nhóm và lời mời

/** Vai trong một nhóm: OWNER quản lý nhóm, MEMBER chỉ thuộc nhóm */
export const teamRoleWire = z.enum(["OWNER", "MEMBER"]);

/**
 * Vai cấp được cho một nhóm, hay qua lời mời vào project — KHÔNG BAO GIỜ `OWNER`: chủ sở hữu luôn là một người,
 * đổi qua `POST /transfer-ownership` (database giữ bằng CHECK).
 */
export const grantableProjectRoleWire = z.enum([
  "MAINTAINER",
  "DEVELOPER",
  "VIEWER",
]);

/** Người trên dây ở mọi chỗ của Plan #55 — cùng hình với `user` của thành viên project */
const personWire = z
  .object({ id: uuid, email: z.string().email(), name: z.string() })
  .strict();

/**
 * Token của lời mời: tiền tố cố định (công cụ quét bí mật nhận ra) + 32 byte ngẫu nhiên base64url. Chỉ xuất
 * hiện MỘT lần — trong response tạo lời mời; database chỉ giữ SHA-256 của nó.
 */
export const INVITATION_TOKEN_PATTERN = /^udp_inv_[A-Za-z0-9_-]{43}$/;
export const invitationTokenWire = z.string().regex(INVITATION_TOKEN_PATTERN);

const invitationBase = {
  id: uuid,
  email: z.string().email(),
  invitedBy: personWire,
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
};

/** Lời mời đang chờ vào project — không bao giờ mang token */
export const projectInvitationWire = z
  .object({ ...invitationBase, projectRole: grantableProjectRoleWire })
  .strict();

/** Lời mời đang chờ vào nhóm — không bao giờ mang token */
export const teamInvitationWire = z
  .object({ ...invitationBase, teamRole: teamRoleWire })
  .strict();

/** `GET /projects/:id/invitations` */
export const projectInvitationListResponseWire = z
  .object({ invitations: z.array(projectInvitationWire) })
  .strict();

/** `POST /projects/:id/invitations` (201) — token hiện đúng lần này */
export const projectInvitationCreatedResponseWire = z
  .object({ invitation: projectInvitationWire, token: invitationTokenWire })
  .strict();

/** `GET /teams/:teamId/invitations` */
export const teamInvitationListResponseWire = z
  .object({ invitations: z.array(teamInvitationWire) })
  .strict();

/** `POST /teams/:teamId/invitations` (201) — token hiện đúng lần này */
export const teamInvitationCreatedResponseWire = z
  .object({ invitation: teamInvitationWire, token: invitationTokenWire })
  .strict();

/** Lời mời dẫn tới đâu, với vai gì */
export const invitationTargetWire = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("PROJECT"),
      id: uuid,
      name: z.string(),
      projectRole: grantableProjectRoleWire,
    })
    .strict(),
  z
    .object({
      kind: z.literal("TEAM"),
      id: uuid,
      name: z.string(),
      teamRole: teamRoleWire,
    })
    .strict(),
]);

/**
 * `POST /invitations/lookup` — thứ người cầm đường dẫn thấy, TRƯỚC khi đăng nhập: mời vào đâu, vai gì, ai mời,
 * dành cho email nào (để họ đăng nhập đúng tài khoản). Người mời chỉ lộ TÊN.
 */
export const invitationLookupResponseWire = z
  .object({
    invitation: z
      .object({
        target: invitationTargetWire,
        email: z.string().email(),
        invitedBy: z.object({ name: z.string() }).strict(),
        expiresAt: isoDateTime,
      })
      .strict(),
  })
  .strict();

/** `POST /invitations/accept` — Portal đi thẳng tới project hay nhóm vừa vào */
export const invitationAcceptedResponseWire = z
  .object({ target: invitationTargetWire })
  .strict();

/** Một dòng của "Nhóm của tôi" */
export const teamSummaryWire = z
  .object({
    id: uuid,
    name: z.string(),
    myRole: teamRoleWire,
    memberCount: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
    createdAt: isoDateTime,
  })
  .strict();

/** `GET /teams` */
export const teamListResponseWire = z
  .object({ teams: z.array(teamSummaryWire) })
  .strict();

export const teamMemberWire = z
  .object({
    userId: uuid,
    teamRole: teamRoleWire,
    createdAt: isoDateTime,
    user: personWire,
  })
  .strict();

/** Project mà nhóm được cấp quyền (project đã xoá không hiện) */
export const teamProjectWire = z
  .object({ id: uuid, name: z.string(), projectRole: grantableProjectRoleWire })
  .strict();

export const teamDetailWire = z
  .object({
    id: uuid,
    name: z.string(),
    myRole: teamRoleWire,
    createdAt: isoDateTime,
    members: z.array(teamMemberWire),
    projects: z.array(teamProjectWire),
  })
  .strict();

/** `POST /teams` (201), `GET|PATCH /teams/:teamId` */
export const teamResponseWire = z.object({ team: teamDetailWire }).strict();

/** `POST /teams/:teamId/members` (201), `PATCH /teams/:teamId/members/:userId` */
export const teamMemberResponseWire = z
  .object({ member: teamMemberWire })
  .strict();

/**
 * Nhóm có quyền trên một project, KÈM danh sách người của nhóm: người xem project thấy được mọi người vào được
 * project — một nhóm không phải hộp đen che ai đang có quyền.
 */
export const projectTeamWire = z
  .object({
    teamId: uuid,
    name: z.string(),
    projectRole: grantableProjectRoleWire,
    createdAt: isoDateTime,
    members: z.array(personWire),
  })
  .strict();

/** `GET /projects/:id/teams` */
export const projectTeamListResponseWire = z
  .object({ teams: z.array(projectTeamWire) })
  .strict();

/** `POST /projects/:id/teams` (201), `PATCH /projects/:id/teams/:teamId` */
export const projectTeamResponseWire = z
  .object({ team: projectTeamWire })
  .strict();

// ------------------------------------------------------------- audit

/**
 * `before`/`after` là JSON đã qua `redact()` — hình của chúng là hình của thực thể bị
 * ghi, khác nhau theo `action`. Portal hiển thị chúng dạng diff, không đọc trường nào,
 * nên `unknown` ở đây là mô tả đúng chứ không phải lười.
 */
export const auditEntryWire = z
  .object({
    id: uuid,
    action: z.string(),
    actorType: z.enum(["USER", "SYSTEM", "SDK"]),
    actorUserId: uuid.nullable(),
    targetType: z.string(),
    targetId: z.string(),
    environmentId: uuid.nullable(),
    before: z.unknown(),
    after: z.unknown(),
    occurredAt: isoDateTime,
  })
  .strict();

/** `GET /projects/:id/audit` */
/** [v4.11, Plan #53] Theo trang: `total` là mọi dòng khớp bộ lọc */
export const auditListResponseWire = z
  .object({
    entries: z.array(auditEntryWire),
    total: z.number().int().nonnegative(),
  })
  .strict();

// ------------------------------------------------------------- SDK key

export const sdkKeyWire = z
  .object({
    id: uuid,
    environmentId: uuid,
    keyType: z.enum(["SERVER", "CLIENT"]),
    label: z.string().nullable(),
    keySuffix: z.string(),
    maskedKey: z.string(),
    status: z.enum(["active", "revoked"]),
    createdBy: z.object({ id: uuid, name: z.string() }).strict(),
    createdAt: isoDateTime,
    lastUsedAt: isoDateTime.nullable(),
    revokedAt: isoDateTime.nullable(),
  })
  .strict();

/** `GET /environments/:envId/keys` */
export const sdkKeyListResponseWire = z
  .object({ keys: z.array(sdkKeyWire) })
  .strict();

/** `POST /environments/:envId/keys` (201) — plaintext đúng MỘT lần */
export const sdkKeyCreatedResponseWire = z
  .object({ key: sdkKeyWire, secretKey: z.string().min(1) })
  .strict();

/** `DELETE /environments/:envId/keys/:keyId` */
export const sdkKeyResponseWire = z.object({ key: sdkKeyWire }).strict();

// ------------------------------------------------------------- flag

export const flagLifecycleWire = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);

export const flagEnvStateWire = z
  .object({
    environment: envRefWire,
    configId: uuid,
    isEnabled: z.boolean(),
    defaultVariantId: uuid.nullable(),
    isTracked: z.boolean(),
    ruleCount: z.number().int().nonnegative(),
    updatedAt: isoDateTime,
  })
  .strict();

export const flagVariantWire = z
  .object({ id: uuid, key: z.string(), value: z.unknown() })
  .strict();

export const flagDetailWire = z
  .object({
    id: uuid,
    key: z.string(),
    flagType: z.enum(FLAG_TYPES),
    description: z.string().nullable(),
    lifecycleStatus: flagLifecycleWire,
    stickinessAttribute: z.string(),
    defaultVariantId: uuid.nullable(),
    permanent: z.boolean(),
    activatedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    variants: z.array(flagVariantWire),
    envs: z.array(flagEnvStateWire),
  })
  .strict();

export const flagSummaryWire = z
  .object({
    id: uuid,
    key: z.string(),
    flagType: z.enum(FLAG_TYPES),
    description: z.string().nullable(),
    lifecycleStatus: flagLifecycleWire,
    activatedAt: isoDateTime.nullable(),
    updatedAt: isoDateTime,
    /** Chỉ khi truy vấn có `envId` */
    env: z
      .object({
        configId: uuid,
        isEnabled: z.boolean(),
        isTracked: z.boolean(),
        ruleCount: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** Chỉ khi `include=stats` */
    stats: z
      .object({
        evalCount7d: z.number().int().nonnegative(),
        daily14: z.array(z.number().int().nonnegative()),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `GET /flags` */
/**
 * `GET /flags` — [v4.11, Plan #41] `total` đếm theo CÙNG bộ lọc (không theo trang): Portal điều
 * hướng trang và đọc con số tổng bằng `limit=1` thay vì tải hết danh sách.
 */
export const flagListResponseWire = z
  .object({
    flags: z.array(flagSummaryWire),
    total: z.number().int().nonnegative(),
  })
  .strict();

/** `POST /flags` (201), `GET /flags/:flagId`, `PATCH /flags/:flagId` */
export const flagResponseWire = z.object({ flag: flagDetailWire }).strict();

/** `GET /flags/:flagId/envs` — Flag Env Matrix */
export const flagEnvsResponseWire = z
  .object({ envs: z.array(flagEnvStateWire) })
  .strict();

/** `GET /flags/:flagId/variants` */
export const flagVariantsResponseWire = z
  .object({ variants: z.array(flagVariantWire) })
  .strict();

/** `PATCH /flags/:flagId/envs/:envId` */
export const flagEnvResponseWire = z.object({ env: flagEnvStateWire }).strict();

/**
 * Rule như Portal đọc để SỬA rồi PUT lại. `condition` để `unknown` ở mức dây vì hình
 * của nó phụ thuộc `ruleType` — Portal parse lại bằng `readConditionSchemas[ruleType]`
 * ngay chỗ dựng form, nơi biết `ruleType`. `serve` thì có hình cố định (bản DB, theo
 * `variantId`), nên kiểm được ngay ở đây.
 */
export const ruleWire = z
  .object({
    id: uuid,
    priority: z.number().int(),
    ruleType: z.enum(RULE_TYPES),
    condition: z.unknown(),
    serve: flagServeUnion,
    description: z.string().nullable(),
  })
  .strict();

/** `GET|PUT /flags/:flagId/envs/:envId/rules` */
export const rulesResponseWire = z
  .object({ updatedAt: isoDateTime, rules: z.array(ruleWire) })
  .strict();

/**
 * [v4.11, Plan #44] `POST /flags/:flagId/promote` — rule của env ĐÍCH sau khi áp (cùng hình
 * `GET …/rules`) và diff đã áp, dựng bằng `planPromotion` của `./promote`.
 */
export const promoteResponseWire = z
  .object({
    updatedAt: isoDateTime,
    rules: z.array(ruleWire),
    diff: z.array(
      z
        .object({
          kind: z.enum(["same", "changed", "added", "removed"]),
          index: z.number().int().nonnegative(),
          ruleType: z.enum(RULE_TYPES),
          description: z.string().nullable(),
          keptId: uuid.optional(),
        })
        .strict(),
    ),
    changes: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `GET /flags/:flagId/stats` — hình của S2, nhưng mỗi env mang tên (S1 ghép). Dựng từ
 * `flagStatsResponseSchema` để hai bên không trôi khỏi nhau.
 */
const statsByEnv = flagStatsResponseSchema.shape.byEnv.element;
export const flagStatsViewResponseWire = flagStatsResponseSchema
  .extend({
    byEnv: z.array(
      statsByEnv
        .omit({ environmentId: true })
        .extend({ environment: envRefWire }),
    ),
  })
  .strict();

/** `GET /flags/stale` — S1 trả nguyên hình của S2 */
export const staleFlagsResponseWire = staleFlagsResponseSchema;

const bulkArchiveProblemWire = z
  .object({
    status: z.number().int(),
    title: z.string(),
    detail: z.string().optional(),
    code: z.string().optional(),
    resourceId: z.string().optional(),
  })
  .strict();

/** `POST /flags/bulk-archive` — lô KHÔNG nguyên tử, mỗi flag một kết quả */
export const bulkArchiveResponseWire = z
  .object({
    results: z.array(
      z.discriminatedUnion("ok", [
        z
          .object({ flagId: uuid, ok: z.literal(true), flag: flagDetailWire })
          .strict(),
        z
          .object({
            flagId: uuid,
            ok: z.literal(false),
            problem: bulkArchiveProblemWire,
          })
          .strict(),
      ]),
    ),
  })
  .strict();

// ------------------------------------------------------------- segment

const segmentSummaryFields = {
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  summary: z
    .object({
      conditionCount: z.number().int().nonnegative(),
      userIdCount: z.number().int().nonnegative(),
      hasRegex: z.boolean(),
      payloadBytes: z.number().int().nonnegative(),
    })
    .strict(),
};

export const segmentSummaryWire = z
  .object({
    ...segmentSummaryFields,
    usage: z
      .object({
        flagCount: z.number().int().nonnegative(),
        productionFlagCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const segmentDetailWire = z
  .object({
    ...segmentSummaryFields,
    conditions: z
      .object({
        /** Mỗi nhánh của union đọc đã `.strict()` sẵn ở `condition.ts` */
        all: z.array(readAttributeConditionSchema),
        userIds: z.array(z.string()),
      })
      .strict(),
    usage: z
      .object({
        flagCount: z.number().int().nonnegative(),
        productionFlagCount: z.number().int().nonnegative(),
        flags: z.array(
          z
            .object({
              flagId: uuid,
              flagKey: z.string(),
              lifecycleStatus: z.string(),
              envs: z.array(envRefWire),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

/** `GET /segments` */
export const segmentListResponseWire = z
  .object({
    segments: z.array(segmentSummaryWire),
    quota: z
      .object({
        segmentCount: z.number().int().nonnegative(),
        maxSegments: z.number().int().positive(),
        payloadBytes: z.number().int().nonnegative(),
        maxPayloadBytes: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

/** `GET|PUT /segments/:id`, `POST /segments` (201) */
export const segmentResponseWire = z
  .object({ segment: segmentDetailWire })
  .strict();

// ------------------------------------------------------------- rollout

export const rolloutStatusWire = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "PAUSED",
  "DONE",
  "FAILED",
]);
export const rolloutStrategyWire = z.enum([
  "CANARY",
  "ATTRIBUTE_SPLIT",
  "BLUE_GREEN",
]);
export const rolloutScopeWire = z.enum(["FLAG_LEVEL", "SERVICE_LEVEL"]);
export const rolloutActionWire = z.enum([
  "PROMOTE",
  "ROLLBACK",
  "PAUSE",
  "RESUME",
  "COMPLETE",
  "EXPIRE",
  "DEPENDENCY_DOWN",
]);

const branchSnapshotWire = z
  .object({
    requestCount: z.number(),
    errorCount: z.number(),
    errorRate: z.number(),
    latencyP99Ms: z.number().optional(),
    hasData: z.boolean(),
  })
  .strict();

export const metricSnapshotWire = z
  .object({
    canary: branchSnapshotWire,
    baseline: branchSnapshotWire,
    zScore: z.number().nullable(),
    queries: z
      .object({ canary: z.array(z.string()), baseline: z.array(z.string()) })
      .strict(),
    windowSeconds: z.number(),
    at: isoDateTime,
  })
  .strict();

export const rolloutEventWire = z
  .object({
    id: uuid,
    action: rolloutActionWire,
    isIntent: z.boolean(),
    processedAt: isoDateTime.nullable(),
    trafficPercentage: z.number(),
    reason: z.string().nullable(),
    /** [Plan #60 QĐ-1] Lý do dạng mã + số (Portal viết câu theo ngôn ngữ); `null` thì hiện `reason` */
    reasonDetail: decisionDetailSchema.nullable(),
    triggeredBy: z.string(),
    actorUserId: uuid.nullable(),
    causedByEventId: uuid.nullable(),
    metricSnapshot: metricSnapshotWire.nullable(),
    createdAt: isoDateTime,
  })
  .strict();

export const rolloutSummaryWire = z
  .object({
    id: uuid,
    environmentId: uuid,
    scope: rolloutScopeWire,
    strategy: rolloutStrategyWire,
    status: rolloutStatusWire,
    currentTrafficPercentage: z.number(),
    baselinePercentage: z.number().nullable(),
    flagKey: z.string().nullable(),
    workloadName: z.string().nullable(),
    failReason: z.string().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict();

export const rolloutDetailWire = z
  .object({
    id: uuid,
    projectId: uuid,
    environment: envRefWire,
    scope: rolloutScopeWire,
    controlMode: z.enum(["udp-driven", "tool-driven"]),
    strategy: rolloutStrategyWire,
    status: rolloutStatusWire,
    currentTrafficPercentage: z.number(),
    baselinePercentage: z.number().nullable(),
    flag: z
      .object({
        id: uuid,
        key: z.string(),
        targetVariant: z.string(),
        targetingRuleId: uuid,
      })
      .strict()
      .optional(),
    workloadName: z.string().nullable(),
    versionNew: z.string().optional(),
    versionOld: z.string().optional(),
    /** [v4.11, Plan #51] ATTRIBUTE_SPLIT ở SERVICE_LEVEL */
    trafficMatch: trafficMatchSchema.optional(),
    /**
     * Cột JSONB đã qua `rolloutThresholdsSchema` lúc ghi; hàng cũ có thể thiếu trường
     * (mặc định áp lúc đọc ở S3). Portal hiển thị từng khoá có mặt, nên `record`.
     */
    thresholds: z.record(z.unknown()),
    stepPercent: z.number(),
    stepIntervalSeconds: z.number().int(),
    analysisIntervalSeconds: z.number().int(),
    warmUpRequests: z.number().int(),
    metricWindowSeconds: z.number().int(),
    maxDurationSeconds: z.number().int(),
    failReason: z.string().optional(),
    lastDecision: z
      .object({
        decision: z.enum(DECISIONS),
        reason: z.string(),
        breach: z.boolean(),
        breachStreak: z.number().int().nonnegative(),
        breachAt: isoDateTime.nullable(),
        at: isoDateTime,
        /** [Plan #60 QĐ-1] Mã + số của lý do; `null` ở quyết định cũ và lý do vận hành */
        detail: decisionDetailSchema.nullable(),
      })
      .strict()
      .optional(),
    latestMetricSnapshot: metricSnapshotWire.optional(),
    pendingIntent: z
      .object({
        id: uuid,
        action: rolloutActionWire,
        at: isoDateTime,
        byUser: z.string(),
      })
      .strict()
      .optional(),
    events: z.array(rolloutEventWire),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict();

/** `GET /rollouts` */
export const rolloutListResponseWire = z
  .object({ rollouts: z.array(rolloutSummaryWire) })
  .strict();

/** `POST /rollouts` (201), `GET /rollouts/:id` */
export const rolloutResponseWire = z
  .object({ rollout: rolloutDetailWire })
  .strict();

/** `GET /rollouts/:id/events` */
export const rolloutEventsResponseWire = z
  .object({ events: z.array(rolloutEventWire) })
  .strict();

/** `POST /rollouts/:id/actions` (202) — intent ĐÃ GHI, chưa thực thi (§7.6) */
export const rolloutActionResponseWire = z
  .object({ intentId: uuid, status: z.literal("accepted") })
  .strict();

/** Đầu vào hợp lệ của `POST /rollouts/:id/actions` — Portal dựng nút từ đây */
export const rolloutIntentActionWire = z.enum(INTENT_ACTIONS);

/** `POST /rollouts/probe` */
export const rolloutProbeResponseWire = z
  .object({
    probe: z
      .object({
        reachable: z.literal(true),
        hasSeries: z.boolean(),
        scrapeIntervalSec: z.number(),
        scrapeIntervalSource: z.string(),
        minMetricWindowSeconds: z.number(),
      })
      .strict(),
  })
  .strict();

// ------------------------------------------------------------- deployment + DORA

export const deploymentEventTypeWire = z.enum([
  "DEPLOY_PENDING",
  "DEPLOY_START",
  "DEPLOY_SUCCESS",
  "DEPLOY_FAILURE",
  "FLAG_CHANGE",
  "ROLLBACK",
]);

export const deploymentWire = z
  .object({
    deploymentId: uuid,
    status: deploymentEventTypeWire,
    workloadName: z.string().nullable(),
    imageTag: z.string().nullable(),
    commitSha: z.string().nullable(),
    triggeredBy: z.enum(["WEBHOOK", "MANUAL", "ROLLBACK", "AUTO"]),
    rolloutSessionId: uuid.nullable(),
    restoresDeploymentId: uuid.nullable(),
    startedAt: isoDateTime,
    lastEventAt: isoDateTime,
    events: z.array(
      z
        .object({
          id: uuid,
          eventType: deploymentEventTypeWire,
          occurredAt: isoDateTime,
        })
        .strict(),
    ),
  })
  .strict();

/** `GET /projects/:id/deployments?envId=` */
export const deploymentListResponseWire = z
  .object({ deployments: z.array(deploymentWire) })
  .strict();

/** [v4.11, Plan #45] `GET /projects/:id/deployments/latest?envId=` — `null` khi env chưa deploy lần nào */
export const deploymentLatestResponseWire = z
  .object({ deployment: deploymentWire.nullable() })
  .strict();

/**
 * [v4.11, Plan #45] `GET /projects/:id/deployments/:deploymentId/logs` — mọi sự kiện của MỘT lần
 * deploy theo thời gian. `detail` là `metadata` đã qua `redact()`: lý do lỗi, image khôi phục,
 * repo, ref.
 */
export const deploymentLogsResponseWire = z
  .object({
    deploymentId: uuid,
    events: z.array(
      z
        .object({
          id: uuid,
          eventType: deploymentEventTypeWire,
          occurredAt: isoDateTime,
          triggeredBy: z.enum(["WEBHOOK", "MANUAL", "ROLLBACK", "AUTO"]),
          workloadName: z.string().nullable(),
          imageTag: z.string().nullable(),
          commitSha: z.string().nullable(),
          pipelineId: z.string().nullable(),
          detail: z.record(z.unknown()).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const sampled = z
  .object({
    median: z.number().nullable(),
    samples: z.number().int().nonnegative(),
  })
  .strict();

/** `GET /projects/:id/metrics/dora` — năm chỉ số §2.2, mỗi chỉ số kèm cỡ mẫu */
export const doraWire = z
  .object({
    environmentId: uuid.nullable(),
    window: z
      .object({ from: isoDateTime, to: isoDateTime, days: z.number().int() })
      .strict(),
    deployments: z.number().int().nonnegative(),
    deploymentFrequencyPerDay: z.number().nonnegative(),
    leadTimeSeconds: sampled,
    changeFailureRate: z
      .object({
        value: z.number().min(0).max(1).nullable(),
        failed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    recoveryTimeSeconds: sampled,
    reworkRate: z
      .object({
        value: z.number().min(0).max(1).nullable(),
        rework: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    rollbacks: z
      .object({
        auto: z.number().int().nonnegative(),
        manual: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const doraResponseWire = z.object({ dora: doraWire }).strict();

/**
 * Kết cục deploy của MỘT ngày UTC — một hình cho trang chủ (Plan #53), E10 của trang Bằng chứng (Plan #56) và biểu đồ
 * deploy của trang Kiến trúc (Plan #57).
 */
export const deployDayWire = z
  .object({
    /** `YYYY-MM-DD` theo UTC */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    success: z.number().int().nonnegative(),
    failure: z.number().int().nonnegative(),
  })
  .strict();

/** [v4.11, Plan #56] Cửa sổ (ngày) của E10 trên trang Bằng chứng */
export const EVIDENCE_DORA_DAYS = [7, 30, 90] as const;
export type EvidenceDoraDays = (typeof EVIDENCE_DORA_DAYS)[number];

/**
 * [v4.11, Plan #56] `GET /admin/evidence/dora` — E10 (§14) của CẢ nền tảng: DORA của env production mỗi project
 * (cùng hàm `computeDora` của `/metrics/dora`), và kết cục deploy theo ngày trên mọi env production.
 */
export const platformDoraWire = z
  .object({
    window: z
      .object({ from: isoDateTime, to: isoDateTime, days: z.number().int() })
      .strict(),
    projects: z.array(
      z
        .object({
          projectId: uuid,
          projectName: z.string(),
          environmentName: z.string(),
          dora: doraWire,
        })
        .strict(),
    ),
    daily: z.array(deployDayWire),
  })
  .strict();

export const adminEvidenceDoraResponseWire = z
  .object({ evidence: platformDoraWire })
  .strict();

// ------------------------------------------------------------- admin (§9, §10.11)

export const adminUserWire = z
  .object({
    id: uuid,
    email: z.string().email(),
    name: z.string(),
    platformRole: platformRoleWire,
    createdAt: isoDateTime,
  })
  .strict();

/** [v4.11, Plan #53] Theo trang: `total` là mọi người dùng khớp bộ lọc — không còn cắt im lặng ở 100 */
export const adminUsersResponseWire = z
  .object({
    users: z.array(adminUserWire),
    total: z.number().int().nonnegative(),
  })
  .strict();
export const adminUserResponseWire = z.object({ user: adminUserWire }).strict();

const cloudProviderWire = cloudProviderSchema;

export const adminProjectsResponseWire = z
  .object({
    projects: z.array(
      z
        .object({
          id: uuid,
          name: z.string(),
          status: projectStatusWire,
          owner: z.object({ id: uuid, email: z.string() }).strict(),
          memberCount: z.number().int().nonnegative(),
          cloudProvider: cloudProviderWire.nullable(),
          createdAt: isoDateTime,
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
  })
  .strict();

/** Chỉ metadata + một đoạn fingerprint — KHÔNG trường mã hoá nào (§9) */
export const adminCredentialsResponseWire = z
  .object({
    credentials: z.array(
      z
        .object({
          id: uuid,
          provider: cloudProviderWire,
          mode: z.string(),
          authKind: z.string(),
          fingerprint: z.string().max(12),
          isActive: z.boolean(),
          lastValidatedAt: isoDateTime.nullable(),
          createdAt: isoDateTime,
          project: z.object({ id: uuid, name: z.string() }).strict(),
        })
        .strict(),
    ),
  })
  .strict();

export const adminJobsResponseWire = z
  .object({
    jobs: z.array(
      z
        .object({
          id: uuid,
          jobType: z.string(),
          state: z.string(),
          attempt: z.number().int().nonnegative(),
          lastError: z.unknown(),
          createdAt: isoDateTime,
          updatedAt: isoDateTime,
          project: z.object({ id: uuid, name: z.string() }).strict(),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
  })
  .strict();

export const adminOrphansResponseWire = z
  .object({
    resources: z.array(
      z
        .object({
          id: uuid,
          projectId: uuid,
          projectName: z.string(),
          kind: z.string(),
          provider: cloudProviderWire,
          region: z.string(),
          providerId: z.string().nullable(),
          /** `null` = không định giá được, KHÁC 0 */
          usdPerHour: z.number().nonnegative().nullable(),
          updatedAt: isoDateTime,
        })
        .strict(),
    ),
    estimatedUsdPerHour: z.number().nonnegative(),
    unpriced: z.array(z.string()),
    pricingAsOf: z.string(),
    /** Nửa quét cloud theo tag chưa chạy — màn hình phải nói điều đó */
    cloudScanned: z.boolean(),
  })
  .strict();

const serviceStatusWire = z.enum(["up", "down", "unknown"]);
export const adminSystemResponseWire = z
  .object({
    services: z.array(
      z.object({ name: z.string(), status: serviceStatusWire }).strict(),
    ),
    database: z.enum(["up", "down"]),
    checkedAt: isoDateTime,
  })
  .strict();

// ------------------------------------------------------------- domain (Plan #27)

const domainTierWire = z.enum(["CORE", "STANDARD", "ADVANCED"]);
const domainStatusWire = z.enum([
  "PENDING",
  "DEPLOYING",
  "ACTIVE",
  "SWITCHING",
  "RECONFIGURING",
  "TEARINGDOWN",
  "BLOCKED",
  "ERROR",
]);

/** Một trường của form cấu hình tool, suy từ `configSchema` của adapter (QĐ-3) */
export const domainConfigFieldWire = z
  .object({
    key: z.string().min(1),
    kind: z.enum(["string", "number", "boolean", "enum", "json"]),
    required: z.boolean(),
    /** Trường bí mật: giá trị lưu niêm phong, trên dây là `{ "$udpSecret": "kept" }` */
    secret: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
  })
  .strict();

const capabilityRequirementWire = z
  .object({ id: z.string(), constraint: z.string().optional() })
  .strict();

export const domainToolWire = z
  .object({
    toolId: z.string().min(1),
    version: z.string().min(1),
    scope: z.enum(["cluster", "namespace"]),
    provides: z.array(
      z
        .object({
          id: z.string(),
          version: z.string(),
          exclusive: z.boolean().optional(),
        })
        .strict(),
    ),
    requires: z.array(
      z.union([
        capabilityRequirementWire,
        z.object({ anyOf: z.array(capabilityRequirementWire) }).strict(),
      ]),
    ),
    recommends: z.array(z.string()),
    conflicts: z.array(z.string()),
    /** Câu gợi ý do adapter khai (§5.3), theo capability */
    hints: z.record(z.string()),
    config: z.union([
      z
        .object({
          kind: z.literal("object"),
          fields: z.array(domainConfigFieldWire),
        })
        .strict(),
      z.object({ kind: z.literal("json") }).strict(),
    ]),
  })
  .strict();

export const domainCatalogEntryWire = z
  .object({
    domainType: z.string().min(1),
    tier: domainTierWire,
    displayName: z.string(),
    defaultOrder: z.number().int(),
    isAvailable: z.boolean(),
    /** Tool của registry cho domain này — rỗng là "chưa có công cụ", không phải lỗi */
    tools: z.array(domainToolWire),
  })
  .strict();

export const domainCatalogResponseWire = z
  .object({ domains: z.array(domainCatalogEntryWire) })
  .strict();

export const projectDomainWire = z
  .object({
    domainType: z.string().min(1),
    isEnabled: z.boolean(),
    selectedTool: z.string().nullable(),
    toolConfig: z.record(z.unknown()).nullable(),
    /** `null` = chưa từng cấu hình (không có hàng `domain_configs`) */
    status: domainStatusWire.nullable(),
    adapterVersion: z.string().nullable(),
    updatedAt: isoDateTime.nullable(),
  })
  .strict();

export const projectDomainsResponseWire = z
  .object({
    domainSetVersion: z.number().int().nonnegative(),
    domains: z.array(projectDomainWire),
    preferences: z.array(capabilityPreferenceSchema),
  })
  .strict();

export const projectDomainResponseWire = z
  .object({ domain: projectDomainWire })
  .strict();

const validationIssueWire = z
  .object({
    code: z.enum([
      "MISSING_CAPABILITY",
      "MISSING_ANY_OF",
      "CONFLICT",
      "VERSION_MISMATCH",
      "AMBIGUOUS_PROVIDER",
      "CYCLIC_DEPENDENCY",
      "CLOUD_MISMATCH",
    ]),
    subject: z.string(),
    detail: z.array(z.string()),
    suggestedAction: z
      .object({
        type: z.enum(["ENABLE_DOMAIN", "SWITCH_TOOL", "CHOOSE_PROVIDER"]),
        domainType: z.string(),
        toolId: z.string().optional(),
        capabilityId: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** §9 `DomainValidationResponse` — không có `rebindPlan` trước khi có binding (D-P) */
export const domainValidationResponseWire = z
  .object({
    validation: z
      .object({
        valid: z.boolean(),
        errors: z.array(validationIssueWire),
        warnings: z.array(
          z
            .object({
              code: z.literal("RECOMMENDED_MISSING"),
              subject: z.string(),
              detail: z.array(z.string()),
            })
            .strict(),
        ),
        deployOrder: z.array(z.array(z.string())).nullable(),
      })
      .strict(),
  })
  .strict();

export const domainDriftResponseWire = z
  .object({
    drift: z
      .object({
        verdict: z.enum(["NOT_DEPLOYED", "CLEAN", "DRIFTED", "SCAN_FAILED"]),
        message: z.string().nullable(),
        at: isoDateTime.nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * [v4.11, Plan #45] `GET /projects/:id/domains/:type/versions` (§8.6, §10.13 "Upgrade dialog").
 * Registry nạp MỘT bản mỗi tool, nên `available` có tối đa một phần tử — bản máy chủ đang nạp khi
 * nó khác bản đang chạy — kèm capability đổi gì so với binding đang lưu và kết quả chạy lại
 * validator với khai báo mới: Portal thấy TRƯỚC khi bấm điều worker kiểm trước khi chạm cluster.
 */
export const domainVersionsResponseWire = z
  .object({
    versions: z
      .object({
        domainType: z.string().min(1),
        toolId: z.string(),
        current: z.string().nullable(),
        available: z.array(
          z
            .object({
              version: z.string(),
              provides: z.array(
                z.object({ id: z.string(), version: z.string() }).strict(),
              ),
              changes: z.array(
                z
                  .object({
                    capabilityId: z.string(),
                    from: z.string().nullable(),
                    to: z.string().nullable(),
                  })
                  .strict(),
              ),
              validation: domainValidationResponseWire.shape.validation,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

// ------------------------------------------------------------- cloud của project

/**
 * [v4.11] Cấu hình cloud đang dùng của project (Plan #26, §9) — CHỈ metadata. Không trường
 * nào suy ngược được bí mật: định danh (roleArn, clientId…) vẫn nằm trong payload mã hoá
 * (§4.3), người dùng đối chiếu bằng 12 ký tự đầu của fingerprint.
 */
export const cloudCredentialWire = z
  .object({
    provider: cloudProviderSchema,
    mode: z.enum(["BYOC", "MANAGED"]),
    authKind: cloudAuthKindSchema,
    federated: z.boolean(),
    region: cloudRegionSchema,
    fingerprint: z.string().length(12),
    lastValidatedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    createdBy: z.object({ id: uuid, email: z.string() }).strict(),
  })
  .strict();
export const cloudResponseWire = z
  .object({ cloud: cloudCredentialWire.nullable() })
  .strict();

/** Vì sao một cơ chế chưa dùng được ở triển khai này — khoá i18n của Portal */
export const cloudUnavailableReasonWire = z.enum([
  "aws-federation-disabled",
  "oidc-issuer-disabled",
  "managed-disabled",
]);

/** Một khối khách copy vào cloud của họ (trust policy, lệnh gcloud/az) — `id` là khoá i18n */
export const cloudSetupSnippetWire = z
  .object({
    id: z.string().min(1),
    language: z.enum(["json", "shell"]),
    content: z.string().min(1),
  })
  .strict();

export const cloudSetupResponseWire = z
  .object({
    setup: z
      .object({
        provider: cloudProviderSchema,
        /** Subject mà token OIDC của UDP mang cho project này */
        subject: z.string().min(1),
        methods: z.array(
          z
            .object({
              authKind: cloudAuthKindSchema,
              federated: z.boolean(),
              available: z.boolean(),
              unavailableReason: cloudUnavailableReasonWire.nullable(),
              snippets: z.array(cloudSetupSnippetWire),
            })
            .strict(),
        ),
        managed: z
          .object({
            available: z.boolean(),
            unavailableReason: cloudUnavailableReasonWire.nullable(),
          })
          .strict(),
        requiredPermissions: z.array(z.string().min(1)).min(1),
        docUrl: z.string().url(),
      })
      .strict(),
  })
  .strict();

export const cloudValidationResponseWire = z
  .object({
    validation: z
      .object({
        valid: z.boolean(),
        reason: z.string().nullable(),
        checkedAt: isoDateTime,
      })
      .strict(),
  })
  .strict();

export const cloudPreflightResponseWire = z
  .object({
    preflight: z
      .object({
        ok: z.boolean(),
        confidence: z.enum(["exact", "heuristic"]),
        missingPermissions: z.array(z.string()),
        quotaWarnings: z.array(z.string()),
        docUrl: z.string().url(),
        checkedAt: isoDateTime,
      })
      .strict(),
  })
  .strict();

// ------------------------------------------------------------- provisioning của project

/**
 * [v4.11] Xem trước + job provisioning (Plan #28, §8.1 giai đoạn 2, §9). Tiến độ đọc từ
 * database (QĐ-6); SSE chỉ gửi ảnh chụp để Portal `invalidateQueries` (§10.14).
 */
const jobStateWire = z.enum([
  "QUEUED",
  "NETWORK",
  "CLUSTER",
  "CLUSTER_ACCESS",
  "DOMAINS",
  "DONE",
  "CANCEL_REQUESTED",
  "COMPENSATING",
  "COMPENSATION_FAILED",
  "FAILED",
]);

const costLineWire = z
  .object({ item: z.string().min(1), monthlyUsd: z.number().nonnegative() })
  .strict();

export const provisionPreviewResponseWire = z
  .object({
    preview: z
      .object({
        provider: cloudProviderWire,
        region: cloudRegionSchema,
        cluster: z
          .object({
            nodeSize: z.enum(["small", "medium", "large"]),
            nodeCount: z.number().int().positive(),
          })
          .strict(),
        /** `breakdown` luôn có control-plane, nat-gateway, load-balancer (§4.2) */
        cost: z
          .object({
            monthlyUsd: z.number().nonnegative(),
            breakdown: z.array(costLineWire).min(3),
            isEstimate: z.boolean(),
            pricingAsOf: z.string().min(1),
          })
          .strict(),
        /** Tên logic các ResourceStep theo thứ tự chạy — "kế hoạch thu gọn" của §16 */
        steps: z
          .object({
            network: z.array(z.string().min(1)),
            cluster: z.array(z.string().min(1)),
          })
          .strict(),
        deployOrder: z.array(z.array(z.string())),
        estimatedMinutes: z
          .object({
            min: z.number().int().positive(),
            max: z.number().int().positive(),
          })
          .strict(),
        /** Có environment production ⇒ `POST /provision` đòi `confirmedMonthlyUsd` */
        requiresConfirmation: z.boolean(),
        blockers: z.array(z.enum(PROVISION_BLOCKERS)),
      })
      .strict(),
  })
  .strict();

export const provisioningJobWire = z
  .object({
    id: uuid,
    jobType: z.enum([
      "PROVISION",
      "TEARDOWN",
      "DOMAIN_APPLY",
      "ENVIRONMENT_APPLY",
    ]),
    state: jobStateWire,
    attempt: z.number().int().nonnegative(),
    confirmedMonthlyUsd: z.number().nonnegative().nullable(),
    lastError: z
      .object({
        step: z.string(),
        message: z.string(),
        orphans: z.array(z.string()),
        at: isoDateTime.nullable(),
      })
      .strict()
      .nullable(),
    cancellable: z.boolean(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict();

export const jobResponseWire = z.object({ job: provisioningJobWire }).strict();

/**
 * `PUT /projects/:id/domains` (Plan #30): cùng thân với `GET /domains`, cộng `job`. Project
 * nháp lưu thẳng (`job: null`, 200); project đang chạy nhận job `DOMAIN_APPLY` (202) và
 * `domains` vẫn là thứ ĐANG chạy — đích chỉ vào bảng khi đã áp xong.
 */
export const putDomainsResponseWire = z
  .object({
    domainSetVersion: z.number().int().nonnegative(),
    domains: z.array(projectDomainWire),
    preferences: z.array(capabilityPreferenceSchema),
    job: provisioningJobWire.nullable(),
  })
  .strict();

export const jobListResponseWire = z
  .object({ jobs: z.array(provisioningJobWire) })
  .strict();

export const jobDetailResponseWire = z
  .object({
    job: provisioningJobWire,
    resources: z.array(
      z
        .object({
          step: z.enum(["NETWORK", "CLUSTER", "DOMAINS", "K8S_MANAGED"]),
          kind: z.string().min(1),
          /** Tên logic trong kế hoạch (`vpc`, `subnet-a`) — đuôi của khoá idempotency */
          name: z.string().min(1),
          status: z.enum([
            "CREATING",
            "CREATED",
            "READY",
            "DELETING",
            "DELETED",
            "ORPHAN_SUSPECTED",
          ]),
          providerId: z.string().nullable(),
          updatedAt: isoDateTime,
        })
        .strict(),
    ),
    domains: z.array(
      z
        .object({
          domainType: z.string().min(1),
          status: domainStatusWire,
          message: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

// ------------------------------------------------------------- kiểu suy ra

export type PlatformRoleWire = z.infer<typeof platformRoleWire>;
export type ProjectRoleWire = z.infer<typeof projectRoleWire>;
export type ProjectStatusWire = z.infer<typeof projectStatusWire>;
export type PublicUserWire = z.infer<typeof publicUserWire>;
export type PublicEnvironmentWire = z.infer<typeof publicEnvironmentWire>;
export type ResourceQuotaWire = z.infer<typeof resourceQuotaWire>;
export type PublicProjectWire = z.infer<typeof publicProjectWire>;
export type ProjectDetailResponseWire = z.infer<
  typeof projectDetailResponseWire
>;
export type PublicMemberWire = z.infer<typeof publicMemberWire>;
export type TeamRoleWire = z.infer<typeof teamRoleWire>;
export type GrantableProjectRoleWire = z.infer<typeof grantableProjectRoleWire>;
export type ProjectInvitationWire = z.infer<typeof projectInvitationWire>;
export type TeamInvitationWire = z.infer<typeof teamInvitationWire>;
export type InvitationTargetWire = z.infer<typeof invitationTargetWire>;
export type InvitationLookupWire = z.infer<
  typeof invitationLookupResponseWire
>["invitation"];
export type TeamSummaryWire = z.infer<typeof teamSummaryWire>;
export type TeamMemberWire = z.infer<typeof teamMemberWire>;
export type TeamProjectWire = z.infer<typeof teamProjectWire>;
export type TeamDetailWire = z.infer<typeof teamDetailWire>;
export type ProjectTeamWire = z.infer<typeof projectTeamWire>;
export type AuditEntryWire = z.infer<typeof auditEntryWire>;
export type PlatformDoraWire = z.infer<typeof platformDoraWire>;
export type DeployDayWire = z.infer<typeof deployDayWire>;
export type SdkKeyWire = z.infer<typeof sdkKeyWire>;
export type FlagEnvStateWire = z.infer<typeof flagEnvStateWire>;
export type FlagVariantWire = z.infer<typeof flagVariantWire>;
export type FlagDetailWire = z.infer<typeof flagDetailWire>;
export type FlagSummaryWire = z.infer<typeof flagSummaryWire>;
export type RuleWire = z.infer<typeof ruleWire>;
export type RulesResponseWire = z.infer<typeof rulesResponseWire>;
export type PromoteResponseWire = z.infer<typeof promoteResponseWire>;
export type FlagStatsViewWire = z.infer<typeof flagStatsViewResponseWire>;
export type StaleFlagsResponseWire = z.infer<typeof staleFlagsResponseWire>;
export type BulkArchiveResponseWire = z.infer<typeof bulkArchiveResponseWire>;
export type SegmentSummaryWire = z.infer<typeof segmentSummaryWire>;
export type SegmentDetailWire = z.infer<typeof segmentDetailWire>;
export type SegmentListResponseWire = z.infer<typeof segmentListResponseWire>;
export type RolloutStatusWire = z.infer<typeof rolloutStatusWire>;
export type RolloutSummaryWire = z.infer<typeof rolloutSummaryWire>;
export type RolloutDetailWire = z.infer<typeof rolloutDetailWire>;
export type RolloutEventWire = z.infer<typeof rolloutEventWire>;
export type MetricSnapshotWire = z.infer<typeof metricSnapshotWire>;
export type DeploymentWire = z.infer<typeof deploymentWire>;
export type DeploymentLogsWire = z.infer<typeof deploymentLogsResponseWire>;
export type DoraWire = z.infer<typeof doraWire>;
export type AdminUserWire = z.infer<typeof adminUserWire>;
export type AdminOrphansResponseWire = z.infer<typeof adminOrphansResponseWire>;
export type RolloutIntentActionWire = z.infer<typeof rolloutIntentActionWire>;
export type CloudCredentialWire = z.infer<typeof cloudCredentialWire>;
export type CloudSetupWire = z.infer<typeof cloudSetupResponseWire>["setup"];
export type CloudValidationWire = z.infer<
  typeof cloudValidationResponseWire
>["validation"];
export type CloudPreflightWire = z.infer<
  typeof cloudPreflightResponseWire
>["preflight"];
export type DomainConfigFieldWire = z.infer<typeof domainConfigFieldWire>;
export type DomainToolWire = z.infer<typeof domainToolWire>;
export type DomainCatalogEntryWire = z.infer<typeof domainCatalogEntryWire>;
export type ProjectDomainWire = z.infer<typeof projectDomainWire>;
export type ProjectDomainsResponseWire = z.infer<
  typeof projectDomainsResponseWire
>;
export type DomainValidationWire = z.infer<
  typeof domainValidationResponseWire
>["validation"];
export type DomainDriftWire = z.infer<typeof domainDriftResponseWire>["drift"];
export type DomainVersionsWire = z.infer<
  typeof domainVersionsResponseWire
>["versions"];
export type ProjectClusterWire = z.infer<typeof projectClusterWire>;
export type ProvisionPreviewWire = z.infer<
  typeof provisionPreviewResponseWire
>["preview"];
export type ProvisioningJobWire = z.infer<typeof provisioningJobWire>;
export type JobDetailWire = z.infer<typeof jobDetailResponseWire>;
export type PutDomainsResponseWire = z.infer<typeof putDomainsResponseWire>;

// ------------------------------------------------------------- CI/CD (Plan #36, §8.3)

/** `GET /projects/:id/cicd` — tool CI đang bật, đường webhook, secret đã sinh chưa (không bao giờ giá trị) */
export const cicdStatusResponseWire = z
  .object({
    cicd: z
      .object({
        provider: z.string().nullable(),
        webhookPath: z.string().nullable(),
        secretSet: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** `POST /projects/:id/cicd/webhook-secret` — giá trị rõ CHỈ có ở response này (hiện một lần) */
export const cicdSecretResponseWire = z
  .object({
    provider: z.string(),
    webhookPath: z.string(),
    secret: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** `GET /projects/:id/cicd/pipeline-template` — pipeline Golden Path của tool đang bật */
export const pipelineTemplateResponseWire = z
  .object({ provider: z.string(), content: z.string() })
  .strict();

// ------------------------------------------------------------- Golden Path (§11, Plan #48)

export const goldenPathFileWire = z
  .object({ path: z.string().min(1), content: z.string() })
  .strict();

/**
 * `GET /projects/:id/golden-path` — cây §11.1 của runtime project, kèm pipeline của tool CI/CD đang
 * bật khi sinh được. `notes` nói vì sao thiếu gì (chưa bật CI/CD, chưa có registry ⇒ `REGISTRY_REF`
 * còn nguyên) — trang không phải tự đoán.
 */
export const goldenPathResponseWire = z
  .object({
    runtime: z.enum(["nodejs", "python"]),
    slug: z.string(),
    files: z.array(goldenPathFileWire),
    pipeline: z
      .object({ provider: z.string(), path: z.string(), content: z.string() })
      .strict()
      .nullable(),
    notes: z.array(z.string()),
  })
  .strict();

export type GoldenPathResponseWire = z.infer<typeof goldenPathResponseWire>;

export const REPO_SCAN_FINDING_IDS = [
  "runtime",
  "dockerfile",
  "metrics-endpoint",
  "openfeature",
  "udp-provider",
  "udp-middleware",
  "service-version",
  "pipeline",
] as const;

export const repoScanFindingWire = z
  .object({
    id: z.enum(REPO_SCAN_FINDING_IDS),
    status: z.enum(["ok", "missing", "unknown"]),
    detail: z.string(),
    evidence: z.array(z.string()),
    suggestion: z
      .object({ text: z.string(), file: goldenPathFileWire.optional() })
      .strict()
      .optional(),
  })
  .strict();

/** Kết quả quét repo (§11.2) — cũng là hình được lưu ở `projects.repo_scan` */
export const repoScanWire = z
  .object({
    scannedAt: z.string().datetime(),
    repoUrl: z.string(),
    host: z.enum(["github", "gitlab"]),
    runtime: z.string().nullable(),
    framework: z.string().nullable(),
    cicdTool: z.string().nullable(),
    findings: z.array(repoScanFindingWire),
    flagLevelReady: z.boolean(),
    truncated: z.boolean(),
  })
  .strict();
export type RepoScanWire = z.infer<typeof repoScanWire>;

/** `GET` và `POST /projects/:id/repo-scan` — `scan: null` khi chưa quét lần nào */
export const repoScanResponseWire = z
  .object({ scan: repoScanWire.nullable() })
  .strict();

/**
 * `POST /webhooks/cicd/:projectId/:provider` và `POST /projects/:id/deployments/:deploymentId/approve`
 * — webhook nhận xong trả ngay, việc áp và theo dõi chạy ở hàng đợi `udp-deploy`.
 */
export const deployAcceptedResponseWire = z
  .object({
    deploymentId: uuid,
    status: z.enum(["duplicate", "failure-recorded", "pending", "started"]),
  })
  .strict();

export type CicdStatusWire = z.infer<typeof cicdStatusResponseWire>["cicd"];
export type CicdSecretResponseWire = z.infer<typeof cicdSecretResponseWire>;
export type DeployAcceptedResponseWire = z.infer<
  typeof deployAcceptedResponseWire
>;

// ------------------------------------------------------------- Chi phí (Plan #38, §5.5 Cost)

const usd = z.number().nonnegative();

/**
 * `GET /projects/:id/cost?days=` — chi phí THỰC từ bộ tính (OpenCost/Kubecost) gom theo
 * environment (namespace). Khác `estimate` của preview (§4.4): đây là số đo được, không ước tính.
 */
export const costResponseWire = z
  .object({
    cost: z
      .object({
        provider: z.string(),
        days: z.number().int().min(1).max(30),
        currency: z.literal("USD"),
        totalUsd: usd,
        environments: z.array(
          z
            .object({
              environmentId: uuid,
              name: z.string(),
              totalUsd: usd,
              cpuUsd: usd,
              ramUsd: usd,
              storageUsd: usd,
              networkUsd: usd,
            })
            .strict(),
        ),
        /**
         * [v4.11, Plan #53 QĐ-4] Theo ngày (UTC), cũ nhất trước — cùng một lần hỏi bộ tính với
         * `totalUsd`, nên tổng các ngày BẰNG `totalUsd` (một nguồn, không hai con số lệch nhau).
         */
        daily: z.array(
          z
            .object({
              date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              totalUsd: usd,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

export type CostWire = z.infer<typeof costResponseWire>["cost"];

// ------------------------------------------------------------- Nội bộ S3 → S1: metrics (Plan #39)

const internalTarget = z
  .object({
    namespace: z.string().min(1).max(63),
    workloadName: z.string().min(1).max(253),
    version: z.string().max(128).optional(),
    flagKey: z.string().max(255).optional(),
    variantKey: z.string().max(255).optional(),
  })
  .strict();

const internalMetricQueries = metricQueriesSchema.optional();

const windowSec = z.number().int().min(1).max(86_400);

/**
 * `POST /internal/environments/:envId/metrics` — MỘT phép đo mà S1 thực thi trên nguồn của
 * environment (D-P30). S1 kiểm thân bằng schema này, S3 dựng thân theo kiểu của nó.
 */
export const internalMetricsBodyWire = z.discriminatedUnion("op", [
  z
    .object({
      op: z.enum(["errorRate", "latencyP99", "requestCount", "errorCount"]),
      target: internalTarget,
      windowSec,
      metricQueries: internalMetricQueries,
    })
    .strict(),
  z
    .object({
      op: z.literal("custom"),
      query: z.string().min(1).max(4_000),
      target: internalTarget,
      windowSec,
      metricQueries: internalMetricQueries,
    })
    .strict(),
  z
    .object({
      op: z.literal("probe"),
      target: internalTarget,
      metricQueries: internalMetricQueries,
    })
    .strict(),
]);

export type InternalMetricsBody = z.infer<typeof internalMetricsBodyWire>;

export const internalMetricsSampleResponseWire = z
  .object({
    sample: z
      .object({
        value: z.number(),
        query: z.string(),
        windowSeconds: z.number(),
        hasData: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const internalMetricsProbeResponseWire = z
  .object({
    probe: z
      .object({
        status: z.enum(["SUCCESS", "FAILED", "IN_PROGRESS", "NOT_FOUND"]),
        message: z.string().optional(),
        data: z
          .object({
            reachable: z.boolean(),
            hasSeries: z.boolean(),
            queryFailed: z.boolean(),
            scrapeIntervalSec: z.number().optional(),
            scrapeIntervalSource: z.enum(["workload", "global", "assumed"]),
          })
          .strict()
          .optional(),
        durationMs: z.number().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

/** `GET /internal/environments/:envId/metrics-source` — siêu dữ liệu, không khoá nào */
export const internalMetricsSourceResponseWire = z
  .object({
    source: z
      .object({
        providerId: z.string(),
        capabilityVersion: z.string(),
        scrapeLagSeconds: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

// ------------------------------------------------------------- Nội bộ S3 → S1: token cluster (Plan #51)

/**
 * `POST /internal/clusters/:id/token` (ADR-06, §9) — bound SA token để Service 3 tự nói với cluster của project.
 * Tên identity theo §12.2; route chỉ cấp `traffic` (Plan #51 QĐ-2), nhưng schema nhận đủ ba để bên xin sai
 * nhận 403 có nghĩa thay vì 400 "giá trị lạ".
 */
export const internalClusterTokenBodyWire = z
  .object({ serviceAccount: z.enum(["workload", "traffic", "tooling"]) })
  .strict();

export type InternalClusterTokenBody = z.infer<
  typeof internalClusterTokenBodyWire
>;

export const internalClusterTokenResponseWire = z
  .object({
    apiEndpoint: z.string().url(),
    caData: z.string().min(1),
    token: z.string().min(1),
    /** ≤ 1 giờ kể từ lúc cấp (I24c) */
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type InternalClusterTokenResponse = z.infer<
  typeof internalClusterTokenResponseWire
>;

// ------------------------------------------------------------- Environment (Plan #40)

/** `GET /projects/:id/environments` — theo `rank` */
export const environmentListResponseWire = z
  .object({ environments: z.array(publicEnvironmentWire) })
  .strict();

/**
 * `POST /projects/:id/environments` (201) — `job` là `ENVIRONMENT_APPLY` khi project đã có cluster,
 * `null` khi chưa: MỘT hình cho cả hai (bài học D-P21).
 */
export const environmentCreatedResponseWire = z
  .object({
    environment: publicEnvironmentWire,
    job: provisioningJobWire.nullable(),
  })
  .strict();

/** `PATCH /projects/:id/environments/:envId` */
export const environmentResponseWire = z
  .object({ environment: publicEnvironmentWire })
  .strict();

/** `DELETE /projects/:id/environments/:envId` — 202 kèm job khi có cluster, 200 `null` khi không */
export const environmentDeletedResponseWire = z
  .object({ job: provisioningJobWire.nullable() })
  .strict();

// ------------------------------------------------------------- Plan #53: sơ đồ kiến trúc (QĐ-3)

const resourceStepWire = z.enum([
  "NETWORK",
  "CLUSTER",
  "DOMAINS",
  "K8S_MANAGED",
]);

/** Một tài nguyên CÒN SỐNG trên cloud của khách (hàng `DELETED` không lên sơ đồ) */
export const architectureResourceWire = z
  .object({
    step: resourceStepWire,
    kind: z.string(),
    /** Đoạn cuối của `idempotencyKey` — tên UDP đặt cho tài nguyên */
    name: z.string(),
    status: z.enum([
      "CREATING",
      "CREATED",
      "READY",
      "DELETING",
      "ORPHAN_SUSPECTED",
    ]),
  })
  .strict();

/** Bản gần nhất của một workload ở một environment — theo `deployment_events` (không bảng workload nào khác) */
export const architectureWorkloadWire = z
  .object({
    name: z.string(),
    imageTag: z.string().nullable(),
    commitSha: z.string().nullable(),
    lastEvent: z.enum([
      "DEPLOY_PENDING",
      "DEPLOY_START",
      "DEPLOY_SUCCESS",
      "DEPLOY_FAILURE",
      "ROLLBACK",
    ]),
    at: isoDateTime,
  })
  .strict();

export const architectureEnvironmentWire = z
  .object({
    id: uuid,
    name: z.string(),
    namespace: z.string(),
    isProduction: z.boolean(),
    workloads: z.array(architectureWorkloadWire),
  })
  .strict();

export const driftVerdictWire = z.enum([
  "NOT_DEPLOYED",
  "CLEAN",
  "DRIFTED",
  "SCAN_FAILED",
]);

/** Một công cụ đang bật — nút của sơ đồ và ô của lưới sức khoẻ (§10.6 DomainHealthGrid) */
export const architectureToolWire = z
  .object({
    /** `"<domaintype>:<toolid>"` viết thường — cùng khoá với `chosen`/`order` của resolver */
    key: z.string(),
    domainType: z.string(),
    displayName: z.string(),
    toolId: z.string(),
    adapterVersion: z.string().nullable(),
    /** `null` khi máy chủ không còn nạp tool này (gỡ khỏi registry) — nút không có cạnh */
    scope: z.enum(["cluster", "namespace"]).nullable(),
    /** Bậc trong thứ tự deploy; `null` khi tổ hợp không hợp lệ */
    tier: z.number().int().nonnegative().nullable(),
    status: domainStatusWire.nullable(),
    drift: z
      .object({ verdict: driftVerdictWire, at: isoDateTime.nullable() })
      .strict(),
    provides: z.array(z.string()),
  })
  .strict();

/** Tool tiêu thụ → tool cung cấp ĐÃ CHỌN cho capability đó (cùng quan hệ mà `topoSort` dùng) */
export const architectureEdgeWire = z
  .object({ from: z.string(), to: z.string(), capabilityId: z.string() })
  .strict();

/** [v4.11, Plan #57] Số ngày UTC của biểu đồ deploy trên trang Kiến trúc */
export const ARCHITECTURE_DEPLOY_DAYS = 14;

/** `GET /projects/:id/architecture` */
export const architectureResponseWire = z
  .object({
    architecture: z
      .object({
        cloud: z
          .object({
            provider: cloudProviderWire,
            region: z.string(),
            mode: z.enum(["BYOC", "MANAGED"]),
            authKind: cloudAuthKindSchema,
            lastValidatedAt: isoDateTime.nullable(),
          })
          .strict()
          .nullable(),
        cluster: z
          .object({ clusterId: z.string(), apiEndpoint: z.string() })
          .strict()
          .nullable(),
        resources: z.array(architectureResourceWire),
        environments: z.array(architectureEnvironmentWire),
        tools: z.array(architectureToolWire),
        edges: z.array(architectureEdgeWire),
        /**
         * [v4.11, Plan #57] Kết cục deploy theo ngày UTC trên MỌI env của project, `ARCHITECTURE_DEPLOY_DAYS` ngày tới
         * hết hôm nay, cũ nhất trước — mọi ngày có mặt (ngày không deploy là 0).
         */
        deploys: z.array(deployDayWire),
        /** Tổ hợp đang bật có qua validator không — sai thì không có bậc và không có cạnh */
        valid: z.boolean(),
        generatedAt: isoDateTime,
      })
      .strict(),
  })
  .strict();

// ------------------------------------------------------------- Plan #53: giám sát RED (QĐ-4)

export const RED_RANGES = ["1h", "6h", "24h", "7d"] as const;
export const redRangeWire = z.enum(RED_RANGES);
export type RedRange = z.infer<typeof redRangeWire>;

/** Điểm của một chuỗi; `null` = KHÔNG CÓ DỮ LIỆU (I7), khác 0 */
const seriesValuesWire = z.array(z.number().nullable());

export const workloadRedWire = z
  .object({
    workload: z.string(),
    /** Request mỗi giây */
    requestRate: seriesValuesWire,
    /** 0..1 — lỗi 5xx trên tổng request */
    errorRatio: seriesValuesWire,
    latencyP99Ms: seriesValuesWire,
  })
  .strict();

/** Cách mở công cụ giám sát: một URL xem được từ trình duyệt, hoặc lệnh port-forward */
/**
 * [v4.11, Plan #54] Công cụ mà đường mở dẫn tới — MÃ, không phải câu (I37): Portal đặt chữ "Mở Datadog" hay
 * "Open Datadog" theo ngôn ngữ người dùng chọn. `query-ui` là giao diện truy vấn của Prometheus/VictoriaMetrics.
 */
export const CONSOLE_APPS = [
  "datadog",
  "newrelic",
  "dynatrace",
  "grafana",
  "query-ui",
] as const;
export const consoleAppWire = z.enum(CONSOLE_APPS);

export const monitoringConsoleWire = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("url"),
      app: consoleAppWire,
      url: z.string().url(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("portForward"),
      app: consoleAppWire,
      command: z.string(),
      localUrl: z.string().url(),
    })
    .strict(),
]);

/** `GET /projects/:id/metrics/red?envId&range` */
export const redMetricsResponseWire = z
  .object({
    metrics: z
      .object({
        environmentId: uuid,
        range: redRangeWire,
        stepSeconds: z.number().int().positive(),
        /** Mốc của điểm đầu; điểm thứ i ở `start + i * stepSeconds` */
        start: isoDateTime,
        points: z.number().int().nonnegative(),
        source: z
          .object({ providerId: z.string(), tool: z.string().nullable() })
          .strict(),
        console: monitoringConsoleWire.nullable(),
        workloads: z.array(workloadRedWire),
      })
      .strict(),
  })
  .strict();

// ------------------------------------------------------------- Plan #53: trang chủ developer (QĐ-5)

export const homeProjectWire = z
  .object({
    id: uuid,
    name: z.string(),
    status: projectStatusWire,
    myRole: projectRoleWire,
    cloudProvider: cloudProviderWire.nullable(),
    environmentCount: z.number().int().nonnegative(),
    expiresAt: isoDateTime.nullable(),
    activeRollouts: z.number().int().nonnegative(),
    /** Số việc cần xử lý của project này (cùng tập với `attention`) */
    attention: z.number().int().nonnegative(),
  })
  .strict();

export const homeRolloutWire = z
  .object({
    id: uuid,
    projectId: uuid,
    projectName: z.string(),
    environment: envRefWire,
    /** Key flag, hoặc tên workload với rollout mức service */
    subject: z.string(),
    scope: z.enum(["FLAG_LEVEL", "SERVICE_LEVEL"]),
    status: z.enum(["PENDING", "IN_PROGRESS", "PAUSED"]),
    trafficPercentage: z.number().min(0).max(100),
    updatedAt: isoDateTime,
  })
  .strict();

export const HOME_ATTENTION_KINDS = [
  "DEPLOY_PENDING",
  "DOMAIN_ERROR",
  "DOMAIN_DRIFTED",
  "JOB_FAILED",
  "PROJECT_EXPIRING",
  "ROLLOUT_PAUSED",
] as const;

/** Một việc cần xử lý — mỗi loại dẫn thẳng tới chỗ sửa nó */
export const homeAttentionWire = z
  .object({
    kind: z.enum(HOME_ATTENTION_KINDS),
    projectId: uuid,
    projectName: z.string(),
    /** Domain, workload, loại job, key flag… — tuỳ loại */
    subject: z.string(),
    environment: envRefWire.nullable(),
    /** Id để dẫn link: deployment, rollout, job */
    refId: uuid.nullable(),
    at: isoDateTime,
  })
  .strict();

/** `GET /home` — mọi thứ lọc theo membership của người gọi */
export const homeResponseWire = z
  .object({
    home: z
      .object({
        projects: z.array(homeProjectWire),
        rollouts: z.array(homeRolloutWire),
        attention: z.array(homeAttentionWire),
        /** 14 ngày, cũ nhất trước, đủ mọi ngày (ngày không deploy là 0/0) */
        deploys: z.array(deployDayWire),
        generatedAt: isoDateTime,
      })
      .strict(),
  })
  .strict();

// ------------------------------------------------------------- Plan #53: Bảng điều khiển nền tảng (QĐ-6)

const countWire = z.number().int().nonnegative();

/** `GET /admin/overview` — số liệu nền tảng từ database */
export const adminOverviewResponseWire = z
  .object({
    overview: z
      .object({
        users: z
          .object({ total: countWire, admins: countWire, newLast7d: countWire })
          .strict(),
        projects: z
          .object({
            total: countWire,
            byStatus: z
              .object({
                DRAFT: countWire,
                PROVISIONING: countWire,
                ACTIVE: countWire,
                ERROR: countWire,
              })
              .strict(),
          })
          .strict(),
        clouds: z.array(
          z
            .object({ provider: cloudProviderWire, projects: countWire })
            .strict(),
        ),
        jobs: z
          .object({
            running: countWire,
            failed: countWire,
            compensationFailed: countWire,
            cancelRequested: countWire,
          })
          .strict(),
        orphans: z
          .object({
            count: countWire,
            usdPerHour: z.number().nonnegative(),
            unpriced: countWire,
          })
          .strict(),
        /** Mười công cụ được bật ở nhiều project nhất */
        tools: z.array(
          z
            .object({
              domainType: z.string(),
              toolId: z.string(),
              projects: countWire,
            })
            .strict(),
        ),
        deploys7d: z
          .object({ success: countWire, failure: countWire })
          .strict(),
        database: z
          .object({ sizeBytes: z.number().int().nonnegative().nullable() })
          .strict(),
        generatedAt: isoDateTime,
      })
      .strict(),
  })
  .strict();

/** Vì sao một tín hiệu nền tảng không đọc được — không bao giờ đoán thay */
export const PLATFORM_UNAVAILABLE = [
  "NOT_IN_CLUSTER",
  "NOT_CONFIGURED",
  "FORBIDDEN",
  "UNAVAILABLE",
] as const;
const unavailableWire = z
  .object({
    state: z.literal("unavailable"),
    reason: z.enum(PLATFORM_UNAVAILABLE),
  })
  .strict();

const signal = <T extends z.ZodRawShape>(shape: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("ok"), ...shape }).strict(),
    unavailableWire,
  ]);

/** `GET /admin/platform` — tín hiệu của chính cụm đang chạy UDP (máy ảo Oracle, kind…) */
export const adminPlatformResponseWire = z
  .object({
    platform: z
      .object({
        /** Tag commit của bản đang chạy (`UDP_RELEASE`); `null` khi không khai */
        release: z.string().nullable(),
        node: signal({
          name: z.string(),
          cpuCores: z.number().positive(),
          cpuUsedCores: z.number().nonnegative(),
          memoryBytes: z.number().int().positive(),
          memoryUsedBytes: z.number().int().nonnegative(),
        }),
        postgresVolume: signal({
          capacityBytes: z.number().int().positive(),
        }),
        backup: signal({
          schedule: z.string(),
          lastScheduleAt: isoDateTime.nullable(),
          lastSuccessAt: isoDateTime.nullable(),
          lastFailureAt: isoDateTime.nullable(),
        }),
        certificate: signal({
          name: z.string(),
          ready: z.boolean(),
          notAfter: isoDateTime.nullable(),
          issuer: z.string().nullable(),
        }),
        checkedAt: isoDateTime,
      })
      .strict(),
  })
  .strict();

export type ArchitectureWire = z.infer<
  typeof architectureResponseWire
>["architecture"];
export type ArchitectureToolWire = z.infer<typeof architectureToolWire>;
export type RedMetricsWire = z.infer<typeof redMetricsResponseWire>["metrics"];
export type WorkloadRedWire = z.infer<typeof workloadRedWire>;
export type MonitoringConsoleWire = z.infer<typeof monitoringConsoleWire>;
export type HomeWire = z.infer<typeof homeResponseWire>["home"];
export type HomeAttentionWire = z.infer<typeof homeAttentionWire>;
export type AdminOverviewWire = z.infer<
  typeof adminOverviewResponseWire
>["overview"];
export type AdminPlatformWire = z.infer<
  typeof adminPlatformResponseWire
>["platform"];
export type AdminSystemWire = z.infer<typeof adminSystemResponseWire>;
