import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { createPipelineStepAdapter } from "../src/modules/adapter-base/pipeline-steps.js";
import { validateAndOrder } from "../src/modules/capability/capability.resolver.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import githubActions from "../src/modules/cicd-adapter/github-actions/index.js";
import ghcr from "../src/modules/container-registry-adapter/ghcr/index.js";
import terraform from "../src/modules/infra-adapter/terraform/index.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import { simCloudPlatform } from "./helpers/cloud-platform.js";
import {
  noRepoSource,
  inertCloudPlatform,
  inertProvisioning,
  outsidePlatform,
} from "./helpers/inert-deps.js";

/**
 * Plan #37 AC-2..AC-5 trên registry THẬT của sản phẩm: export có tên của mười bốn adapter, bước
 * pipeline của họ bước (an toàn cho template, state khoá theo environment, bí mật chỉ bằng TÊN),
 * validator đòi CI cho bước pipeline, và `CLOUD_MISMATCH` qua HTTP với credential cloud thật trong
 * database. Bộ hợp đồng 42 phép của từng adapter nằm cạnh adapter.
 */

const product = createRegistry({
  root: resolve(import.meta.dirname, "../src/modules"),
});

const loadedOf = async (key: string) => {
  const found = (await product).all().find((l) => l.key === key);
  if (found === undefined) throw new Error(`registry thiếu ${key}`);
  return found;
};

describe("export có tên của IaC và Security (QĐ-2, QĐ-5)", () => {
  it("sáu tool chạy trong CI xuất pipelineSteps; ba operator cloud xuất cloud; còn lại không", async () => {
    const registry = await product;
    const of = (domain: string) =>
      registry.all().filter((l) => l.adapter.domainType === domain);
    const infraAndSecurity = [...of("INFRA"), ...of("SECURITY")];
    expect(infraAndSecurity.map((l) => l.adapter.toolId).sort()).toEqual([
      "ack",
      "ansible",
      "aqua",
      "aso",
      "checkov",
      "config-connector",
      "crossplane",
      "falco",
      "grype",
      "pulumi",
      "snyk",
      "terraform",
      "trivy",
      "zap",
    ]);
    expect(
      infraAndSecurity
        .filter((l) => l.pipelineSteps !== undefined)
        .map((l) => l.adapter.toolId)
        .sort(),
    ).toEqual(["ansible", "checkov", "grype", "pulumi", "terraform", "zap"]);
    expect(
      Object.fromEntries(
        infraAndSecurity
          .filter((l) => l.cloud !== undefined)
          .map((l) => [l.adapter.toolId, l.cloud]),
      ),
    ).toEqual({ ack: "AWS", "config-connector": "GCP", aso: "AZURE" });
  });
});

