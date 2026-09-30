import type {
  AuditEntryWire,
  ProjectRoleWire,
  RuleWire,
} from "@udp/shared-types/wire";
import { iso, OPENED_AT } from "./clock";
import type { ProjectRecord } from "./db";
import { between, fnv, pick, prng, uuid, uuidOf, type Rng } from "./random";

/**
 * Nhật ký thao tác của một project, dựng TỪ chính dữ liệu của nó: mỗi flag có lần tạo, lần kích hoạt, lần bật ở
 * từng environment và lần sửa rule; mỗi SDK key, thành viên, lời mời, rollout, lần duyệt deploy prod đều có một
 * dòng đúng lúc nó xảy ra, do đúng thành viên của project làm. Mã hành động và hình `before`/`after` theo Service 1
 * và Service 2 (`flag.rule.update`, `sdkkey.create`, `rollout.intent`…). Hạt giống RIÊNG theo tên project, nên
 * thêm dòng ở đây không xê dịch id của dữ liệu khác.
 *
 * Khác Service 2 một chỗ, có chủ ý: dòng `flag.env.update`/`flag.rule.update` mang thêm `flagKey` để câu đọc được
 * nêu tên flag (Service 2 hiện chỉ ghi id cấu hình theo environment).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Chỉ duyệt deploy prod trong ngần này ngày gần nhất: đủ dày mà không lấn hết nhật ký */
const APPROVAL_DAYS = 60;

/** Việc lặt vặt hằng ngày trải trong ngần này ngày gần nhất */
const CHURN_DAYS = 75;

const RANK: Record<ProjectRoleWire, number> = {
  VIEWER: 0,
  DEVELOPER: 1,
  MAINTAINER: 2,
  OWNER: 3,
};

/** Id credential mà trang Credential của quản trị và nhật ký cùng dùng */
export const cloudCredentialId = (projectId: string): string =>
  uuidOf(`cloud:${projectId}`);

/** Rule như Service 2 ghi vào audit (`ruleAuditView`) */
const ruleView = (rules: readonly RuleWire[] | undefined) =>
  (rules ?? []).map((r) => ({
    id: r.id,
    priority: r.priority,
    ruleType: r.ruleType,
    condition: r.condition,
    serve: r.serve,
    description: r.description,
  }));

/** Một mốc trong giờ làm việc ở Việt Nam (8:30–18:30, UTC+7) của ngày chứa `ms` */
function workHourOf(rng: Rng, ms: number): number {
  const day = Math.floor((ms + 7 * HOUR) / DAY) * DAY - 7 * HOUR;
  return day + 8.5 * HOUR + between(rng, 0, 600) * MINUTE;
}

