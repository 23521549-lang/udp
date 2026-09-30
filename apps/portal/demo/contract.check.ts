import { beforeAll, describe, expect, it } from "vitest";
import {
  ARCHITECTURE_DEPLOY_DAYS,
  EVIDENCE_DORA_DAYS,
  RED_RANGES,
} from "@udp/shared-types/wire";
import { ADMIN_PAGE_SIZE, adminApi } from "../src/features/admin/admin-api";
import { architectureApi } from "../src/features/architecture/architecture-api";
import { authApi } from "../src/features/auth/auth-api";
import { codeApi } from "../src/features/code/code-api";
import { deploymentApi } from "../src/features/deployment/deployment-api";
import { domainApi } from "../src/features/domain/domain-api";
import { flagApi } from "../src/features/flag/flag-api";
import { homeApi } from "../src/features/home/home-api";
import { invitationApi } from "../src/features/invitation/invitation-api";
import { monitoringApi } from "../src/features/monitoring/monitoring-api";
import { cloudApi } from "../src/features/project/cloud/cloud-api";
import { projectApi } from "../src/features/project/project-api";
import { provisioningApi } from "../src/features/provisioning/provisioning-api";
import { rolloutApi } from "../src/features/rollout/rollout-api";
import { segmentApi } from "../src/features/segment/segment-api";
import { projectTeamApi, teamApi } from "../src/features/team/team-api";
import { isApiError } from "../src/lib/http";
import {
  backupVerdict,
  certificateVerdict,
  idleRisk,
} from "../src/features/admin/platform-model";
import { DEMO_INVITE_TOKEN } from "./mock/demo-invite";
import { DEFAULT_SETUP, type DemoSetup } from "./mock/persona";
import { API_PREFIX, createMockBackend, type MockBackend } from "./mock/server";

/**
 * Hợp đồng của bản xem thử: gọi MỌI hàm API của Portal qua lớp giả lập — đúng hàm, đúng schema dây mà các màn
 * hình dùng. Một response giả lệch hình là `ApiError` kind `contract` ở đây, không phải một màn hình trắng lúc xem.
 *
 *   npx vitest run --config demo/vitest.config.ts        (trong apps/portal)
 */

/** Backend đang trả lời: của quản trị viên mặc định, hay của một vai khác trong `as(...)` */
let backend: MockBackend;

beforeAll(() => {
  backend = createMockBackend();
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
      throw new Error(`fetch ngoài API trong test: ${url.href}`);
    }
    const text = await request.text();
    return backend.handle(
      request.method,
      url,
      text === "" ? undefined : (JSON.parse(text) as unknown),
    );
  };
});

/** Chạy `run` với một bản xem thử MỚI của vai hay tình huống khác, rồi trả lại backend cũ */
async function as<T>(
  setup: Partial<DemoSetup>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = backend;
  backend = createMockBackend({ ...DEFAULT_SETUP, ...setup });
  try {
    return await run();
  } finally {
    backend = previous;
  }
}

const tz = "Asia/Ho_Chi_Minh";

async function projectsByName() {
  const { projects } = await projectApi.list(0);
  return new Map(projects.map((p) => [p.name, p]));
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (e) {
    expect(isApiError(e) ? e.status : e).toBe(status);
    expect(isApiError(e) ? e.kind : "").toBe("http");
    return;
  }
  throw new Error(`mong đợi lỗi ${String(status)}, nhận thành công`);
}

/** Mọi dòng của một danh sách quản trị theo trang */
async function allPages<T>(
  load: (offset: number) => Promise<{ total: number; rows: T[] }>,
): Promise<T[]> {
  const first = await load(0);
  const rows = [...first.rows];
  for (let o = ADMIN_PAGE_SIZE; o < first.total; o += ADMIN_PAGE_SIZE) {
    rows.push(...(await load(o)).rows);
  }
  return rows;
}

const JOB_STATES = [
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
] as const;

