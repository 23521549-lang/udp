import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { DOMAIN_TYPES } from "@udp/config/domains";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import {
  createRegistry,
  type DomainAdapterRegistry,
} from "../src/modules/domain/domain-adapter.registry.js";
import {
  API,
  as,
  testWorld,
  type Actor,
  type TestWorld,
} from "./helpers/api.js";
import { inertCloudPlatform } from "./helpers/inert-deps.js";

/**
 * `GET /domains/catalog` (Plan #27 AC-1) — dựng TỪ registry, và phép kiểm DƯƠNG TÍNH của
 * I28: thả một thư mục adapter mới vào cây, không sửa tệp nào khác, và nó hiện trên catalog.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_domain_catalog_test_admin",
});

const appWith = (registry: DomainAdapterRegistry) =>
  createApp({
    metricsFor: () => new FakeMetricsProvider(),
    flagService: createFlagServiceClient({
      baseUrl: "http://127.0.0.1:9",
      secret: env.INTERNAL_SERVICE_SECRET,
    }),
    oidcIssuer: null,
    cloud: inertCloudPlatform,
    domainRegistry: () => Promise.resolve(registry),
  });

const PRODUCT_ROOT = resolve(import.meta.dirname, "../src/modules");
/** Cây tạm NẰM TRONG `tests/` để `import()` của adapter phân giải được `zod` như cây thật */
const SCRATCH_ROOT = resolve(
  import.meta.dirname,
  `.registry-${randomUUID().slice(0, 8)}`,
);

/** Một adapter hoàn chỉnh (7 + 6) cho domain LOGGING — đúng thứ một người đóng góp viết */
const NOOP_LOGGER = `import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";

const adapter: DomainAdapter = {
  domainType: "LOGGING",
  toolId: "noop-logger",
  version: "0.1.0",
  scope: "namespace",
  capabilities: { provides: [{ id: "logs.sink", version: "1.0.0" }], requires: [] },
  configSchema: z.object({ level: z.enum(["info", "debug"]).default("info") }),
  deploy: () => Promise.resolve({ status: "SUCCESS", data: [] }),
  configure: () => Promise.resolve({ status: "SUCCESS" }),
  upgrade: () => Promise.resolve({ status: "SUCCESS" }),
  detectDrift: () => Promise.resolve({ status: "SUCCESS", data: { drifted: false } }),
  onDependencyChanged: () => Promise.resolve({ status: "SUCCESS" }),
  healthcheck: () => Promise.resolve({ status: "SUCCESS", data: { healthy: true } }),
  teardown: () => Promise.resolve({ status: "SUCCESS" }),
};

export default adapter;
`;

let world: TestWorld;
let user: Actor;
let product: DomainAdapterRegistry;

beforeAll(async () => {
  product = await createRegistry({ root: PRODUCT_ROOT });
  world = testWorld(appWith(product), admin);
  user = await world.newActor("catalog-user");
});

afterAll(async () => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  await world.cleanup();
  await admin.$disconnect();
});

const catalogOf = async (registry: DomainAdapterRegistry) =>
  (
    await as(
      user,
      request(appWith(registry)).get(`${API}/domains/catalog`),
    ).expect(200)
  ).body as {
    domains: {
      domainType: string;
      isAvailable: boolean;
      tools: { toolId: string }[];
    }[];
  };

describe("GET /domains/catalog", () => {
  it("đủ 16 domain của bảng; tool đọc từ registry, không danh sách cứng", async () => {
    const { domains } = await catalogOf(product);
    expect(domains.map((d) => d.domainType).sort()).toEqual(
      [...DOMAIN_TYPES].sort(),
    );
    const monitoring = domains.find((d) => d.domainType === "MONITORING");
    expect(monitoring?.tools.map((t) => t.toolId)).toEqual([
      "datadog",
      "prometheus-grafana",
    ]);
    expect(domains.find((d) => d.domainType === "LOGGING")?.tools).toEqual([]);
  });

  it("I28 dương tính: thêm MỘT thư mục adapter ⇒ nó hiện trên catalog, 0 tệp khác", async () => {
    const dir = join(SCRATCH_ROOT, "logging-adapter", "noop-logger");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.ts"), NOOP_LOGGER);
    const { domains } = await catalogOf(
      await createRegistry({ root: SCRATCH_ROOT }),
    );
    const logging = domains.find((d) => d.domainType === "LOGGING");
    expect(logging?.tools).toEqual([
      expect.objectContaining({
        toolId: "noop-logger",
        version: "0.1.0",
        scope: "namespace",
        provides: [{ id: "logs.sink", version: "1.0.0" }],
        config: {
          kind: "object",
          fields: [
            {
              key: "level",
              kind: "enum",
              required: false,
              default: "info",
              options: ["info", "debug"],
            },
          ],
        },
      }),
    ]);
  });

  it("chưa đăng nhập ⇒ 401", async () => {
    await request(appWith(product)).get(`${API}/domains/catalog`).expect(401);
  });
});