export function auditTrail(p: ProjectRecord, target = 0): AuditEntryWire[] {
  const rng = prng(fnv(`audit:${p.project.name}`));
  const out: AuditEntryWire[] = [];
  const owner = p.project.ownerId;
  const withRole = (min: ProjectRoleWire): string[] => {
    const ids = p.members
      .filter((m) => RANK[m.projectRole] >= RANK[min])
      .map((m) => m.userId);
    return ids.length > 0 ? ids : [owner];
  };
  const writers = withRole("DEVELOPER");
  const staff = withRole("MAINTAINER");
  const born = Date.parse(p.project.createdAt);
  const now = OPENED_AT - 2 * MINUTE;

  const add = (
    at: number | string,
    action: string,
    actor: string | null,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown,
    environmentId: string | null = null,
  ): void => {
    const ms = typeof at === "number" ? at : Date.parse(at);
    if (ms > now || ms < born) return;
    out.push({
      id: uuid(rng),
      action,
      actorType: actor === null ? "SYSTEM" : "USER",
      actorUserId: actor,
      targetType,
      targetId,
      environmentId,
      before,
      after,
      occurredAt: iso(ms),
    });
  };
  const later = (at: string, min: number, max: number): number =>
    Date.parse(at) + between(rng, min, max) * MINUTE;

  // ------------------------------------------------ project, cloud, hạ tầng
  add(born, "project.create", owner, "Project", p.project.id, null, {
    name: p.project.name,
    creationMode: p.project.creationMode,
    languageRuntime: p.project.languageRuntime,
  });
  const credentials = [
    ...p.retiredClouds,
    ...(p.cloud === null
      ? []
      : [{ id: cloudCredentialId(p.project.id), cloud: p.cloud }]),
  ];
  for (const { id, cloud } of credentials) {
    add(
      cloud.createdAt,
      "cloud.credential.set",
      cloud.createdBy.id,
      "CloudCredential",
      id,
      null,
      {
        provider: cloud.provider,
        mode: cloud.mode,
        authKind: cloud.authKind,
        region: cloud.region,
        fingerprint: cloud.fingerprint,
      },
    );
  }
  const prod = p.environments.find((e) => e.isProduction);
  if (prod !== undefined && !prod.autoDeploy) {
    add(
      later(p.project.createdAt, 20, 180),
      "environment.update",
      owner,
      "Environment",
      prod.id,
      { autoDeploy: true },
      { autoDeploy: false },
      prod.id,
    );
  }
  if (p.project.resourceQuota.maxNodes !== 3) {
    add(
      later(p.project.createdAt, 1500, 4000),
      "project.quota.update",
      pick(rng, staff),
      "Project",
      p.project.id,
      { maxNodes: 3 },
      { maxNodes: p.project.resourceQuota.maxNodes },
    );
  }
  if (p.project.expiresAt !== null) {
    add(
      later(p.project.createdAt, 30, 600),
      "project.ttl.update",
      owner,
      "Project",
      p.project.id,
      { expiresAt: null },
      { expiresAt: p.project.expiresAt },
    );
  }
  const enabled = p.domains.domains
    .filter((d) => d.isEnabled)
    .map((d) => `${d.domainType}:${d.selectedTool ?? ""}`);
  for (const { detail } of p.jobs) {
    const { job } = detail;
    if (job.jobType === "PROVISION") {
      add(
        job.createdAt,
        "project.provision",
        owner,
        "ProvisioningJob",
        job.id,
        null,
        { confirmedMonthlyUsd: job.confirmedMonthlyUsd },
      );
    }
    if (job.jobType === "DOMAIN_APPLY") {
      add(
        Date.parse(job.createdAt) - between(rng, 1, 4) * MINUTE,
        "domain.config.set",
        pick(rng, staff),
        "Project",
        p.project.id,
        null,
        { enabled, preferences: p.domains.preferences },
      );
      add(
        job.updatedAt,
        "domain.config.apply",
        null,
        "ProvisioningJob",
        job.id,
        null,
        job.lastError === null
          ? { state: job.state }
          : { state: job.state, error: job.lastError.message },
      );
    }
    if (job.state === "CANCEL_REQUESTED") {
      add(
        job.updatedAt,
        "provision.cancel",
        pick(rng, staff),
        "ProvisioningJob",
        job.id,
        { state: "DOMAINS" },
        { state: "CANCEL_REQUESTED" },
      );
    }
  }
  for (const d of p.domains.domains) {
    const versions = p.domains.versions[d.domainType];
    if (d.status === "ERROR" && d.updatedAt !== null) {
      add(
        later(d.updatedAt, 60, 900),
        "domain.reapply",
        pick(rng, staff),
        "Project",
        p.project.id,
        { domainType: d.domainType, status: "ERROR" },
        { domainType: d.domainType, status: "DEPLOYING" },
      );
    }
    if (versions !== undefined && rng() < 0.18) {
      add(
        workHourOf(rng, now - between(rng, 3, 50) * DAY),
        "domain.upgrade",
        pick(rng, staff),
        "Project",
        p.project.id,
        { domainType: d.domainType, version: "0.9.0" },
        { domainType: d.domainType, version: versions.current },
      );
    }
  }
  if (p.cicd !== null) {
    add(
      later(p.project.createdAt, 1440, 2880),
      "cicd.webhook_secret.create",
      owner,
      "DomainConfig",
      p.project.id,
      null,
      { provider: p.cicd.provider },
    );
    if (rng() < 0.6) {
      add(
        workHourOf(rng, now - between(rng, 5, 45) * DAY),
        "cicd.webhook_secret.rotate",
        pick(rng, staff),
        "DomainConfig",
        p.project.id,
        null,
        { provider: p.cicd.provider },
      );
    }
    for (let i = between(rng, 1, 3); i > 0; i--) {
      add(
        now - between(rng, 60, 30 * 24 * 60) * MINUTE,
        "cicd.webhook.rejected",
        null,
        "Project",
        p.project.id,
        null,
        {
          reason: pick(rng, [
            "Chữ ký HMAC không khớp secret hiện tại",
            "Thiếu header X-UDP-Signature",
            "Sự kiện quá cũ: lệch đồng hồ hơn 300 giây",
          ]),
        },
      );
    }
  }

  // ------------------------------------------------ người
  for (const m of p.members) {
    if (m.projectRole === "OWNER") continue;
    const start: ProjectRoleWire =
      m.projectRole === "VIEWER" || rng() < 0.6 ? m.projectRole : "VIEWER";
    add(m.createdAt, "member.add", owner, "ProjectMember", m.userId, null, {
      projectRole: start,
    });
    if (start !== m.projectRole) {
      add(
        later(m.createdAt, 2 * 1440, 20 * 1440),
        "member.role.update",
        owner,
        "ProjectMember",
        m.userId,
        { projectRole: start },
        { projectRole: m.projectRole },
      );
    }
  }
  for (const g of p.teamGrants) {
    add(g.createdAt, "team.grant", owner, "Team", g.teamId, null, {
      projectRole: g.projectRole,
    });
  }
  for (const inv of p.invitations) {
    add(
      inv.createdAt,
      "invitation.create",
      inv.invitedBy.id,
      "Invitation",
      inv.id,
      null,
      { email: inv.email, projectRole: inv.projectRole },
    );
  }
  for (const [envId, keys] of Object.entries(p.sdkKeys)) {
    for (const key of keys) {
      add(
        key.createdAt,
        "sdkkey.create",
        key.createdBy.id,
        "SdkKey",
        key.id,
        null,
        { keyType: key.keyType, keySuffix: key.keySuffix, label: key.label },
        envId,
      );
      if (key.revokedAt !== null) {
        add(
          key.revokedAt,
          "sdkkey.revoke",
          pick(rng, staff),
          "SdkKey",
          key.id,
          { keySuffix: key.keySuffix, status: "active" },
          { status: "revoked" },
          envId,
        );
      }
    }
  }

  // ------------------------------------------------ flag và segment
  for (const f of p.flags) {
    const flag = f.detail;
    add(
      flag.createdAt,
      "flag.create",
      pick(rng, writers),
      "FeatureFlag",
      flag.id,
      null,
      { key: flag.key, flagType: flag.flagType, description: flag.description },
    );
    if (flag.activatedAt !== null) {
      add(
        flag.activatedAt,
        "flag.activate",
        pick(rng, writers),
        "FeatureFlag",
        flag.id,
        { lifecycleStatus: "DRAFT" },
        { lifecycleStatus: "ACTIVE" },
      );
    }
    if (flag.lifecycleStatus === "ARCHIVED") {
      add(
        flag.updatedAt,
        "flag.archive",
        pick(rng, staff),
        "FeatureFlag",
        flag.id,
        { lifecycleStatus: "ACTIVE" },
        { lifecycleStatus: "ARCHIVED" },
      );
    }
    for (const [rank, env] of flag.envs.entries()) {
      const envId = env.environment.id;
      const actor = env.environment.isProduction
        ? pick(rng, staff)
        : pick(rng, writers);
      // dev trước, prod sau: bật dần qua từng environment
      const opened = later(
        flag.createdAt,
        30 + rank * 240,
        60 * 24 * (rank + 1),
      );
      if (env.isEnabled) {
        add(
          opened,
          "flag.env.update",
          actor,
          "FlagEnvConfig",
          env.configId,
          { isEnabled: false, defaultVariant: null },
          { isEnabled: true, defaultVariant: null, flagKey: flag.key },
          envId,
        );
      }
      const view = ruleView(f.rules[envId]);
      if (view.length > 0) {
        const at = env.environment.isProduction
          ? Date.parse(f.rulesUpdatedAt[envId] ?? flag.updatedAt)
          : opened + between(rng, 5, 40) * MINUTE;
        add(
          at,
          "flag.rule.update",
          actor,
          "FlagEnvConfig",
          env.configId,
          { rules: view.slice(0, -1) },
          { rules: view, flagKey: flag.key },
          envId,
        );
      }
    }
  }
  for (const s of p.segments) {
    add(
      s.createdAt,
      "segment.create",
      pick(rng, writers),
      "Segment",
      s.id,
      null,
      {
        name: s.name,
        conditionCount: s.summary.conditionCount,
        userIdCount: s.summary.userIdCount,
      },
    );
    if (Date.parse(s.updatedAt) - Date.parse(s.createdAt) > HOUR) {
      add(
        s.updatedAt,
        "segment.update",
        pick(rng, writers),
        "Segment",
        s.id,
        null,
        {
          name: s.name,
          conditionCount: s.summary.conditionCount,
          userIdCount: s.summary.userIdCount,
        },
      );
    }
  }

  // ------------------------------------------------ phát hành
  for (const r of p.rollouts) {
    add(
      Date.parse(r.createdAt) - between(rng, 1, 5) * MINUTE,
      "rollout.create",
      r.environment.isProduction ? pick(rng, staff) : pick(rng, writers),
      "rollout_session",
      r.id,
      null,
      {
        scope: r.scope,
        strategy: r.strategy,
        workloadName: r.workloadName,
        stepPercent: r.stepPercent,
        ...(r.flag === undefined ? {} : { flagKey: r.flag.key }),
      },
      r.environment.id,
    );
    for (const e of r.events) {
      if (e.triggeredBy !== "MANUAL") continue;
      add(
        e.createdAt,
        "rollout.intent",
        e.actorUserId ?? owner,
        "rollout_session",
        r.id,
        null,
        { action: e.action },
        r.environment.id,
      );
    }
  }
  if (prod !== undefined && !prod.autoDeploy) {
    for (const d of p.deployments[prod.id] ?? []) {
      if (d.triggeredBy !== "WEBHOOK" || d.status === "DEPLOY_PENDING")
        continue;
      if (Date.parse(d.startedAt) < now - APPROVAL_DAYS * DAY) continue;
      add(
        Date.parse(d.startedAt) - between(rng, 2, 25) * MINUTE,
        "deployment.approve",
        pick(rng, staff),
        "Deployment",
        d.deploymentId,
        { status: "DEPLOY_PENDING" },
        { status: "DEPLOY_START", imageTag: d.imageTag },
        prod.id,
      );
    }
  }

  // ------------------------------------------------ việc lặt vặt hằng ngày
  const live = p.flags.filter(
    (f) => f.detail.lifecycleStatus === "ACTIVE" && !f.detail.permanent,
  );
  const lower = p.environments.filter((e) => !e.isProduction);
  const from = Math.max(born + DAY, now - CHURN_DAYS * DAY);
  for (let guard = 0; out.length < target && guard < target * 3; guard++) {
    const at = workHourOf(rng, from + rng() * (now - from));
    const flag = live.length === 0 ? undefined : pick(rng, live);
    const env = lower.length === 0 ? undefined : pick(rng, lower);
    const segment = p.segments.length === 0 ? undefined : pick(rng, p.segments);
    const config = flag?.detail.envs.find((e) => e.environment.id === env?.id);
    const roll = rng();
    if (flag !== undefined && config !== undefined && roll < 0.5) {
      // Tắt để thử rồi bật lại: việc quen của người kiểm ở dev và staging
      const actor = pick(rng, writers);
      add(
        at,
        "flag.env.update",
        actor,
        "FlagEnvConfig",
        config.configId,
        { isEnabled: true, defaultVariant: null },
        { isEnabled: false, defaultVariant: null, flagKey: flag.detail.key },
        config.environment.id,
      );
      add(
        at + between(rng, 8, 95) * MINUTE,
        "flag.env.update",
        actor,
        "FlagEnvConfig",
        config.configId,
        { isEnabled: false, defaultVariant: null },
        { isEnabled: true, defaultVariant: null, flagKey: flag.detail.key },
        config.environment.id,
      );
    } else if (flag !== undefined && config !== undefined && roll < 0.85) {
      const view = ruleView(flag.rules[config.environment.id]);
      add(
        at,
        "flag.rule.update",
        pick(rng, writers),
        "FlagEnvConfig",
        config.configId,
        { rules: view.slice(1) },
        { rules: view, flagKey: flag.detail.key },
        config.environment.id,
      );
    } else if (segment !== undefined) {
      add(
        at,
        "segment.update",
        pick(rng, writers),
        "Segment",
        segment.id,
        null,
        { name: segment.name, userIdCount: segment.summary.userIdCount },
      );
    } else if (env !== undefined) {
      add(
        at,
        "environment.update",
        pick(rng, staff),
        "Environment",
        env.id,
        { autoDeploy: !env.autoDeploy },
        { autoDeploy: env.autoDeploy },
        env.id,
      );
    }
  }
  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}
