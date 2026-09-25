import { generateKeyPairSync } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { awsPlan } from "@udp/cloud-adapters/aws";
import { scanForSecret } from "@udp/test-support";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { externalIdOf } from "../src/modules/cloud/cloud.platform.js";
import { CLOUD_ERROR_SLUGS } from "@udp/shared-types/cloud-api";
import { createOidcIssuer } from "../src/modules/oidc/oidc.issuer.js";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import {
  inertCloudPlatform,
  SIM_LABELS,
  simCloudPlatform,
  type SimCloudPlatform,
} from "./helpers/cloud-platform.js";
import { tapServiceLog, type LogTap } from "./helpers/log-tap.js";
import type { CloudPlatform } from "../src/modules/cloud/cloud.platform.js";

/**
 * Bước cloud của project qua HTTP thật trên database thật (Plan #26 P6: AC-6, AC-7, AC-9).
 * Cloud là cổng mô phỏng — kế hoạch THẬT của AWS/GCP/Azure qua lõi điều phối thật — nên
 * `validate`/`preflight` đi đúng đường adapter sẽ đi, chỉ không chạm tài khoản thật.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_cloud_test_admin",
});

/** Chuỗi canh cho bí mật của khách — không thể xuất hiện tình cờ (cùng khuôn sentinel I12) */
const SENTINEL = "canhCloudP6Sentinel5e2d8a1f0c9b7e3d";
const EXTERNAL_ID_SECRET = "bi-mat-external-id-cua-udp-toi-thieu-32";
const PRINCIPAL = "arn:aws:iam::111122223333:role/udp-controlplane";
const ISSUER = "https://udp.example/oidc";

const roleArn = (name: string) => `arn:aws:iam::123456789012:role/udp-${name}`;

const appOn = (cloud: CloudPlatform) =>
  createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud,
  });

let platform: SimCloudPlatform;
let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
let maintainer: Actor;
let developer: Actor;
let projectId: string;
let emptyProjectId: string;
let unconfiguredProjectId: string;
let logTap: LogTap;

const cloudUrl = (pid = projectId) => `${API}/projects/${pid}/cloud`;
const putCloud = (actor: Actor, body: object, a = app, pid = projectId) =>
  as(actor, request(a).put(cloudUrl(pid)).send(body));
const post = (
  actor: Actor,
  path: "validate" | "preflight",
  a = app,
  pid = projectId,
) => as(actor, request(a).post(`${cloudUrl(pid)}/${path}`));

beforeAll(async () => {
  const oidcIssuer = createOidcIssuer({
    issuer: ISSUER,
    privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  });
  platform = simCloudPlatform(
    {
      UDP_AWS_PRINCIPAL_ARN: PRINCIPAL,
      UDP_EXTERNAL_ID_SECRET: EXTERNAL_ID_SECRET,
      MANAGED_CLOUDS: ["gcp"],
      MANAGED_GCP_PROJECT_ID: "udp-managed",
    },
    oidcIssuer,
  );
  app = appOn(platform);
  logTap = tapServiceLog();
  world = testWorld(app, admin);
  owner = await world.newActor("cloud-owner");
  maintainer = await world.newActor("cloud-maint");
  developer = await world.newActor("cloud-dev");
  ({ projectId } = await world.newProject(owner));
  ({ projectId: emptyProjectId } = await world.newProject(owner));
  ({ projectId: unconfiguredProjectId } = await world.newProject(owner));
  await world.addMember(owner, projectId, maintainer, "MAINTAINER");
  await world.addMember(owner, projectId, developer, "DEVELOPER");
});

afterAll(async () => {
  logTap.stop();
  await world.cleanup();
  await admin.$disconnect();
});

