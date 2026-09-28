import { resolve } from "node:path";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import type { RepoSource } from "@udp/golden-path";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { isCicdAdapter } from "../src/modules/cicd/cicd-webhook.service.js";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import { PIPELINE_PATHS } from "../src/modules/golden-path/golden-path.service.js";
import {
  createRepoSourceFactory,
  type RepoSourceFactory,
} from "../src/modules/golden-path/repo-source.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import { inertCloudPlatform, inertProvisioning } from "./helpers/inert-deps.js";

/**
 * Plan #48 qua HTTP thật và database thật: cây Golden Path theo runtime (kèm pipeline của tool CI/CD
 * đang bật và registry của binding), quét repo Import Existing với nguồn trong bộ nhớ (không mạng),
 * lưu kết quả mới nhất, phân quyền và 422 cho host/runtime ngoài phạm vi.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_golden_path_admin",
});

/** Repo giả theo URL — ghi lại token mỗi lượt quét để kiểm nó tới đúng nguồn */
const repos = new Map<string, Record<string, string>>();
const tokens: (string | undefined)[] = [];
const memoryRepos: RepoSourceFactory = (repoUrl, token) => {
  tokens.push(token);
  const files = repos.get(repoUrl);
  if (files === undefined)
    return createRepoSourceFactory(() =>
      Promise.reject(new Error("không mạng")),
    )(repoUrl, token);
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
  domainRegistry: () => registry,
  provisioning: inertProvisioning,
});

let world: TestWorld;
let owner: Actor;
let developer: Actor;
let viewer: Actor;
let createNew: string;
let imported: string;

const IMPORT_URL = "https://github.com/acme/legacy-web";

async function newProjectAs(
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
      repoUrl: mode === "IMPORT_EXISTING" ? IMPORT_URL : null,
    },
  });
  return projectId;
}

beforeAll(async () => {
  world = testWorld(app, admin);
  owner = await world.newActor("gp-owner");
  developer = await world.newActor("gp-developer");
  viewer = await world.newActor("gp-viewer");
  createNew = await newProjectAs("python");
  imported = await newProjectAs("nodejs", "IMPORT_EXISTING");
  repos.set(IMPORT_URL, {
    "package.json": JSON.stringify({
      dependencies: { express: "^4", "prom-client": "^15" },
    }),
    "src/index.ts": "import express from 'express';",
    ".github/workflows/ci.yml": "jobs: {}",
  });
}, 120_000);

afterAll(async () => {
  await world.cleanup();
  await admin.$disconnect();
});

const gpUrl = (projectId: string) => `${API}/projects/${projectId}/golden-path`;
const scanUrl = (projectId: string) => `${API}/projects/${projectId}/repo-scan`;

describe("GET /projects/:id/golden-path", () => {
  it("chưa bật CI/CD, chưa có registry ⇒ cây Python đủ, REGISTRY_REF còn nguyên, notes nói vì sao", async () => {
    const res = await as(developer, request(app).get(gpUrl(createNew))).expect(
      200,
    );
    expect(res.body.runtime).toBe("python");
    expect(res.body.files.map((f: { path: string }) => f.path)).toContain(
      "app/main.py",
    );
    expect(res.body.pipeline).toBeNull();
    expect(res.body.notes.join(" ")).toMatch(/CI\/CD/);
    expect(res.body.notes.join(" ")).toMatch(/REGISTRY_REF/);
    const deployment = res.body.files.find(
      (f: { path: string }) => f.path === "k8s/deployment.yaml",
    );
    expect(deployment.content).toContain(`name: ${res.body.slug as string}`);
  });

  it("bật CI/CD + registry ⇒ pipeline của tool đúng đường, chạy test Python, image trỏ đúng registry", async () => {
    const cicd = await admin.domainConfig.create({
      data: {
        projectId: createNew,
        domainType: "CICD",
        isEnabled: true,
        selectedTool: "github-actions",
        toolConfig: { repository: "acme/web" },
      },
    });
    const registryConfig = await admin.domainConfig.create({
      data: {
        projectId: createNew,
        domainType: "CONTAINER_REGISTRY",
        isEnabled: true,
        selectedTool: "ghcr",
        toolConfig: {},
      },
    });
    await admin.capabilityBinding.create({
      data: {
        domainConfigId: registryConfig.id,
        capabilityId: "registry.oci",
        providedBy: "container-registry:ghcr",
        schemaVersion: "1.0.0",
        endpoint: "ghcr.io/acme",
      },
    });
    try {
      const res = await as(
        developer,
        request(app).get(gpUrl(createNew)),
      ).expect(200);
      expect(res.body.pipeline).toMatchObject({
        provider: "github-actions",
        path: ".github/workflows/udp.yml",
      });
      expect(res.body.pipeline.content).toContain("pytest -q");
      expect(res.body.notes).toEqual([]);
      const deployment = res.body.files.find(
        (f: { path: string }) => f.path === "k8s/deployment.yaml",
      );
      expect(deployment.content).toContain(
        `image: ghcr.io/acme/${res.body.slug as string}:bootstrap`,
      );
    } finally {
      await admin.domainConfig.deleteMany({
        where: { id: { in: [cicd.id, registryConfig.id] } },
      });
    }
  });

  it("runtime ngoài Node/Python ⇒ 422; VIEWER ⇒ 403", async () => {
    await admin.project.update({
      where: { id: createNew },
      data: { languageRuntime: "java" },
    });
    try {
      await as(developer, request(app).get(gpUrl(createNew))).expect(422);
    } finally {
      await admin.project.update({
        where: { id: createNew },
        data: { languageRuntime: "python" },
      });
    }
    await as(viewer, request(app).get(gpUrl(createNew))).expect(403);
  });
});