describe("bước pipeline (QĐ-3, QĐ-4)", () => {
  const project = { slug: "web" };

  it("Terraform: plan trước build, backend khoá theo project + environment, bí mật chỉ TÊN", async () => {
    const { pipelineSteps } = await loadedOf("infra:terraform");
    const [step] = pipelineSteps!(
      {
        backend: {
          kind: "s3",
          bucket: "acme-tfstate",
          region: "ap-southeast-1",
        },
      },
      project,
    );
    expect(step).toMatchObject({
      tool: "terraform",
      phase: "before-build",
      image: "hashicorp/terraform:1.9.8",
      secretEnv: [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ],
    });
    const script = step!.commands.join("\n");
    expect(script).toContain(
      '-backend-config="key=udp/web/$UDP_ENVIRONMENT/terraform.tfstate"',
    );
    expect(script).toContain('-backend-config="use_lockfile=true"');
    // Mặc định KHÔNG áp: áp hạ tầng từ mỗi lần push là quyết định của người dùng
    expect(script).not.toContain(" apply ");
  });

  it("autoApply ⇒ apply ĐÚNG bản plan vừa lập; GCS/Azure dùng khoá chống ghi của chính backend", async () => {
    const { pipelineSteps } = await loadedOf("infra:terraform");
    const gcs = pipelineSteps!(
      { backend: { kind: "gcs", bucket: "acme-tf" }, autoApply: true },
      project,
    )[0]!.commands;
    expect(gcs.at(-1)).toBe("terraform -chdir=infra apply -input=false tfplan");
    expect(gcs[0]).toContain(
      '-backend-config="prefix=udp/web/$UDP_ENVIRONMENT"',
    );
  });

  it("Pulumi: stack = environment, backend có tiền tố project, passphrase là biến bí mật", async () => {
    const { pipelineSteps } = await loadedOf("infra:pulumi");
    const [step] = pipelineSteps!(
      { backend: { kind: "gcs", bucket: "acme-pulumi" }, runtime: "python" },
      project,
    );
    expect(step!.image).toBe("pulumi/pulumi-python:3.136.1");
    expect(step!.commands).toContain('pulumi login "gs://acme-pulumi/udp/web"');
    expect(step!.commands).toContain(
      'pulumi --cwd infra stack select --create "$UDP_ENVIRONMENT"',
    );
    expect(step!.secretEnv).toContain("PULUMI_CONFIG_PASSPHRASE");
  });

  it("Grype và ZAP sau build; Checkov trước; ZAP bỏ qua environment không có mục tiêu", async () => {
    const phases = await Promise.all(
      [
        ["security:checkov", {}],
        ["security:grype", {}],
        ["security:zap", { targets: { staging: "https://staging.acme.dev" } }],
      ].map(async ([key, config]) => {
        const { pipelineSteps } = await loadedOf(key as string);
        return pipelineSteps!(config as Record<string, unknown>, project)[0]!;
      }),
    );
    expect(phases.map((s) => s.phase)).toEqual([
      "before-build",
      "after-build",
      "after-build",
    ]);
    expect(phases[1]!.commands[0]).toContain('grype "registry:$IMAGE_REF"');
    expect(phases[2]!.commands.join("\n")).toContain(
      "staging) TARGET=https://staging.acme.dev ;;",
    );
  });

  it("bước mang ký tự không an toàn cho template hay tên không phải nhãn ⇒ NÉM, không lọt vào template", () => {
    const make = (command: string, name = "ok") =>
      createPipelineStepAdapter({
        domainType: "SECURITY",
        toolId: "gia",
        version: "0.1.0",
        provides: "security.scan",
        attributes: {},
        configSchema: {} as never,
        describe: () => ({}),
        steps: () => [
          {
            name,
            phase: "after-build",
            image: "alpine:3.20",
            commands: [command],
            env: {},
            secretEnv: [],
          },
        ],
      }).pipelineSteps({}, project);
    expect(() => make("echo 'x'")).toThrow(/không an toàn/);
    expect(() => make("echo 100%")).toThrow(/không an toàn/);
    expect(() => make("echo ok", "Ten Sai")).toThrow(/không phải nhãn/);
    expect(make("echo ok")).toHaveLength(1);
  });
});

describe("validator: bước pipeline cần CI (AC-2)", () => {
  it("Terraform một mình ⇒ MISSING_CAPABILITY pipeline.trigger; có CI + registry ⇒ hợp lệ", () => {
    const alone = validateAndOrder([terraform]);
    expect(alone.valid).toBe(false);
    expect(alone.errors[0]).toMatchObject({
      code: "MISSING_CAPABILITY",
      detail: ["pipeline.trigger"],
    });
    expect(validateAndOrder([terraform, githubActions, ghcr]).valid).toBe(true);
  });
});

// ---------------------------------------------------------------- CLOUD_MISMATCH qua HTTP

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_iac_security_admin",
});

let app: ReturnType<typeof createApp>;
let world: TestWorld;
let owner: Actor;
let projectId: string;

beforeAll(async () => {
  app = createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    repoSource: noRepoSource,
    platform: outsidePlatform,
    domainRegistry: () => product,
    provisioning: inertProvisioning,
  });
  world = testWorld(app, admin);
  owner = await world.newActor("iac-owner");
  ({ projectId } = await world.newProject(owner));
}, 120_000);

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

const validateUrl = () => `${API}/projects/${projectId}/domains/validate`;
const ackOnly = {
  domains: [
    {
      domainType: "INFRA",
      toolId: "ack",
      config: { roleArn: "arn:aws:iam::123456789012:role/udp-ack" },
    },
  ],
  preferences: [],
};