describe("đăng nhập và quản trị", () => {
  it("phiên, và mọi trang quản trị", async () => {
    expect((await authApi.me()).user.platformRole).toBe("PLATFORM_ADMIN");
    expect(
      (await authApi.login({ email: "a@b.dev", password: "x" })).user,
    ).toBeDefined();
    // Đủ người cho nhiều trang: trang đầu đầy, trang cuối là phần còn lại; người mới đăng ký lên đầu
    const { users, total } = await adminApi.users({}, 0);
    expect(total).toBe(161);
    expect(users.length).toBe(ADMIN_PAGE_SIZE);
    const lastOffset =
      Math.floor((total - 1) / ADMIN_PAGE_SIZE) * ADMIN_PAGE_SIZE;
    const last = await adminApi.users({}, lastOffset);
    expect(last.users.length).toBe(total - lastOffset);
    expect(users.map((u) => u.createdAt)).toEqual(
      users
        .map((u) => u.createdAt)
        .sort()
        .reverse(),
    );
    const oldest = await adminApi.users({ order: "asc" }, 0);
    expect(oldest.users[0]?.createdAt).toBe(last.users.at(-1)?.createdAt);
    expect((await adminApi.users({ search: "khánh" }, 0)).users.length).toBe(1);
    const target = users.find((u) => u.platformRole === "USER");
    expect(
      (await adminApi.setRole(target?.id ?? "", "PLATFORM_ADMIN")).user
        .platformRole,
    ).toBe("PLATFORM_ADMIN");
    const admins = await adminApi.users({ platformRole: "PLATFORM_ADMIN" }, 0);
    expect(admins.total).toBeGreaterThanOrEqual(5);
    expect(admins.users.every((u) => u.platformRole === "PLATFORM_ADMIN")).toBe(
      true,
    );

    const projects = await adminApi.projects({}, 0);
    expect(projects.total).toBe(37);
    const byStatus: Record<string, number> = {};
    for (const status of [
      "DRAFT",
      "PROVISIONING",
      "ACTIVE",
      "ERROR",
      "DELETED",
    ] as const) {
      byStatus[status] = (await adminApi.projects({ status }, 0)).total;
      expect(byStatus[status]).toBeGreaterThan(0);
    }
    expect(byStatus["DELETED"]).toBeGreaterThanOrEqual(3);
    // Tìm theo tên project hay email của chủ
    expect(
      (await adminApi.projects({ search: "checkout" }, 0)).projects.map(
        (p) => p.name,
      ),
    ).toEqual(["checkout-service"]);
    const someOwner = projects.projects[0]?.owner.email ?? "";
    expect(
      (await adminApi.projects({ search: someOwner }, 0)).total,
    ).toBeGreaterThan(0);

    // Credential: đang dùng, chưa kiểm lần nào, đã thôi dùng (bị thay hay project đã xoá)
    const { credentials } = await adminApi.credentials();
    expect(
      credentials.some((c) => c.isActive && c.lastValidatedAt !== null),
    ).toBe(true);
    expect(
      credentials.some((c) => c.isActive && c.lastValidatedAt === null),
    ).toBe(true);
    expect(
      credentials.filter((c) => !c.isActive).length,
    ).toBeGreaterThanOrEqual(4);
    expect(new Set(credentials.map((c) => c.id)).size).toBe(credentials.length);

    // Job ở MỌI trạng thái; lỗi có câu đọc được
    const jobs: Record<string, number> = {};
    for (const state of JOB_STATES) {
      jobs[state] = (await adminApi.jobs(state, 0)).total;
      expect(jobs[state], state).toBeGreaterThan(0);
    }
    expect(jobs["FAILED"]).toBeGreaterThanOrEqual(5);
    expect(jobs["COMPENSATION_FAILED"]).toBeGreaterThanOrEqual(5);
    for (const j of (await adminApi.jobs("COMPENSATION_FAILED", 0)).jobs) {
      expect((j.lastError as { message?: string }).message).toMatch(/\S{10}/);
    }

    // Tài nguyên mồ côi ở cả ba cloud, trải nhiều ngày, có loại chưa rõ giá; id ổn định giữa hai lần gọi
    const orphans = await adminApi.orphans();
    expect(orphans.resources.length).toBe(13);
    expect(new Set(orphans.resources.map((r) => r.provider)).size).toBe(3);
    expect(orphans.unpriced.length).toBeGreaterThanOrEqual(3);
    expect(
      new Set(orphans.resources.map((r) => r.updatedAt.slice(0, 10))).size,
    ).toBeGreaterThanOrEqual(5);
    expect((await adminApi.orphans()).resources.map((r) => r.id)).toEqual(
      orphans.resources.map((r) => r.id),
    );

    // Tổng quan của Bảng điều khiển: số liệu khớp các danh sách, cụm có đủ tín hiệu
    const { overview } = await adminApi.overview();
    expect(overview.users.total).toBe(total);
    expect(overview.users.admins).toBe(admins.total);
    expect(overview.users.newLast7d).toBeGreaterThan(0);
    expect(overview.projects.total).toBe(
      projects.total - (byStatus["DELETED"] ?? 0),
    );
    for (const [status, count] of Object.entries(overview.projects.byStatus)) {
      expect(count, status).toBe(byStatus[status]);
    }
    expect(overview.jobs.failed).toBe(jobs["FAILED"]);
    expect(overview.jobs.compensationFailed).toBe(jobs["COMPENSATION_FAILED"]);
    expect(overview.jobs.cancelRequested).toBe(jobs["CANCEL_REQUESTED"]);
    expect(overview.jobs.running).toBe(
      (await adminApi.jobs("ACTIVE", 0)).total,
    );
    expect(overview.clouds.map((c) => c.provider).sort()).toEqual([
      "AWS",
      "AZURE",
      "GCP",
    ]);
    expect(overview.orphans.count).toBe(orphans.resources.length);
    expect(overview.orphans.unpriced).toBe(orphans.unpriced.length);
    expect(overview.tools.length).toBe(10);
    const { platform } = await adminApi.platform();
    expect(platform.node.state).toBe("ok");
    expect(platform.release).not.toBeNull();
    expect(
      (await adminApi.system()).services.every((s) => s.status === "up"),
    ).toBe(true);
    expect((await domainApi.catalog()).domains.length).toBe(16);

    // [Plan #56] E10 của cả nền tảng: đúng số ngày lịch, có project đã deploy vào production
    for (const days of EVIDENCE_DORA_DAYS) {
      const { evidence } = await adminApi.evidenceDora(days);
      expect(evidence.daily).toHaveLength(days);
      expect(evidence.projects.some((p) => p.dora.deployments > 0)).toBe(true);
    }
  });
});

