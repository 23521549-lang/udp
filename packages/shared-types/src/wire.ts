import { z } from "zod";
import { readAttributeConditionSchema, RULE_TYPES } from "./condition.js";
import { flagServeUnion } from "./evaluation.js";
import { FLAG_TYPES } from "./flag-value.js";
import {
  flagStatsResponseSchema,
  staleFlagsResponseSchema,
} from "./flag-stats.js";
import { DECISIONS, INTENT_ACTIONS } from "./rollout.js";

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
export const projectListResponseWire = z
  .object({ projects: z.array(publicProjectWire) })
  .strict();

/** `POST /projects` (201) và `GET /projects/:id` — cùng một phong bì (§8.1) */
export const projectDetailResponseWire = z
  .object({
    project: publicProjectWire,
    environments: z.array(publicEnvironmentWire),
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
export const auditListResponseWire = z
  .object({ entries: z.array(auditEntryWire) })
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
export const flagListResponseWire = z
  .object({ flags: z.array(flagSummaryWire) })
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

export const adminUsersResponseWire = z
  .object({ users: z.array(adminUserWire) })
  .strict();
export const adminUserResponseWire = z.object({ user: adminUserWire }).strict();

const cloudProviderWire = z.enum(["AWS", "GCP", "AZURE"]);

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
export type AuditEntryWire = z.infer<typeof auditEntryWire>;
export type SdkKeyWire = z.infer<typeof sdkKeyWire>;
export type FlagEnvStateWire = z.infer<typeof flagEnvStateWire>;
export type FlagVariantWire = z.infer<typeof flagVariantWire>;
export type FlagDetailWire = z.infer<typeof flagDetailWire>;
export type FlagSummaryWire = z.infer<typeof flagSummaryWire>;
export type RuleWire = z.infer<typeof ruleWire>;
export type RulesResponseWire = z.infer<typeof rulesResponseWire>;
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
export type DoraWire = z.infer<typeof doraWire>;
export type AdminUserWire = z.infer<typeof adminUserWire>;
export type AdminOrphansResponseWire = z.infer<typeof adminOrphansResponseWire>;
export type RolloutIntentActionWire = z.infer<typeof rolloutIntentActionWire>;