describe("CLOUD_MISMATCH (AC-5)", () => {
  it("chưa có credential ⇒ chưa kiểm được cloud, ACK hợp lệ", async () => {
    const res = await as(
      owner,
      request(app).post(validateUrl()).send(ackOnly),
    ).expect(200);
    expect(res.body.validation.valid).toBe(true);
  });

  it("credential GCP ⇒ ACK là CLOUD_MISMATCH kèm gợi ý Config Connector; lưu ⇒ 422 cùng mã", async () => {
    await admin.cloudCredential.create({
      data: {
        projectId,
        provider: "GCP",
        region: "asia-southeast1",
        mode: "BYOC",
        authKind: "GCP_WIF",
        encryptedPayload: "khong-dung-toi",
        encryptedDek: "khong-dung-toi",
        nonce: "0".repeat(24),
        authTag: "0".repeat(24),
        fingerprint: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        isActive: true,
        createdById: owner.userId,
      },
    });
    const res = await as(
      owner,
      request(app).post(validateUrl()).send(ackOnly),
    ).expect(200);
    expect(res.body.validation.valid).toBe(false);
    expect(res.body.validation.deployOrder).toBeNull();
    expect(res.body.validation.errors).toEqual([
      {
        code: "CLOUD_MISMATCH",
        subject: "infra:ack",
        detail: ["AWS", "GCP"],
        suggestedAction: {
          type: "SWITCH_TOOL",
          domainType: "INFRA",
          toolId: "config-connector",
        },
      },
    ]);

    const put = await as(
      owner,
      request(app)
        .put(`${API}/projects/${projectId}/domains`)
        .send({ ...ackOnly, lastKnownDomainSetVersion: 0 }),
    ).expect(422);
    expect(put.body.code).toBe("CLOUD_MISMATCH");
  });
});

describe("CLOUD_MISMATCH là lý do chặn provisioning (credential đổi cloud SAU khi lưu domain)", () => {
  it("domain Config Connector trên project AWS ⇒ domains-invalid; đổi sang ACK ⇒ hết chặn", async () => {
    const simApp = createApp({
      metricsFor: () => new FakeMetricsProvider(),
      flagService: createFlagServiceClient({
        baseUrl: "http://127.0.0.1:9",
        secret: env.INTERNAL_SERVICE_SECRET,
      }),
      oidcIssuer: null,
      cloud: simCloudPlatform(),
      repoSource: noRepoSource,
      platform: outsidePlatform,
      domainRegistry: () => product,
      provisioning: { ...inertProvisioning, egressCidrs: ["203.0.113.0/24"] },
    });
    const { projectId: pid } = await world.newProject(owner);
    await as(
      owner,
      request(simApp)
        .put(`${API}/projects/${pid}/cloud`)
        .send({
          mode: "BYOC",
          provider: "AWS",
          region: "ap-southeast-1",
          credential: {
            authKind: "AWS_KEY",
            accessKeyId: "AKIAEXAMPLEEXAMPLE37",
            secretAccessKey: "bi-mat-cua-khach-trong-test-p37",
          },
        }),
    ).expect(200);
    const row = await admin.domainConfig.create({
      data: {
        projectId: pid,
        domainType: "INFRA",
        isEnabled: true,
        selectedTool: "config-connector",
        toolConfig: {
          googleServiceAccount:
            "udp-cnrm@acme-prod-123.iam.gserviceaccount.com",
        },
      },
    });
    const preview = () =>
      as(owner, request(simApp).get(`${API}/projects/${pid}/preview`)).expect(
        200,
      );
    expect((await preview()).body.preview.blockers).toContain(
      "domains-invalid",
    );

    await admin.domainConfig.update({
      where: { id: row.id },
      data: {
        selectedTool: "ack",
        toolConfig: { roleArn: "arn:aws:iam::123456789012:role/udp-ack" },
      },
    });
    expect((await preview()).body.preview.blockers).not.toContain(
      "domains-invalid",
    );
  });
});
