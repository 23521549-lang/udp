import { resolve } from "node:path";
import { env } from "@udp/config";
import { createPrismaClient, type Prisma } from "@udp/db";
import type { RepoSource } from "@udp/golden-path";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { buildViewWire } from "@udp/shared-types/wire";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import { signedImagesOf } from "../src/modules/packaging/signed-images.js";
import { imageValidatingPolicy } from "../src/modules/policy-adapter/kyverno/image-policy.js";
import type { RepoSourceFactory } from "../src/modules/golden-path/repo-source.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import {
  inertCloudPlatform,
  inertProvisioning,
  noEgress,
  noExternalAuth,
  outsidePlatform,
} from "./helpers/inert-deps.js";
import { testSigner } from "./helpers/dsse.js";

/**
 * [Plan #61 QĐ-9] Mục Đóng gói qua HTTP thật và database thật: dự đoán, việc cần làm, danh tính build, phân quyền, nhật
 * ký — và pipeline thật đọc đúng cài đặt vừa lưu.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_packaging_admin",
});

const RUST_REPO = "https://github.com/acme/rust-api";
const memoryRepos: RepoSourceFactory = () => {
  const files: Record<string, string> = {
    "Cargo.toml": "[package]\nname = 'api'",
    "src/main.rs": "fn main() {}",
  };
  const source: RepoSource = {
    truncated: false,
    list: () => Promise.resolve(Object.keys(files)),
    read: (path) => Promise.resolve(files[path]),
  };
  return { host: "github", source };
};

const registry = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});
const app = createApp({
  metricsFor: () => new FakeMetricsProvider(),
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  repoSource: memoryRepos,
  egressFetch: noEgress,
  platform: outsidePlatform,
  auth: noExternalAuth,
  domainRegistry: () => registry,
  provisioning: inertProvisioning,
});

let world: TestWorld;
let owner: Actor;
let developer: Actor;
let viewer: Actor;

const buildUrl = (projectId: string) => `${API}/projects/${projectId}/build`;

async function newProject(
  runtime: string,
  mode: "CREATE_NEW" | "IMPORT_EXISTING" = "CREATE_NEW",
): Promise<string> {
  const { projectId } = await world.newProject(owner);
  await world.addMember(owner, projectId, developer, "DEVELOPER");
  await world.addMember(owner, projectId, viewer, "VIEWER");
  await admin.project.update({
    where: { id: projectId },
    data: {
      languageRuntime: runtime,
      creationMode: mode,
      repoUrl: mode === "IMPORT_EXISTING" ? RUST_REPO : null,
    },
  });
  return projectId;
}

/** Bật CI và registry như domain-apply ghi: hai DomainConfig và binding `registry.oci` */
async function enable(
  projectId: string,
  ci: { tool: string; config: Prisma.InputJsonObject },
  reg: {
    tool: string;
    endpoint: string;
    attributes: Record<string, string> | null;
  },
): Promise<void> {
  await admin.domainConfig.create({
    data: {
      projectId,
      domainType: "CICD",
      isEnabled: true,
      selectedTool: ci.tool,
      toolConfig: ci.config,
    },
  });
  const registryConfig = await admin.domainConfig.create({
    data: {
      projectId,
      domainType: "CONTAINER_REGISTRY",
      isEnabled: true,
      selectedTool: reg.tool,
      toolConfig: {},
    },
  });
  await admin.capabilityBinding.create({
    data: {
      domainConfigId: registryConfig.id,
      capabilityId: "registry.oci",
      providedBy: `container_registry:${reg.tool}`,
      schemaVersion: "1.0.0",
      endpoint: reg.endpoint,
      ...(reg.attributes === null ? {} : { attributes: reg.attributes }),
    },
  });
}

const ECR = {
  tool: "ecr",
  endpoint: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/acme",
  attributes: {
    pullAuth: "node-identity",
    pushAuth: "aws-ecr",
    region: "ap-southeast-1",
  },
};
const ROLE = "arn:aws:iam::123456789012:role/udp/udp-build-x";

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("pk-owner");
  developer = await world.newActor("pk-developer");
  viewer = await world.newActor("pk-viewer");
}, 120_000);

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