describe("GET /cloud và /cloud/setup", () => {
  it("chưa cấu hình ⇒ cloud: null; MAINTAINER đọc được, DEVELOPER thì không", async () => {
    const res = await as(maintainer, request(app).get(cloudUrl())).expect(200);
    expect(res.body).toEqual({ cloud: null });
    await as(developer, request(app).get(cloudUrl())).expect(403);
  });

  it("AWS: trust policy điền sẵn principal và ExternalId CỦA project này", async () => {
    const res = await as(
      maintainer,
      request(app).get(`${cloudUrl()}/setup`).query({ provider: "AWS" }),
    ).expect(200);
    const role = res.body.setup.methods.find(
      (m: { authKind: string }) => m.authKind === "AWS_ROLE",
    );
    expect(role).toMatchObject({
      available: true,
      federated: true,
      unavailableReason: null,
    });
    const trust = JSON.parse(role.snippets[0].content);
    expect(trust.Statement[0].Principal.AWS).toBe(PRINCIPAL);
    expect(trust.Statement[0].Condition.StringEquals["sts:ExternalId"]).toBe(
      externalIdOf(EXTERNAL_ID_SECRET, projectId),
    );
    expect(res.body.setup.requiredPermissions).toEqual([
      ...awsPlan.requiredPermissions,
    ]);
  });

  it("GCP: lệnh WIF mang issuer và subject; MANAGED bật; Azure MANAGED tắt", async () => {
    const gcp = await as(
      maintainer,
      request(app).get(`${cloudUrl()}/setup`).query({ provider: "GCP" }),
    ).expect(200);
    const wif = gcp.body.setup.methods.find(
      (m: { authKind: string }) => m.authKind === "GCP_WIF",
    );
    expect(wif.snippets[0].content).toContain(`--issuer-uri=${ISSUER}`);
    expect(wif.snippets[0].content).toContain(`project:${projectId}`);
    expect(gcp.body.setup.managed).toEqual({
      available: true,
      unavailableReason: null,
    });
    const azure = await as(
      maintainer,
      request(app).get(`${cloudUrl()}/setup`).query({ provider: "AZURE" }),
    ).expect(200);
    expect(azure.body.setup.managed.unavailableReason).toBe("managed-disabled");
  });

  it("triển khai chưa bật federation ⇒ phương thức federation báo lý do, khoá tĩnh vẫn dùng được", async () => {
    const res = await as(
      owner,
      request(appOn(simCloudPlatform()))
        .get(`${cloudUrl()}/setup`)
        .query({ provider: "GCP" }),
    ).expect(200);
    expect(
      res.body.setup.methods.map(
        (m: { authKind: string; unavailableReason: string | null }) => [
          m.authKind,
          m.unavailableReason,
        ],
      ),
    ).toEqual([
      ["GCP_WIF", "oidc-issuer-disabled"],
      ["GCP_KEY", null],
    ]);
  });

  it("provider lạ ⇒ 400", async () => {
    await as(
      owner,
      request(app).get(`${cloudUrl()}/setup`).query({ provider: "ORACLE" }),
    ).expect(400);
  });
});