describe("trang chủ", () => {
  it("việc cần xử lý đủ sáu loại, rollout đang chạy, deploy 14 ngày", async () => {
    const { home } = await homeApi.get();
    // [Plan #55] `data-pipeline` vào được qua nhóm "Nền tảng"
    expect(home.projects.length).toBe(13);
    expect(home.projects.length).toBe((await projectApi.list(0)).total);
    expect(new Set(home.attention.map((a) => a.kind))).toEqual(
      new Set([
        "DEPLOY_PENDING",
        "DOMAIN_ERROR",
        "DOMAIN_DRIFTED",
        "JOB_FAILED",
        "PROJECT_EXPIRING",
        "ROLLOUT_PAUSED",
      ]),
    );
    expect(home.rollouts.length).toBeGreaterThanOrEqual(4);
    expect(home.deploys.length).toBe(14);
    expect(home.deploys.some((d) => d.failure > 0)).toBe(true);
  });
});

describe("mọi project người xem thấy", () => {
  it("tổng quan, thành viên, nhật ký, khoá, cloud, flag, segment, rollout, deploy, domain, hạ tầng, code", async () => {
    const projects = await projectsByName();
    expect([...projects.keys()].sort()).toEqual([
      "analytics-api",
      "checkout-service",
      "data-pipeline",
      "fraud-detector",
      "legacy-billing",
      "marketing-site",
      "mobile-bff",
      "notification-worker",
      "payment-gateway",
      "search-service",
      "seller-center",
      "shipping-fee-api",
      "voucher-service",
    ]);
    for (const project of projects.values()) {
      const { environments, cluster } = await projectApi.get(project.id);
      const { architecture } = await architectureApi.get(project.id);
      expect(architecture.environments.length).toBe(environments.length);
      // [Plan #57] Đủ 14 ngày UTC tới hết hôm nay, như Service 1
      expect(architecture.deploys).toHaveLength(ARCHITECTURE_DEPLOY_DAYS);
      expect(architecture.deploys.at(-1)?.date).toBe(
        new Date().toISOString().slice(0, 10),
      );
      const monitored = architecture.tools.some(
        (t) => t.domainType === "MONITORING",
      );
      await projectApi.members(project.id);
      await projectTeamApi.list(project.id);
      if (project.myRole === "OWNER") {
        await invitationApi.ofProject(project.id);
      }
      await projectApi.audit(project.id, {});
      await cloudApi.get(project.id);
      await provisioningApi.preview(project.id);
      const { jobs } = await provisioningApi.jobs(project.id);
      for (const job of jobs) await provisioningApi.job(project.id, job.id);
      await segmentApi.list(project.id);
      await flagApi.stale(project.id, undefined);
      await codeApi.goldenPath(project.id);
      const domains = await domainApi.list(project.id);
      for (const d of domains.domains) {
        await domainApi.one(project.id, d.domainType);
        await domainApi.drift(project.id, d.domainType);
        if (d.isEnabled) await domainApi.versions(project.id, d.domainType);
      }
      if (cluster === null) {
        await expectStatus(provisioningApi.cost(project.id, 7), 409);
      } else {
        const { cost } = await provisioningApi.cost(project.id, 30);
        // Tổng các ngày BẰNG tổng kỳ, tới từng cent
        expect(
          Math.round(cost.daily.reduce((s, d) => s + d.totalUsd, 0) * 100),
        ).toBe(Math.round(cost.totalUsd * 100));
        await domainApi.cicd(project.id);
        await domainApi.pipelineTemplate(project.id);
      }
      for (const env of environments) {
        for (const range of RED_RANGES) {
          if (monitored && cluster !== null) {
            const { metrics } = await monitoringApi.red(
              project.id,
              env.id,
              range,
            );
            expect(
              metrics.workloads.every(
                (w) => w.requestRate.length === metrics.points,
              ),
            ).toBe(true);
          } else {
            await expectStatus(
              monitoringApi.red(project.id, env.id, range),
              409,
            );
          }
        }
        await projectApi.sdkKeys(project.id, env.id);
        await deploymentApi.list(project.id, env.id);
        await deploymentApi.latest(project.id, env.id);
        await deploymentApi.dora(project.id, env.id, 30);
        await rolloutApi.list(project.id, env.id);
        const page = await flagApi.page(project.id, env.id, tz, {
          stats: true,
        });
        await flagApi.count(project.id, env.id, { isEnabled: true });
        for (const f of page.flags) {
          await flagApi.get(project.id, f.id);
          await flagApi.envs(project.id, f.id);
          await flagApi.rules(project.id, f.id, env.id);
          await flagApi.stats(project.id, f.id, env.id, 14, tz);
          await flagApi.evaluate(project.id, f.id, env.id, {
            targetingKey: "cus-10231",
            country: "VN",
            platform: "ios",
          });
        }
      }
      await rolloutApi.active(project.id);
    }
  });

  it("checkout-service đủ dữ liệu cho mọi màn hình", async () => {
    const p = (await projectsByName()).get("checkout-service");
    if (p === undefined) throw new Error("thiếu checkout-service");
    const { environments } = await projectApi.get(p.id);
    const prod = environments.find((e) => e.isProduction);
    if (prod === undefined) throw new Error("thiếu prod");
    expect((await flagApi.page(p.id, prod.id, tz)).total).toBe(54);
    expect((await segmentApi.list(p.id)).segments.length).toBe(12);
    expect(
      (await rolloutApi.active(p.id)).rollouts.length,
    ).toBeGreaterThanOrEqual(2);
    const deployments = await deploymentApi.list(p.id, prod.id);
    expect(deployments.deployments[0]?.status).toBe("DEPLOY_PENDING");
    for (const d of deployments.deployments.slice(0, 5)) {
      await deploymentApi.logs(p.id, d.deploymentId);
    }
    const dora = (await deploymentApi.dora(p.id, prod.id, 30)).dora;
    expect(dora.deployments).toBeGreaterThan(5);
    expect(dora.changeFailureRate.value).not.toBeNull();
    const stale = await flagApi.stale(p.id, undefined);
    expect(stale.total).toBeGreaterThanOrEqual(4);
    for (const s of (await segmentApi.list(p.id)).segments)
      await segmentApi.get(p.id, s.id);
    const rollouts = await rolloutApi.list(p.id, prod.id);
    for (const r of rollouts.rollouts) await rolloutApi.get(p.id, r.id);
    expect((await domainApi.drift(p.id, "GITOPS")).drift.verdict).toBe(
      "DRIFTED",
    );
    expect(
      (await domainApi.versions(p.id, "MONITORING")).versions.available.length,
    ).toBe(1);
  });

  it("checkout-service: flag hai trang đủ vòng đời, rule nhiều điều kiện, rollout có tên, nhật ký dày", async () => {
    const p = (await projectsByName()).get("checkout-service");
    if (p === undefined) throw new Error("thiếu checkout-service");
    const { environments } = await projectApi.get(p.id);
    const [dev, , prod] = environments;
    if (dev === undefined || prod === undefined) throw new Error("thiếu env");

    // Hơn một trang flag; trang hai là phần còn lại, cùng tổng
    const page2 = await flagApi.page(p.id, prod.id, tz, { offset: 50 });
    expect(page2.flags.length).toBe(page2.total - 50);
    for (const status of ["DRAFT", "ACTIVE", "ARCHIVED"] as const) {
      expect(await flagApi.count(p.id, prod.id, { status })).toBeGreaterThan(0);
    }
    // Flag nháp đã bật ở dev (UX-4 "Nháp, chưa phục vụ")
    const drafts = await flagApi.page(p.id, dev.id, tz, { status: "DRAFT" });
    expect(
      drafts.flags.filter((f) => f.env?.isEnabled === true).length,
    ).toBeGreaterThanOrEqual(4);
    // Rule AND nhiều điều kiện ở prod
    const all = [
      ...(await flagApi.page(p.id, prod.id, tz)).flags,
      ...page2.flags,
    ];
    let multi = 0;
    for (const f of all) {
      for (const r of (await flagApi.rules(p.id, f.id, prod.id)).rules) {
        const conditions = (r.condition as { all?: unknown[] }).all ?? [];
        if (conditions.length >= 2) multi += 1;
      }
    }
    expect(multi).toBeGreaterThanOrEqual(8);

    // Rollout: mọi cái có tên workload; đủ trạng thái; một cái tự rollback, một cái người bấm rollback
    const rollouts = (
      await Promise.all(environments.map((e) => rolloutApi.list(p.id, e.id)))
    ).flatMap((r) => r.rollouts);
    expect(rollouts.every((r) => (r.workloadName ?? "") !== "")).toBe(true);
    expect(new Set(rollouts.map((r) => r.status))).toEqual(
      new Set(["PENDING", "IN_PROGRESS", "PAUSED", "DONE", "FAILED"]),
    );
    expect(new Set(rollouts.map((r) => r.scope))).toEqual(
      new Set(["FLAG_LEVEL", "SERVICE_LEVEL"]),
    );
    const failed = await Promise.all(
      rollouts
        .filter((r) => r.status === "FAILED")
        .map(async (r) => (await rolloutApi.get(p.id, r.id)).rollout),
    );
    const last = failed.map((r) => r.events.at(-1));
    expect(last.some((e) => e?.triggeredBy === "AUTO")).toBe(true);
    expect(last.some((e) => e?.triggeredBy === "MANUAL")).toBe(true);
    expect(failed.every((r) => (r.failReason ?? "").length > 20)).toBe(true);

    // Nhật ký: hơn 200 dòng, mới nhất trước, trải hàng tháng, người làm là thành viên có thật
    const first = await projectApi.audit(p.id, { limit: "50" });
    expect(first.total).toBeGreaterThanOrEqual(200);
    const entries = [...first.entries];
    for (let o = 50; o < first.total; o += 50) {
      entries.push(
        ...(await projectApi.audit(p.id, { limit: "50", offset: String(o) }))
          .entries,
      );
    }
    expect(entries.map((e) => e.occurredAt)).toEqual(
      entries
        .map((e) => e.occurredAt)
        .sort()
        .reverse(),
    );
    const span =
      Date.parse(entries[0]?.occurredAt ?? "") -
      Date.parse(entries.at(-1)?.occurredAt ?? "");
    expect(span).toBeGreaterThan(60 * 86_400_000);
    expect(new Set(entries.map((e) => e.action)).size).toBeGreaterThanOrEqual(
      20,
    );
    const { members } = await projectApi.members(p.id);
    const memberIds = new Set(members.map((m) => m.userId));
    const humans = entries.filter((e) => e.actorType === "USER");
    expect(humans.every((e) => memberIds.has(e.actorUserId ?? ""))).toBe(true);
    expect(
      new Set(humans.map((e) => e.actorUserId)).size,
    ).toBeGreaterThanOrEqual(4);
    const users = await allPages(async (o) => {
      const r = await adminApi.users({}, o);
      return { total: r.total, rows: r.users };
    });
    const userIds = new Set(users.map((u) => u.id));
    expect(memberIds.size).toBeGreaterThan(0);
    expect([...memberIds].every((id) => userIds.has(id))).toBe(true);
    // Lọc theo nhóm hành động của trang Nhật ký
    const flagOnly = await projectApi.audit(p.id, {
      action: "flag.env.update",
    });
    expect(flagOnly.total).toBeGreaterThan(20);
    expect(flagOnly.entries.every((e) => e.action === "flag.env.update")).toBe(
      true,
    );
  });

  it("các project ở từng bước của thẻ Bắt đầu, và trạng thái trống", async () => {
    const byName = await projectsByName();
    const facts = async (name: string) => {
      const p = byName.get(name);
      if (p === undefined) throw new Error(`thiếu ${name}`);
      const { environments } = await projectApi.get(p.id);
      const first = environments[0];
      if (first === undefined) throw new Error("thiếu env");
      const keys = (
        await Promise.all(
          environments.map((e) => projectApi.sdkKeys(p.id, e.id)),
        )
      ).flatMap((k) => k.keys);
      const { architecture } = await architectureApi.get(p.id);
      const latest = await Promise.all(
        environments.map((e) => deploymentApi.latest(p.id, e.id)),
      );
      return {
        sdkKey: keys.some((k) => k.status === "active"),
        flag: (await flagApi.page(p.id, first.id, tz)).total > 0,
        cloud: architecture.cloud !== null,
        domains: architecture.tools.length > 0,
        deploy: latest.some((l) => l.deployment !== null),
        segments: (await segmentApi.list(p.id)).segments.length,
        rollouts: (
          await Promise.all(
            environments.map((e) => rolloutApi.list(p.id, e.id)),
          )
        ).flatMap((r) => r.rollouts).length,
      };
    };
    expect(await facts("voucher-service")).toEqual({
      sdkKey: true,
      flag: false,
      cloud: false,
      domains: false,
      deploy: false,
      segments: 0,
      rollouts: 0,
    });
    expect(await facts("seller-center")).toMatchObject({
      sdkKey: true,
      flag: true,
      cloud: true,
      domains: false,
      deploy: false,
    });
    expect(await facts("shipping-fee-api")).toEqual({
      sdkKey: false,
      flag: false,
      cloud: true,
      domains: true,
      deploy: true,
      segments: 0,
      rollouts: 0,
    });
    expect(await facts("checkout-service")).toMatchObject({
      sdkKey: true,
      flag: true,
      cloud: true,
      domains: true,
      deploy: true,
    });
  });
});