describe("GET /projects/:id/build", () => {
  it("Create New Python, chưa bật gì: mặc định, dự đoán Dockerfile của Golden Path, việc: bật CI và registry", async () => {
    const projectId = await newProject("python");
    const res = await as(viewer, request(app).get(buildUrl(projectId))).expect(
      200,
    );
    const view = buildViewWire.parse(res.body);
    expect(view.settings).toMatchObject({
      strategy: "auto",
      context: ".",
      dockerfile: "Dockerfile",
      identity: null,
    });
    expect(view.platform).toBe("linux/amd64");
    expect(view.prediction).toEqual({
      strategy: "dockerfile",
      reason: "GOLDEN_PATH",
    });
    expect(view.language).toEqual({ value: "python", source: "runtime" });
    expect(view.test).toMatchObject({ kind: "run" });
    expect(view.todo.map((t) => t.code)).toEqual([
      "ENABLE_CI",
      "ENABLE_REGISTRY",
    ]);
    // Chưa bật CI ⇒ chưa có chỗ đặt lịch rebase
    expect(view.rebase).toBeNull();
  });

  it("GitHub Actions + ECR: cần danh tính, có script AWS tin đúng repo; lưu danh tính thì hết việc và pipeline mang ARN", async () => {
    const projectId = await newProject("nodejs");
    await enable(
      projectId,
      { tool: "github-actions", config: { repository: "acme/web" } },
      ECR,
    );
    const before = buildViewWire.parse(
      (await as(viewer, request(app).get(buildUrl(projectId))).expect(200))
        .body,
    );
    expect(before.identity).toEqual({
      required: true,
      configured: false,
      cloud: "aws",
    });
    expect(before.identityScript?.cloud).toBe("aws");
    // [Plan #61 61d-2b-0] Cả hai hình chủ thể: hình tên (repo có trước 15/07/2026) và hình bất biến ghim id
    expect(before.identityScript?.text).toContain(
      "repo:acme/web:ref:refs/heads/main",
    );
    expect(before.identityScript?.text).toContain(
      "repo:acme@$OWNER_ID/web@$REPO_ID:ref:refs/heads/main",
    );
    expect(before.todo).toContainEqual({
      code: "BUILD_IDENTITY",
      cloud: "aws",
    });

    const settings = {
      ...before.settings,
      identity: { cloud: "aws", roleArn: ROLE },
    };
    // Danh tính quyết định CI nào được đẩy image: chỉ MAINTAINER trở lên
    await as(
      developer,
      request(app).put(buildUrl(projectId)).send(settings),
    ).expect(403);
    const saved = buildViewWire.parse(
      (
        await as(
          owner,
          request(app).put(buildUrl(projectId)).send(settings),
        ).expect(200)
      ).body,
    );
    expect(saved.identity.configured).toBe(true);
    expect(saved.todo.map((t) => t.code)).not.toContain("BUILD_IDENTITY");

    const audit = await admin.auditLog.findFirst({
      where: { projectId, action: "project.build.update" },
    });
    expect(audit?.after).toMatchObject({ identity: { roleArn: ROLE } });

    const pipeline = await as(
      developer,
      request(app).get(
        `${API}/projects/${projectId}/domains/CICD/pipeline-template`,
      ),
    ).expect(200);
    expect(pipeline.body.content).toContain(ROLE);
    expect(pipeline.body.content).toContain("id-token: write");
  });

  it("GitLab CI + GHCR ⇒ đẩy bằng secret: việc CI_SECRETS nêu đúng tên", async () => {
    const projectId = await newProject("nodejs");
    await enable(
      projectId,
      { tool: "gitlab-ci", config: { projectPath: "acme/web" } },
      {
        tool: "ghcr",
        endpoint: "ghcr.io/acme",
        attributes: { pushAuth: "github-token" },
      },
    );
    const view = buildViewWire.parse(
      (await as(viewer, request(app).get(buildUrl(projectId))).expect(200))
        .body,
    );
    expect(view.registry).toEqual({
      server: "ghcr.io",
      push: "github-token",
      effectivePush: "basic",
    });
    expect(view.todo).toContainEqual({
      code: "CI_SECRETS",
      ci: "gitlab-ci",
      names: ["UDP_REGISTRY_USERNAME", "UDP_REGISTRY_PASSWORD"],
    });
    expect(view.identityScript).toBeNull();
    // [Plan #61 QĐ-13] GitLab: lịch tạo trong cài đặt của CI; giờ chạy và cron khớp nhau, trong 01:00–06:59 UTC
    expect(view.rebase?.schedule).toBe("ci-settings");
    const { hour, minute, cron } = view.rebase!;
    expect(cron).toBe(`${String(minute)} ${String(hour)} * * *`);
    expect(hour).toBeGreaterThanOrEqual(1);
    expect(hour).toBeLessThanOrEqual(6);

    // Ghim Dockerfile ⇒ chỉ image Buildpacks rebase được ⇒ không có lịch
    const pinned = buildViewWire.parse(
      (
        await as(
          owner,
          request(app)
            .put(buildUrl(projectId))
            .send({ strategy: "dockerfile" }),
        ).expect(200)
      ).body,
    );
    expect(pinned.rebase).toBeNull();
  });

  it("Jenkins (trong cluster) + ECR chưa có cluster ⇒ NO_CLUSTER, không script; binding cũ thiếu pushAuth ⇒ REAPPLY", async () => {
    const jenkins = await newProject("nodejs");
    await enable(jenkins, { tool: "jenkins", config: {} }, ECR);
    const view = buildViewWire.parse(
      (await as(viewer, request(app).get(buildUrl(jenkins))).expect(200)).body,
    );
    expect(view.todo.map((t) => t.code)).toContain("NO_CLUSTER");
    expect(view.identityScript).toBeNull();

    const old = await newProject("nodejs");
    await enable(
      old,
      { tool: "github-actions", config: { repository: "acme/web" } },
      { ...ECR, attributes: { pullAuth: "node-identity" } },
    );
    const stale = buildViewWire.parse(
      (await as(viewer, request(app).get(buildUrl(old))).expect(200)).body,
    );
    expect(stale.registry).toBeNull();
    expect(stale.todo.map((t) => t.code)).toContain("REAPPLY_REGISTRY");
  });

  it("Import Existing Rust sau khi quét: Buildpacks không build được ⇒ NEEDS_DOCKERFILE và TEST_COMMAND", async () => {
    const projectId = await newProject("other", "IMPORT_EXISTING");
    const notScanned = buildViewWire.parse(
      (await as(viewer, request(app).get(buildUrl(projectId))).expect(200))
        .body,
    );
    expect(notScanned.prediction.reason).toBe("NOT_SCANNED");
    await as(
      developer,
      request(app).post(`${API}/projects/${projectId}/repo-scan`).send({}),
    ).expect(200);
    const view = buildViewWire.parse(
      (await as(viewer, request(app).get(buildUrl(projectId))).expect(200))
        .body,
    );
    expect(view.language).toEqual({ value: "rust", source: "scan" });
    expect(view.prediction).toEqual({
      strategy: "unknown",
      reason: "SCAN_NEEDS_DOCKERFILE",
    });
    expect(view.todo).toContainEqual({
      code: "NEEDS_DOCKERFILE",
      language: "rust",
    });
    expect(view.todo).toContainEqual({
      code: "TEST_COMMAND",
      language: "rust",
    });
  });
});