describe("PUT /cloud", () => {
  it("khoá tĩnh: lưu mã hoá, trả metadata, không nơi nào (DB, log) chứa bí mật (AC-6)", async () => {
    const res = await putCloud(owner, {
      mode: "BYOC",
      provider: "AWS",
      region: "ap-southeast-1",
      credential: {
        authKind: "AWS_KEY",
        accessKeyId: "AKIAEXAMPLEEXAMPLE12",
        secretAccessKey: SENTINEL,
      },
    }).expect(200);
    expect(res.body.cloud).toMatchObject({
      provider: "AWS",
      mode: "BYOC",
      authKind: "AWS_KEY",
      federated: false,
      region: "ap-southeast-1",
      lastValidatedAt: null,
      createdBy: { id: owner.userId, email: owner.email },
    });
    expect(res.body.cloud.fingerprint).toHaveLength(12);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);

    expect(await scanForSecret(admin, SENTINEL)).toEqual([]);
    await logTap.settle();
    expect(logTap.text()).not.toContain(SENTINEL);

    const audit = await admin.auditLog.findFirst({
      where: { projectId, action: "cloud.credential.set" },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit?.after).toMatchObject({
      authKind: "AWS_KEY",
      region: "ap-southeast-1",
    });
  });

  it("thay bằng AWS_ROLE: đúng MỘT bản active, bản cũ còn nhưng hết active", async () => {
    await putCloud(owner, {
      mode: "BYOC",
      provider: "AWS",
      region: "ap-southeast-1",
      credential: { authKind: "AWS_ROLE", roleArn: roleArn("du-quyen") },
    }).expect(200);
    const rows = await admin.cloudCredential.findMany({
      where: { projectId },
      select: { authKind: true, isActive: true },
    });
    expect(rows.filter((r) => r.isActive)).toEqual([
      { authKind: "AWS_ROLE", isActive: true },
    ]);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const res = await as(maintainer, request(app).get(cloudUrl())).expect(200);
    expect(res.body.cloud).toMatchObject({
      authKind: "AWS_ROLE",
      federated: true,
    });
  });

  it("authKind lệch provider, trường lạ, hay region sai ⇒ 400", async () => {
    await putCloud(owner, {
      mode: "BYOC",
      provider: "GCP",
      region: "asia-southeast1",
      credential: { authKind: "AWS_ROLE", roleArn: roleArn("x") },
    }).expect(400);
    await putCloud(owner, {
      mode: "BYOC",
      provider: "AWS",
      region: "ap-southeast-1",
      credential: { authKind: "AWS_ROLE", roleArn: roleArn("x"), them: 1 },
    }).expect(400);
    await putCloud(owner, {
      mode: "MANAGED",
      provider: "GCP",
      region: "Asia Southeast",
    }).expect(400);
  });

  it("MANAGED: không có gì để khách nhập; đích là của UDP, kiểm được như BYOC", async () => {
    const res = await putCloud(
      owner,
      { mode: "MANAGED", provider: "GCP", region: "asia-southeast1" },
      app,
      emptyProjectId,
    ).expect(200);
    expect(res.body.cloud).toMatchObject({
      provider: "GCP",
      mode: "MANAGED",
      authKind: "GCP_WIF",
      federated: true,
    });
    const validation = await post(
      owner,
      "validate",
      app,
      emptyProjectId,
    ).expect(200);
    expect(validation.body.validation.valid).toBe(true);
    expect(platform.requests.at(-1)).toMatchObject({
      mode: "MANAGED",
      provider: "gcp",
    });
  });

  it("MAINTAINER không ghi được credential (chỉ OWNER, §2.2)", async () => {
    await putCloud(maintainer, {
      mode: "MANAGED",
      provider: "GCP",
      region: "asia-southeast1",
    }).expect(403);
  });

  it("cơ chế chưa bật trên triển khai này ⇒ 422 cloud-method-unavailable", async () => {
    const res = await putCloud(owner, {
      mode: "MANAGED",
      provider: "AZURE",
      region: "southeastasia",
    }).expect(422);
    expect(res.body.type).toContain(CLOUD_ERROR_SLUGS.methodUnavailable);
    const noFederation = await putCloud(
      owner,
      {
        mode: "BYOC",
        provider: "AWS",
        region: "ap-southeast-1",
        credential: { authKind: "AWS_ROLE", roleArn: roleArn("x") },
      },
      appOn(simCloudPlatform()),
    ).expect(422);
    expect(noFederation.body.type).toContain(
      CLOUD_ERROR_SLUGS.methodUnavailable,
    );
  });

  it("cloud không bật adapter ⇒ 503 PROVIDER_UNAVAILABLE (AC-7)", async () => {
    const res = await putCloud(
      owner,
      { mode: "MANAGED", provider: "GCP", region: "asia-southeast1" },
      appOn(inertCloudPlatform),
    ).expect(503);
    expect(res.body.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("POST /cloud/validate và /cloud/preflight", () => {
  it("chưa cấu hình ⇒ 409 cloud-not-configured", async () => {
    const res = await post(
      owner,
      "validate",
      app,
      unconfiguredProjectId,
    ).expect(409);
    expect(res.body.type).toContain(CLOUD_ERROR_SLUGS.notConfigured);
    await post(owner, "preflight", app, unconfiguredProjectId).expect(409);
  });

  it("credential tốt ⇒ valid, ghi lastValidatedAt; payload giải mã bị xoá sạch (AC-9)", async () => {
    await putCloud(owner, {
      mode: "BYOC",
      provider: "AWS",
      region: "ap-southeast-1",
      credential: { authKind: "AWS_ROLE", roleArn: roleArn("du-quyen") },
    }).expect(200);
    const before = platform.exchanged.length;
    const res = await post(owner, "validate").expect(200);
    expect(res.body.validation).toMatchObject({ valid: true, reason: null });
    const exchanged = platform.exchanged.slice(before);
    expect(exchanged).toHaveLength(1);
    expect(exchanged.every((b) => b.disposed && b.everyByteIsZero())).toBe(
      true,
    );
    expect(platform.requests.at(-1)).toMatchObject({
      projectId,
      provider: "aws",
      region: "ap-southeast-1",
      mode: "BYOC",
      authKind: "AWS_ROLE",
    });
    const cloud = await as(owner, request(app).get(cloudUrl())).expect(200);
    expect(cloud.body.cloud.lastValidatedAt).toBe(
      res.body.validation.checkedAt,
    );
  });

  it("preflight: thiếu quyền ⇒ ok false và ĐÚNG các quyền thiếu", async () => {
    await putCloud(owner, {
      mode: "BYOC",
      provider: "AWS",
      region: "ap-southeast-1",
      credential: {
        authKind: "AWS_ROLE",
        roleArn: roleArn(SIM_LABELS.missingPermissions),
      },
    }).expect(200);
    const res = await post(owner, "preflight").expect(200);
    expect(res.body.preflight).toMatchObject({
      ok: false,
      missingPermissions: awsPlan.requiredPermissions.slice(0, 2),
    });
  });

  it("cloud từ chối đổi token ⇒ validate trả valid: false kèm lý do; preflight 422", async () => {
    await putCloud(owner, {
      mode: "BYOC",
      provider: "AWS",
      region: "ap-southeast-1",
      credential: {
        authKind: "AWS_ROLE",
        roleArn: roleArn(SIM_LABELS.revoked),
      },
    }).expect(200);
    const res = await post(owner, "validate").expect(200);
    expect(res.body.validation.valid).toBe(false);
    expect(res.body.validation.reason).toContain("AccessDenied");
    const pre = await post(owner, "preflight").expect(422);
    expect(pre.body.type).toContain(CLOUD_ERROR_SLUGS.credentialInvalid);
  });

  it("MAINTAINER không kiểm được (dùng credential của khách để gọi cloud của họ)", async () => {
    await post(maintainer, "validate").expect(403);
    await post(maintainer, "preflight").expect(403);
  });

  it("cloud không bật adapter ⇒ 503 PROVIDER_UNAVAILABLE (AC-7)", async () => {
    const off = appOn(inertCloudPlatform);
    expect((await post(owner, "validate", off).expect(503)).body.code).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    await post(owner, "preflight", off).expect(503);
  });
});