describe("/projects/:id/repo-scan (§11.2)", () => {
  it("chưa quét ⇒ scan null; project Create New ⇒ 409", async () => {
    const res = await as(viewer, request(app).get(scanUrl(imported))).expect(
      200,
    );
    expect(res.body).toEqual({ scan: null });
    await as(developer, request(app).post(scanUrl(createNew)).send({})).expect(
      409,
    );
  });

  it("DEVELOPER quét ⇒ phát hiện + đề xuất, lưu kết quả MỚI NHẤT, token tới nguồn mà không bị lưu", async () => {
    await as(viewer, request(app).post(scanUrl(imported)).send({})).expect(403);
    const res = await as(
      developer,
      request(app).post(scanUrl(imported)).send({ token: "ghp_bi-mat" }),
    ).expect(200);
    expect(tokens.at(-1)).toBe("ghp_bi-mat");
    expect(res.body.scan).toMatchObject({
      repoUrl: IMPORT_URL,
      host: "github",
      runtime: "nodejs",
      framework: "express",
      cicdTool: "github-actions",
      flagLevelReady: false,
    });
    const status = Object.fromEntries(
      (res.body.scan.findings as { id: string; status: string }[]).map((f) => [
        f.id,
        f.status,
      ]),
    );
    expect(status).toMatchObject({
      dockerfile: "missing",
      "metrics-endpoint": "ok",
      "udp-middleware": "missing",
    });

    const saved = await as(viewer, request(app).get(scanUrl(imported))).expect(
      200,
    );
    expect(saved.body).toEqual(res.body);
    const row = await admin.project.findUniqueOrThrow({
      where: { id: imported },
      select: { repoScan: true },
    });
    expect(JSON.stringify(row.repoScan)).not.toContain("ghp_bi-mat");
  });

  it("host ngoài GitHub/GitLab ⇒ 422 nói rõ, không một lời gọi mạng; thân lạ ⇒ 400", async () => {
    await admin.project.update({
      where: { id: imported },
      data: { repoUrl: "https://bitbucket.org/acme/web" },
    });
    try {
      const res = await as(
        developer,
        request(app).post(scanUrl(imported)).send({}),
      ).expect(422);
      expect(JSON.stringify(res.body)).toMatch(/github\.com hoặc gitlab\.com/);
    } finally {
      await admin.project.update({
        where: { id: imported },
        data: { repoUrl: IMPORT_URL },
      });
    }
    await as(
      developer,
      request(app).post(scanUrl(imported)).send({ khac: 1 }),
    ).expect(400);
  });
});

describe("đường tệp pipeline theo tool", () => {
  it("dòng đầu template của MỖI adapter CI/CD nói đúng đường mà Golden Path đặt tệp", async () => {
    const loaded = await registry;
    const tools = loaded
      .all()
      .map((l) => l.adapter)
      .filter(isCicdAdapter);
    expect(tools.map((a) => a.toolId).sort()).toEqual(
      Object.keys(PIPELINE_PATHS).sort(),
    );
    for (const adapter of tools) {
      const text = adapter.renderPipelineTemplate({
        projectSlug: "web",
        environments: [{ name: "prod", isProduction: true }],
        registryRef: "ghcr.io/a",
        flagKeys: [],
        rolloutStrategy: "udp-driven",
        steps: [],
        languageRuntime: "nodejs",
      });
      expect(text.split("\n")[0], adapter.toolId).toContain(
        PIPELINE_PATHS[adapter.toolId] ?? "?",
      );
    }
  });
});