describe("nhóm và lời mời (Plan #55)", () => {
  it("dữ liệu mẫu: năm nhóm, vai hiệu lực qua nhóm, lời mời đang chờ và hết hạn", async () => {
    const { teams } = await teamApi.list();
    expect(new Set(teams.map((t) => t.name))).toEqual(
      new Set([
        "Nền tảng",
        "Nhóm di động",
        "Nhóm thanh toán",
        "Tư vấn bên ngoài",
      ]),
    );
    expect(new Set(teams.map((t) => t.myRole))).toEqual(
      new Set(["OWNER", "MEMBER"]),
    );
    let expired = 0;
    for (const t of teams) {
      const { team } = await teamApi.get(t.id);
      expect(team.members.length).toBe(t.memberCount);
      expect(team.projects.length).toBe(t.projectCount);
      if (team.myRole === "OWNER") {
        const { invitations } = await invitationApi.ofTeam(t.id);
        expired += invitations.filter(
          (i) => Date.parse(i.expiresAt) <= Date.now(),
        ).length;
      }
    }
    expect(expired).toBeGreaterThan(0);

    const projects = await projectsByName();
    // Vai của nhóm cao hơn vai riêng; project chỉ vào được qua nhóm
    expect(projects.get("search-service")?.myRole).toBe("MAINTAINER");
    expect(projects.get("data-pipeline")?.myRole).toBe("VIEWER");
    const checkout = projects.get("checkout-service");
    if (checkout === undefined) throw new Error("thiếu checkout-service");
    expect((await projectTeamApi.list(checkout.id)).teams.length).toBe(1);
    expect(
      (await invitationApi.ofProject(checkout.id)).invitations.length,
    ).toBe(2);

    const { invitation } = await invitationApi.lookup(DEMO_INVITE_TOKEN);
    expect(invitation.target).toMatchObject({
      kind: "TEAM",
      name: "Nhóm dữ liệu",
    });
    expect(invitation.email).toBe((await authApi.me()).user.email);
  });

  it("tạo nhóm, thêm, mời, cấp quyền, nhận lời mời, rời, xoá", async () => {
    const projects = await projectsByName();
    const checkout = projects.get("checkout-service");
    const users = await adminApi.users({}, 0);
    const someone = users.users.find((u) => u.platformRole === "USER");
    if (checkout === undefined || someone === undefined) {
      throw new Error("dữ liệu mẫu thiếu project hoặc người dùng");
    }

    const { team } = await teamApi.create("Nhóm hợp đồng");
    expect(team.myRole).toBe("OWNER");
    await teamApi.rename(team.id, "Nhóm hợp đồng mới");
    const added = await teamApi.addMember(team.id, {
      email: someone.email,
      teamRole: "MEMBER",
    });
    await teamApi.updateMember(team.id, added.member.userId, "OWNER");
    await teamApi.updateMember(team.id, added.member.userId, "MEMBER");
    await expectStatus(
      teamApi.addMember(team.id, {
        email: "chua.co@doitac.vn",
        teamRole: "MEMBER",
      }),
      404,
    );

    const invited = await invitationApi.inviteToTeam(team.id, {
      email: "chua.co@doitac.vn",
      teamRole: "MEMBER",
    });
    await invitationApi.lookup(invited.token);
    await invitationApi.revokeInTeam(team.id, invited.invitation.id);
    await expectStatus(invitationApi.lookup(invited.token), 404);

    const granted = await projectTeamApi.grant(checkout.id, {
      teamId: team.id,
      projectRole: "VIEWER",
    });
    expect(granted.team.members.length).toBe(2);
    await projectTeamApi.update(checkout.id, team.id, "DEVELOPER");
    await expectStatus(
      projectTeamApi.grant(checkout.id, {
        teamId: team.id,
        projectRole: "VIEWER",
      }),
      409,
    );
    await projectTeamApi.revoke(checkout.id, team.id);

    const forOther = await invitationApi.inviteToProject(checkout.id, {
      email: "ai.do.khac@doitac.vn",
      projectRole: "VIEWER",
    });
    await expectStatus(invitationApi.accept(forOther.token), 403);
    await invitationApi.revokeInProject(checkout.id, forOther.invitation.id);

    const joined = await invitationApi.accept(DEMO_INVITE_TOKEN);
    expect(joined.target.kind).toBe("TEAM");
    await expectStatus(invitationApi.accept(DEMO_INVITE_TOKEN), 404);
    expect((await teamApi.list()).teams.length).toBe(6);

    await teamApi.removeMember(team.id, added.member.userId);
    // Chủ nhóm cuối không tự rời được
    await expectStatus(
      teamApi.removeMember(team.id, (await authApi.me()).user.id),
      409,
    );
    await teamApi.remove(team.id);
    await expectStatus(teamApi.get(team.id), 404);
  });
});