describe("PUT /projects/:id/build", () => {
  it("từ chối đường dẫn .., khoá giả dạng danh tính, trường lạ, lệnh test có nháy", async () => {
    const projectId = await newProject("nodejs");
    for (const bad of [
      { context: "../etc" },
      { dockerfile: "/Dockerfile" },
      { identity: { cloud: "aws", roleArn: "AKIAABCDEFGHIJKLMNOP" } },
      { identity: { cloud: "aws", roleArn: ROLE, secret: "x" } },
      { test: { mode: "custom", command: "echo 'x'", image: "node:22" } },
      { unknown: true },
    ]) {
      await as(owner, request(app).put(buildUrl(projectId)).send(bad)).expect(
        400,
      );
    }
  });

  it("ghim Buildpacks, tắt test tường minh: dự đoán và bước test theo đúng cài đặt", async () => {
    const projectId = await newProject("nodejs");
    const res = await as(
      owner,
      request(app)
        .put(buildUrl(projectId))
        .send({ strategy: "buildpacks", test: { mode: "none" } }),
    ).expect(200);
    const view = buildViewWire.parse(res.body);
    expect(view.prediction).toEqual({
      strategy: "buildpacks",
      reason: "PINNED_BUILDPACKS",
    });
    expect(view.test).toEqual({ kind: "skip" });
  });
});

