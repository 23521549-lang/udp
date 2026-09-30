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
import { DEMO_INVITE_TOKEN } from "./mock/demo-invite";
import { API_PREFIX, createMockBackend } from "./mock/server";

/**
 * Hợp đồng của bản xem thử: gọi MỌI hàm API của Portal qua lớp giả lập — đúng hàm, đúng schema dây mà các màn
 * hình dùng. Một response giả lệch hình là `ApiError` kind `contract` ở đây, không phải một màn hình trắng lúc xem.
 *
 *   npx vitest run --config demo/vitest.config.ts        (trong apps/portal)
 */

beforeAll(() => {
  const backend = createMockBackend();
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

describe("đăng nhập và quản trị", () => {
  it("phiên, và mọi trang quản trị", async () => {
    expect((await authApi.me()).user.platformRole).toBe("PLATFORM_ADMIN");
    expect(
      (await authApi.login({ email: "a@b.dev", password: "x" })).user,
    ).toBeDefined();
    // Đủ người cho nhiều trang: trang 1 đầy, trang 3 là phần còn lại
    const { users, total } = await adminApi.users(undefined, 0);
    expect(total).toBe(130);
    expect(users.length).toBe(ADMIN_PAGE_SIZE);
    const last = await adminApi.users(undefined, 2 * ADMIN_PAGE_SIZE);
    expect(last.users.length).toBe(total - 2 * ADMIN_PAGE_SIZE);
    expect((await adminApi.users("khánh", 0)).users.length).toBe(1);
    const target = users.find((u) => u.platformRole === "USER");
    expect(
      (await adminApi.setRole(target?.id ?? "", "PLATFORM_ADMIN")).user
        .platformRole,
    ).toBe("PLATFORM_ADMIN");
    expect((await adminApi.projects(undefined, 0)).total).toBe(24);
    for (const status of [
      "DRAFT",
      "PROVISIONING",
      "ACTIVE",
      "ERROR",
      "DELETED",
    ]) {
      expect(
        (await adminApi.projects(status, 0)).projects.length,
      ).toBeGreaterThan(0);
    }
    expect((await adminApi.credentials()).credentials.length).toBeGreaterThan(
      0,
    );
    for (const state of ["FAILED", "COMPENSATION_FAILED", "CANCEL_REQUESTED"]) {
      expect((await adminApi.jobs(state, 0)).total).toBeGreaterThan(0);
    }
    const orphans = await adminApi.orphans();
    expect(orphans.resources.length).toBe(6);
    expect(orphans.unpriced.length).toBeGreaterThan(0);

    // Tổng quan của Bảng điều khiển: số liệu khớp các danh sách, cụm có đủ tín hiệu
    const { overview } = await adminApi.overview();
    expect(overview.users.total).toBe(total);
    expect(overview.users.newLast7d).toBeGreaterThan(0);
    expect(overview.clouds.map((c) => c.provider).sort()).toEqual([
      "AWS",
      "AZURE",
      "GCP",
    ]);
    expect(overview.orphans.count).toBe(orphans.resources.length);
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
    expect(home.projects.length).toBe(10);
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
    expect((await flagApi.page(p.id, prod.id, tz)).total).toBe(16);
    expect((await segmentApi.list(p.id)).segments.length).toBe(6);
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
    const users = await adminApi.users(undefined, 0);
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