describe("thao tác ghi", () => {
  it("flag: tạo, bật, rule, variant, promote, lưu trữ hàng loạt", async () => {
    const p = (await projectsByName()).get("checkout-service");
    if (p === undefined) throw new Error("thiếu checkout-service");
    const { environments } = await projectApi.get(p.id);
    const [dev, staging] = environments;
    if (dev === undefined || staging === undefined)
      throw new Error("thiếu env");
    const { flag } = await flagApi.create(p.id, {
      key: "contract-check-flag",
      flagType: "STRING",
      description: "kiểm hợp đồng",
      variants: [
        { key: "a", value: "A" },
        { key: "b", value: "B" },
      ],
      defaultVariantKey: "a",
    });
    await flagApi.update(p.id, flag.id, {
      lastKnownUpdatedAt: flag.updatedAt,
      lifecycleStatus: "ACTIVE",
    });
    await flagApi.updateEnv(p.id, flag.id, dev.id, { isEnabled: true });
    const variantB = flag.variants.find((v) => v.key === "b")?.id ?? "";
    const rules = await flagApi.replaceRules(p.id, flag.id, dev.id, {
      lastKnownUpdatedAt: flag.updatedAt,
      rules: [
        {
          ruleType: "ATTRIBUTE_BASED",
          condition: {
            all: [{ attribute: "country", operator: "eq", value: "VN" }],
          },
          serve: { kind: "variant", variantId: variantB },
          priority: 10,
          description: null,
        },
      ],
    });
    expect(rules.rules.length).toBe(1);
    const evaluated = await flagApi.evaluate(p.id, flag.id, dev.id, {
      targetingKey: "u1",
      country: "VN",
    });
    expect(evaluated.evaluation.variant).toBe("b");
    await flagApi.replaceVariants(p.id, flag.id, {
      lastKnownUpdatedAt: flag.updatedAt,
      variants: [...flag.variants, { key: "c", value: "C" }],
    });
    const promoted = await flagApi.promote(p.id, flag.id, {
      fromEnvId: dev.id,
      toEnvId: staging.id,
      sourceUpdatedAt: rules.updatedAt,
      lastKnownUpdatedAt: rules.updatedAt,
    });
    expect(promoted.changes).toBe(1);
    const stale = await flagApi.stale(p.id, "UNUSED");
    const result = await flagApi.bulkArchive(
      p.id,
      stale.items.map((i) => ({
        flagId: i.flag.id,
        lastKnownUpdatedAt: i.flag.updatedAt,
      })),
      p.name,
    );
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  it("segment, rollout, deploy, domain, khoá, thành viên, environment, cloud, dựng hạ tầng, project mới", async () => {
    const byName = await projectsByName();
    const p = byName.get("checkout-service");
    const draft = byName.get("analytics-api");
    if (p === undefined || draft === undefined)
      throw new Error("thiếu project");
    const { environments } = await projectApi.get(p.id);
    const prod = environments.find((e) => e.isProduction);
    const dev = environments[0];
    if (prod === undefined || dev === undefined) throw new Error("thiếu env");

    const { segment } = await segmentApi.create(p.id, {
      name: "contract-seg",
      conditions: { all: [], userIds: ["u-1"] },
    });
    await segmentApi.update(p.id, segment.id, {
      name: segment.name,
      description: "hai người",
      conditions: { all: [], userIds: ["u-1", "u-2"] },
      lastKnownUpdatedAt: segment.updatedAt,
    });
    await segmentApi.remove(p.id, segment.id);

    const active = (await rolloutApi.active(p.id)).rollouts[0];
    if (active === undefined) throw new Error("không có rollout đang chạy");
    for (const action of ["PAUSE", "RESUME", "PROMOTE"] as const) {
      await rolloutApi.act(p.id, active.id, action);
    }
    await rolloutApi.probe(p.id, dev.id, "checkout-api");
    const flags = await flagApi.page(p.id, dev.id, tz);
    const beta = flags.flags.find((f) => f.key === "beta-wallet");
    const betaDetail = await flagApi.get(p.id, beta?.id ?? "");
    const betaRules = await flagApi.rules(p.id, betaDetail.flag.id, dev.id);
    const created = await rolloutApi.create(
      p.id,
      {
        scope: "FLAG_LEVEL",
        envId: dev.id,
        strategy: "CANARY",
        flagEnvConfigId: betaDetail.flag.envs[0]?.configId ?? "",
        targetingRuleId: betaRules.rules[0]?.id ?? "",
        targetVariantId:
          betaDetail.flag.variants.find((v) => v.key === "on")?.id ?? "",
        workloadName: "checkout-api",
        stepPercent: 10,
        stepIntervalSeconds: 300,
        analysisIntervalSeconds: 30,
        warmUpRequests: 100,
        thresholds: {
          errorRate: 0.05,
          latencyP99Ms: 800,
          minErrors: 5,
          maxConsecutiveBreaches: 2,
        },
      },
      crypto.randomUUID(),
    );
    await rolloutApi.act(p.id, created.rollout.id, "ROLLBACK");
    await rolloutApi.create(
      p.id,
      {
        scope: "SERVICE_LEVEL",
        envId: prod.id,
        strategy: "CANARY",
        controlMode: "tool-driven",
        workloadName: "checkout-worker",
        imageTag: "v2.0.0",
        stepPercent: 20,
        stepIntervalSeconds: 300,
        analysisIntervalSeconds: 30,
        warmUpRequests: 100,
        thresholds: {
          errorRate: 0.05,
          latencyP99Ms: 800,
          minErrors: 5,
          maxConsecutiveBreaches: 2,
        },
      },
      crypto.randomUUID(),
    );

    const pending = (await deploymentApi.list(p.id, prod.id)).deployments[0];
    expect(
      (await deploymentApi.approve(p.id, pending?.deploymentId ?? "")).status,
    ).toBe("started");

    const current = await domainApi.list(p.id);
    const targets = current.domains.flatMap((d) =>
      d.isEnabled && d.selectedTool !== null && d.domainType !== "TRACING"
        ? [
            {
              domainType: d.domainType,
              toolId: d.selectedTool,
              config: d.toolConfig ?? {},
            },
          ]
        : [],
    );
    await domainApi.validate(p.id, {
      domains: targets,
      preferences: current.preferences,
    });
    const put = await domainApi.put(p.id, {
      lastKnownDomainSetVersion: current.domainSetVersion,
      domains: targets,
      preferences: current.preferences,
    });
    expect(put.domains.find((d) => d.domainType === "TRACING")?.isEnabled).toBe(
      false,
    );
    expect(put.job).not.toBeNull();
    await domainApi.scanNow(p.id, "GITOPS");
    await domainApi.upgrade(p.id, "MONITORING", { toVersion: "1.1.0" });
    await domainApi.retry(p.id, "SECURITY", {});
    expect((await domainApi.rotateWebhookSecret(p.id)).secret).toMatch(
      /^[0-9a-f]{64}$/,
    );

    const key = await projectApi.createSdkKey(p.id, dev.id, {
      keyType: "CLIENT",
      label: "check",
    });
    await projectApi.revokeSdkKey(p.id, dev.id, key.key.id);
    const added = await projectApi.addMember(
      p.id,
      { email: "yen.do@udp.dev", projectRole: "VIEWER" },
      crypto.randomUUID(),
    );
    await projectApi.updateMember(p.id, added.member.userId, "DEVELOPER");
    await projectApi.removeMember(p.id, added.member.userId);
    const env = await projectApi.createEnvironment(
      p.id,
      { name: "qa", isProduction: false },
      crypto.randomUUID(),
    );
    expect(env.job).not.toBeNull();
    await projectApi.updateEnvironment(p.id, env.environment.id, {
      autoDeploy: false,
    });
    await projectApi.deleteEnvironment(p.id, env.environment.id);
    await projectApi.updateQuota(p.id, {
      ...p.resourceQuota,
      maxNodes: 8,
    } as Required<typeof p.resourceQuota>);

    await cloudApi.setup(draft.id, "GCP");
    await cloudApi.setup(draft.id, "AZURE");
    await cloudApi.validate(draft.id);
    await cloudApi.preflight(draft.id);
    const job = await provisioningApi.provision(
      draft.id,
      {},
      crypto.randomUUID(),
    );
    await provisioningApi.cancel(draft.id, job.job.id);

    const fresh = await projectApi.create({
      name: "contract-new",
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
    });
    expect(fresh.environments.length).toBe(3);
    await projectApi.updateTtl(fresh.project.id, null);
    await projectApi.remove(fresh.project.id);
    await authApi.logout();
    await expectStatus(authApi.me(), 401);
  });
});

describe("vai người xem và tình huống nền tảng của dải Bản xem thử", () => {
  it("cùng hạt giống: hai lần dựng là hai bản sao y hệt", async () => {
    const snapshot = async () => {
      const { projects } = await projectApi.list(0);
      const checkout = projects.find((p) => p.name === "checkout-service");
      return {
        ids: projects.map((p) => p.id),
        audit: (await projectApi.audit(checkout?.id ?? "", { limit: "5" }))
          .entries,
      };
    };
    const first = await as({}, snapshot);
    const second = await as({}, snapshot);
    expect(second).toEqual(first);
  });

  it("developer: người thường, vài project với vai DEVELOPER/MAINTAINER, không vào được khu quản trị", async () => {
    await as({ persona: "developer" }, async () => {
      const { user } = await authApi.me();
      expect(user.platformRole).toBe("USER");
      const { projects } = await projectApi.list(0);
      expect(projects.length).toBeGreaterThanOrEqual(3);
      expect(new Set(projects.map((p) => p.myRole))).toEqual(
        new Set(["DEVELOPER", "MAINTAINER", "VIEWER"]),
      );
      expect(projects.some((p) => p.myRole === "OWNER")).toBe(false);
      const { home } = await homeApi.get();
      expect(home.projects.length).toBe(projects.length);
      expect((await teamApi.list()).teams.length).toBeGreaterThan(0);
      await expectStatus(adminApi.overview(), 403);
      await expectStatus(adminApi.users({}, 0), 403);
    });
  });

  it("người mới: không project, không nhóm; tạo project qua wizard rồi thấy nó", async () => {
    await as({ persona: "newcomer" }, async () => {
      const { user } = await authApi.me();
      expect(user.platformRole).toBe("USER");
      expect((await projectApi.list(0)).total).toBe(0);
      expect((await teamApi.list()).teams).toEqual([]);
      const before = (await homeApi.get()).home;
      expect(before.projects).toEqual([]);
      expect(before.rollouts).toEqual([]);
      expect(before.attention).toEqual([]);
      expect(before.deploys.every((d) => d.success + d.failure === 0)).toBe(
        true,
      );

      const created = await projectApi.create({
        name: "tiem-banh-online",
        creationMode: "CREATE_NEW",
        languageRuntime: "nodejs",
      });
      expect(created.project.myRole).toBe("OWNER");
      expect(created.project.ownerId).toBe(user.id);
      const { projects } = await projectApi.list(0);
      expect(projects.map((p) => p.name)).toEqual(["tiem-banh-online"]);
      expect((await homeApi.get()).home.projects.length).toBe(1);
      const { members } = await projectApi.members(created.project.id);
      expect(members.map((m) => m.user.email)).toEqual([user.email]);
      const { entries } = await projectApi.audit(created.project.id, {});
      expect(entries.map((e) => [e.action, e.actorUserId])).toEqual([
        ["project.create", user.id],
      ]);
      await expectStatus(adminApi.overview(), 403);
    });
  });

  it("nền tảng có rủi ro: máy rảnh, sao lưu hỏng, chứng chỉ sắp hết hạn, một service ngừng", async () => {
    await as({ platform: "at-risk" }, async () => {
      const { platform } = await adminApi.platform();
      if (
        platform.node.state !== "ok" ||
        platform.backup.state !== "ok" ||
        platform.certificate.state !== "ok"
      ) {
        throw new Error("tín hiệu của cụm phải đọc được");
      }
      expect(idleRisk(platform.node).tone).toBe("warn");
      expect(backupVerdict(platform.backup).tone).toBe("error");
      expect(certificateVerdict(platform.certificate).tone).toBe("warn");
      const { services } = await adminApi.system();
      expect(services.some((s) => s.status === "down")).toBe(true);
    });
    // Mặc định: khoẻ
    const { platform } = await as({}, () => adminApi.platform());
    if (platform.node.state !== "ok" || platform.certificate.state !== "ok") {
      throw new Error("tín hiệu của cụm phải đọc được");
    }
    expect(idleRisk(platform.node).tone).toBe("ok");
    expect(certificateVerdict(platform.certificate).tone).toBe("ok");
  });
});