describe("ký image (Plan #61 QĐ-14)", () => {
  it("project AWS + GitHub Actions + GHCR: script tạo khoá KMS ở region của project (không quyền đẩy ECR); dán khoá ⇒ pipeline ký", async () => {
    const projectId = await newProject("nodejs");
    await enable(
      projectId,
      { tool: "github-actions", config: { repository: "acme/web" } },
      {
        tool: "ghcr",
        endpoint: "ghcr.io/acme",
        attributes: { pushAuth: "github-token" },
      },
    );
    await admin.cloudCredential.create({
      data: {
        projectId,
        provider: "AWS",
        mode: "BYOC",
        region: "eu-west-1",
        authKind: "AWS_ROLE",
        encryptedPayload: "khong-giai-duoc",
        encryptedDek: "khong-giai-duoc",
        nonce: "0".repeat(24),
        authTag: "0".repeat(24),
        fingerprint: "e".repeat(64),
        isActive: true,
        createdById: owner.userId,
      },
    });
    const view = buildViewWire.parse(
      (await as(viewer, request(app).get(buildUrl(projectId))).expect(200))
        .body,
    );
    expect(view.signing).toEqual({ available: true, reason: null });
    expect(view.identity).toMatchObject({ required: true, cloud: "aws" });
    expect(view.todo).toContainEqual({ code: "BUILD_IDENTITY", cloud: "aws" });
    expect(view.identityScript?.text).toContain("REGION=eu-west-1");
    expect(view.identityScript?.text).toContain("--key-spec ECC_NIST_P256");
    expect(view.identityScript?.text).not.toContain("udp-build-push");

    // Danh tính dán từ script cũ (không khoá) ⇒ việc tạo khoá ký
    const identity = { cloud: "aws", roleArn: ROLE };
    const noKey = buildViewWire.parse(
      (
        await as(
          owner,
          request(app).put(buildUrl(projectId)).send({ identity }),
        ).expect(200)
      ).body,
    );
    expect(noKey.todo).toContainEqual({ code: "SIGNING_KEY", cloud: "aws" });

    const kms =
      "awskms:///arn:aws:kms:eu-west-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    const { publicKey } = testSigner();
    // Khoá ở cloud khác danh tính, khoá không phải P-256 ⇒ 400
    await as(
      owner,
      request(app)
        .put(buildUrl(projectId))
        .send({
          identity,
          signing: {
            keys: [
              {
                publicKey,
                kms: "gcpkms://projects/acme-prod/locations/global/keyRings/udp/cryptoKeys/k/versions/1",
              },
            ],
          },
        }),
    ).expect(400);
    const saved = buildViewWire.parse(
      (
        await as(
          owner,
          request(app)
            .put(buildUrl(projectId))
            .send({ identity, signing: { keys: [{ publicKey, kms }] } }),
        ).expect(200)
      ).body,
    );
    expect(saved.todo.map((t) => t.code)).not.toContain("SIGNING_KEY");
    expect(saved.settings.signing.keys[0]).toMatchObject({
      kms,
      id: expect.stringMatching(/^[0-9a-f]{16}$/) as unknown,
    });
    const pipeline = await as(
      developer,
      request(app).get(
        `${API}/projects/${projectId}/domains/CICD/pipeline-template`,
      ),
    ).expect(200);
    expect(pipeline.body.content).toContain(`--key "${kms}"`);
    expect(pipeline.body.content).toContain("id-token: write");
  });
});

/**
 * [Plan #61 61d-3b] `signedImagesOf` — MỘT nguồn cho hai đường dựng bối cảnh adapter.
 *
 * Ô này đi qua database thật và HTTP thật vì điều cần chứng minh không phải "hàm trả về object đúng hình" mà
 * "`repository` nó tính ra **đúng bằng** chuỗi mà pipeline của project đẩy image tới". Hai giá trị đó sinh ở hai chỗ
 * khác nhau (`signed-images.ts` và `pipeline-template.ts`); nếu chúng lệch nhau thì policy admission đòi chữ ký ở
 * một repository mà không image nào của project nằm trong, và cả lớp AC-12 lặng lẽ không kiểm gì.
 */
describe("signedImagesOf (Plan #61 61d-3b)", () => {
  it("chưa registry, hay chưa khoá ⇒ null; đủ hai ⇒ repository KHỚP pipeline, khoá công khai, loại registry", async () => {
    const projectId = await newProject("nodejs");

    // Chưa có cả registry lẫn khoá
    expect(await signedImagesOf(admin, projectId)).toBeNull();

    await enable(
      projectId,
      { tool: "github-actions", config: { repository: "acme/web" } },
      {
        tool: "ghcr",
        endpoint: "ghcr.io/acme",
        attributes: { pushAuth: "github-token" },
      },
    );
    /** Có registry nhưng CHƯA có khoá ký ⇒ vẫn `null`: một policy không attestor không kiểm được gì */
    expect(await signedImagesOf(admin, projectId)).toBeNull();

    await admin.cloudCredential.create({
      data: {
        projectId,
        provider: "AWS",
        mode: "BYOC",
        region: "ap-southeast-1",
        authKind: "AWS_ROLE",
        encryptedPayload: "khong-giai-duoc",
        encryptedDek: "khong-giai-duoc",
        nonce: "0".repeat(24),
        authTag: "0".repeat(24),
        fingerprint: "f".repeat(64),
        isActive: true,
        createdById: owner.userId,
      },
    });
    const { publicKey } = testSigner();
    const kms =
      "awskms:///arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    await as(
      owner,
      request(app)
        .put(buildUrl(projectId))
        .send({
          identity: { cloud: "aws", roleArn: ROLE },
          signing: { keys: [{ publicKey, kms }] },
        }),
    ).expect(200);

    const signed = await signedImagesOf(admin, projectId);
    expect(signed).toEqual({
      repository: expect.stringMatching(/^ghcr\.io\/acme\/.+$/) as unknown,
      publicKeys: [publicKey],
      registryKind: "github-token",
    });

    /**
     * Phép khẳng định quan trọng nhất của ô này: chuỗi mà pipeline dùng để đẩy image PHẢI chứa đúng
     * `repository` vừa tính. Hai nơi, một giá trị.
     */
    const pipeline = await as(
      developer,
      request(app).get(
        `${API}/projects/${projectId}/domains/CICD/pipeline-template`,
      ),
    ).expect(200);
    expect(pipeline.body.content).toContain(signed?.repository);

    /** Và policy sinh từ nó đòi chữ ký ở đúng ba glob của repository ấy */
    const policy = imageValidatingPolicy(signed) as {
      spec: { matchImageReferences: { glob: string }[] };
    };
    expect(policy.spec.matchImageReferences.map((m) => m.glob)).toEqual([
      signed?.repository,
      `${signed?.repository ?? ""}:*`,
      `${signed?.repository ?? ""}@*`,
    ]);
  });
});
