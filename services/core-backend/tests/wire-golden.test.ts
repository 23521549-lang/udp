import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { testerResultSchema } from "@udp/shared-types/flag-api";
import * as wire from "@udp/shared-types/wire";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import { fixtureFileOf, WIRE_FIXTURE_DIR } from "./helpers/wire-capture.js";

/**
 * [v4.11] Hợp đồng dây giữa Service 1 và Portal — ba phép kiểm, mỗi cái chặn một cách
 * hỏng khác nhau.
 *
 * 1. **Golden:** mỗi route Portal gọi có một response THẬT đã ghi, và schema của nó parse
 *    được response đó. Không có nửa này thì schema chỉ tự thoả chính nó.
 * 2. **Đủ:** không route nào trong bảng thiếu mẫu, và không mẫu nào nằm ngoài bảng — một
 *    route mới Portal chưa biết phải được KHAI, không được lọt qua im lặng.
 * 3. **Cổng gọi:** controller mà Portal tiêu thụ gửi qua `sendJson`, không `res.json` trần.
 *    Không có cổng này thì controller thứ chín thêm sau sẽ lặng lẽ đi ra ngoài hợp đồng.
 *
 * Ghi lại mẫu: xoá `tests/fixtures/wire/` rồi chạy
 * `UDP_CAPTURE_WIRE=1 pnpm --filter @udp/core-backend test` (xem `helpers/wire-capture.ts`).
 */

/** Route (đã chuẩn hoá bởi `routeKeyOf`) → schema của response 2xx */
const ROUTES: Record<string, ZodTypeAny> = {
  "POST /auth/register": wire.authSessionResponseWire,
  "POST /auth/login": wire.authSessionResponseWire,
  "POST /auth/refresh": wire.authSessionResponseWire,
  "GET /auth/me": wire.meResponseWire,

  "POST /projects": wire.projectDetailResponseWire,
  "GET /projects": wire.projectListResponseWire,
  "GET /projects/{id}": wire.projectDetailResponseWire,
  "PATCH /projects/{id}/quota": wire.projectResponseWire,
  "PATCH /projects/{id}/ttl": wire.projectResponseWire,
  "GET /projects/{id}/audit": wire.auditListResponseWire,

  "GET /projects/{id}/members": wire.memberListResponseWire,
  "POST /projects/{id}/members": wire.memberResponseWire,
  "PATCH /projects/{id}/members/{id}": wire.memberResponseWire,
  "POST /projects/{id}/transfer-ownership": wire.memberResponseWire,

  "GET /projects/{id}/environments": wire.environmentListResponseWire,
  "POST /projects/{id}/environments": wire.environmentCreatedResponseWire,
  "PATCH /projects/{id}/environments/{id}": wire.environmentResponseWire,
  "DELETE /projects/{id}/environments/{id}":
    wire.environmentDeletedResponseWire,
  "GET /projects/{id}/environments/{id}/keys": wire.sdkKeyListResponseWire,
  "POST /projects/{id}/environments/{id}/keys": wire.sdkKeyCreatedResponseWire,
  "DELETE /projects/{id}/environments/{id}/keys/{id}": wire.sdkKeyResponseWire,

  "POST /projects/{id}/flags": wire.flagResponseWire,
  "GET /projects/{id}/flags": wire.flagListResponseWire,
  "GET /projects/{id}/flags/stale": wire.staleFlagsResponseWire,
  "POST /projects/{id}/flags/bulk-archive": wire.bulkArchiveResponseWire,
  "GET /projects/{id}/flags/{id}": wire.flagResponseWire,
  "PATCH /projects/{id}/flags/{id}": wire.flagResponseWire,
  "GET /projects/{id}/flags/{id}/stats": wire.flagStatsViewResponseWire,
  "GET /projects/{id}/flags/{id}/variants": wire.flagVariantsResponseWire,
  "PUT /projects/{id}/flags/{id}/variants": wire.flagResponseWire,
  "POST /projects/{id}/flags/{id}/promote": wire.promoteResponseWire,
  "GET /projects/{id}/flags/{id}/envs": wire.flagEnvsResponseWire,
  "PATCH /projects/{id}/flags/{id}/envs/{id}": wire.flagEnvResponseWire,
  "GET /projects/{id}/flags/{id}/envs/{id}/rules": wire.rulesResponseWire,
  "PUT /projects/{id}/flags/{id}/envs/{id}/rules": wire.rulesResponseWire,
  "POST /projects/{id}/flags/{id}/evaluate": testerResultSchema,

  "GET /projects/{id}/segments": wire.segmentListResponseWire,
  "POST /projects/{id}/segments": wire.segmentResponseWire,
  "GET /projects/{id}/segments/{id}": wire.segmentResponseWire,
  "PUT /projects/{id}/segments/{id}": wire.segmentResponseWire,

  "POST /projects/{id}/rollouts": wire.rolloutResponseWire,
  "GET /projects/{id}/rollouts": wire.rolloutListResponseWire,
  "GET /projects/{id}/rollouts/{id}": wire.rolloutResponseWire,
  "GET /projects/{id}/rollouts/{id}/events": wire.rolloutEventsResponseWire,
  "POST /projects/{id}/rollouts/{id}/actions": wire.rolloutActionResponseWire,
  "POST /projects/{id}/rollouts/probe": wire.rolloutProbeResponseWire,

  "GET /projects/{id}/deployments": wire.deploymentListResponseWire,
  "GET /projects/{id}/metrics/dora": wire.doraResponseWire,
  "POST /projects/{id}/deployments/{id}/approve":
    wire.deployAcceptedResponseWire,

  "GET /domains/catalog": wire.domainCatalogResponseWire,
  "GET /projects/{id}/domains": wire.projectDomainsResponseWire,
  "PUT /projects/{id}/domains": wire.putDomainsResponseWire,
  "POST /projects/{id}/domains/validate": wire.domainValidationResponseWire,
  "GET /projects/{id}/domains/MONITORING": wire.projectDomainResponseWire,
  "GET /projects/{id}/domains/MONITORING/drift": wire.domainDriftResponseWire,
  "POST /projects/{id}/domains/MONITORING/drift": wire.domainDriftResponseWire,
  "POST /projects/{id}/domains/MONITORING/upgrade": wire.jobResponseWire,
  "GET /projects/{id}/domains/CICD/webhook": wire.cicdStatusResponseWire,
  "POST /projects/{id}/domains/CICD/webhook-secret":
    wire.cicdSecretResponseWire,
  "GET /projects/{id}/domains/CICD/pipeline-template":
    wire.pipelineTemplateResponseWire,
  /** CI gọi, không phải Portal — nhưng đi `sendJson` nên cũng có mẫu và schema */
  "POST /webhooks/cicd/{id}/github-actions": wire.deployAcceptedResponseWire,

  "GET /projects/{id}/cloud": wire.cloudResponseWire,
  "GET /projects/{id}/cloud/setup": wire.cloudSetupResponseWire,
  "PUT /projects/{id}/cloud": wire.cloudResponseWire,
  "POST /projects/{id}/cloud/validate": wire.cloudValidationResponseWire,
  "POST /projects/{id}/cloud/preflight": wire.cloudPreflightResponseWire,

  "GET /projects/{id}/preview": wire.provisionPreviewResponseWire,
  "GET /projects/{id}/cost": wire.costResponseWire,
  "POST /projects/{id}/provision": wire.jobResponseWire,
  "GET /projects/{id}/jobs": wire.jobListResponseWire,
  "GET /projects/{id}/jobs/{id}": wire.jobDetailResponseWire,
  "POST /projects/{id}/jobs/{id}/cancel": wire.jobResponseWire,
  "POST /projects/{id}/jobs/{id}/retry": wire.jobResponseWire,

  "GET /admin/users": wire.adminUsersResponseWire,
  "PATCH /admin/users/{id}/platform-role": wire.adminUserResponseWire,
  "GET /admin/projects": wire.adminProjectsResponseWire,
  "GET /admin/credentials": wire.adminCredentialsResponseWire,
  "GET /admin/jobs": wire.adminJobsResponseWire,
  "GET /admin/orphan-resources": wire.adminOrphansResponseWire,
  "GET /admin/system/health": wire.adminSystemResponseWire,
};

/**
 * Route có schema nhưng CHƯA có mẫu thật, kèm lý do. Danh sách này phải ngắn và mỗi
 * dòng phải nói được vì sao bộ test tích hợp không đi qua đường 2xx của route đó.
 */
const NO_GOLDEN_YET: Record<string, string> = {};

interface Fixture {
  route: string;
  status: number;
  body: unknown;
}

const readFixtures = (): Fixture[] => {
  let files: string[];
  try {
    files = readdirSync(WIRE_FIXTURE_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  return files.map(
    (f) =>
      JSON.parse(readFileSync(join(WIRE_FIXTURE_DIR, f), "utf8")) as Fixture,
  );
};

describe("hợp đồng dây S1 → Portal: golden capture", () => {
  const fixtures = readFixtures();
  const byRoute = new Map(fixtures.map((f) => [f.route, f]));

  it("thư mục mẫu không rỗng — một cổng quét 0 tệp thì xanh vĩnh viễn", () => {
    expect(fixtures.length).toBeGreaterThan(20);
  });

  it("mọi mẫu đã ghi đều thuộc một route đã khai", () => {
    const unknown = fixtures
      .map((f) => f.route)
      .filter((r) => ROUTES[r] === undefined);
    expect(unknown).toEqual([]);
  });

  it("mọi route đã khai đều có mẫu, trừ danh sách miễn trừ có lý do", () => {
    const missing = Object.keys(ROUTES).filter(
      (r) => !byRoute.has(r) && NO_GOLDEN_YET[r] === undefined,
    );
    expect(missing).toEqual([]);
  });

  it("tên tệp mẫu suy được từ route — không tệp nào đặt tay", () => {
    const files = readdirSync(WIRE_FIXTURE_DIR).filter((f) =>
      f.endsWith(".json"),
    );
    expect(files.sort()).toEqual(
      fixtures.map((f) => fixtureFileOf(f.route)).sort(),
    );
  });

  for (const [route, schema] of Object.entries(ROUTES)) {
    it(`${route}: schema parse được response thật`, () => {
      const fixture = byRoute.get(route);
      if (fixture === undefined) {
        expect(NO_GOLDEN_YET[route]).toBeDefined();
        return;
      }
      const parsed = schema.safeParse(fixture.body);
      expect(
        parsed.success ? [] : parsed.error.issues.map((i) => i.path.join(".")),
      ).toEqual([]);
    });
  }
});

/**
 * Đối chứng: schema `.strict()` thật sự từ chối khoá lạ. Nếu một lần "dọn dẹp" bỏ
 * `.strict()` thì trường nội bộ lọt lên dây mà không nơi nào đỏ — ô này đỏ.
 */
describe("đối chứng: schema wire từ chối trường thừa", () => {
  it("project có thêm cột nội bộ ⇒ không parse được", () => {
    const fixture = readFixtures().find(
      (f) => f.route === "GET /projects/{id}",
    );
    expect(fixture).toBeDefined();
    const body = structuredClone(fixture?.body) as {
      project: Record<string, unknown>;
    };
    body.project.clusterAccess = { endpoint: "https://10.0.0.1" };
    expect(wire.projectDetailResponseWire.safeParse(body).success).toBe(false);
  });

  it("project thiếu myRole ⇒ không parse được", () => {
    const fixture = readFixtures().find((f) => f.route === "GET /projects");
    const body = structuredClone(fixture?.body) as {
      projects: Record<string, unknown>[];
    };
    expect(body.projects.length).toBeGreaterThan(0);
    delete body.projects[0]?.myRole;
    expect(wire.projectListResponseWire.safeParse(body).success).toBe(false);
  });
});

// ------------------------------------------------------------- cổng gọi

const here = dirname(fileURLToPath(import.meta.url));
const MODULES = join(here, "..", "src", "modules");

/** Module có route Portal tiêu thụ — thêm module mới vào Portal thì thêm vào đây */
const PORTAL_MODULES = [
  "auth",
  "project",
  "member",
  "environment",
  "flag",
  "segment",
  "rollout",
  "deployment",
  "cloud",
  "domain",
  "provisioning",
  "admin",
  "cicd",
  "cost",
];

describe("cổng gọi: controller Portal tiêu thụ gửi qua sendJson", () => {
  const files = PORTAL_MODULES.flatMap((m) =>
    readdirSync(join(MODULES, m))
      .filter((f) => /\.(controller|routes)\.ts$/.test(f))
      .map((f) => join(MODULES, m, f)),
  );

  it("quét được đủ tệp — không phải 0", () => {
    expect(files.length).toBeGreaterThanOrEqual(PORTAL_MODULES.length);
  });

  it("không controller nào gọi res.json trần", () => {
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\bres(\.status\([^)]*\))?\.json\(/.test(line))
        .map(({ n }) => `${relative(MODULES, file)}:${String(n)}`),
    );
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------------------- đủ theo mã

/**
 * [Plan #42] Chiều ngược của "mọi mẫu thuộc một route đã khai": mọi route KHAI TRONG MÃ mà gửi qua
 * `sendJson` phải có dòng trong `ROUTES`. Không có chiều này thì một route mới quên khai bảng lọt
 * qua cả ba phép trên — không mẫu, không dòng, không ai đỏ (sổ nợ `portal-response-schema`).
 *
 * Tiền tố của từng router đọc từ CHÍNH các lệnh mount (`app.ts`, `projectRouter.use("/:id", …)`),
 * không khai tay. Tham số (`:id`, `:type`, `:provider`) khớp MỌI đoạn cụ thể của mẫu — bảng giữ
 * đường dẫn thật đã ghi (`/domains/MONITORING`, `/cicd/{id}/github-actions`). Route trả 204 không
 * thân và luồng SSE không gửi qua `sendJson` nên không thuộc phép này; route giao cho hàm xử lý
 * đặt tên ở tệp khác không được quét — phép "mọi mẫu thuộc một route đã khai" giữ nó.
 */
describe("đủ theo mã: mọi route gửi qua sendJson có dòng trong ROUTES", () => {
  const SRC = join(here, "..", "src");
  const appText = readFileSync(join(SRC, "app.ts"), "utf8");
  const projectText = readFileSync(
    join(MODULES, "project", "project.controller.ts"),
    "utf8",
  );
  const base = new Map<string, string>();
  for (const m of appText.matchAll(
    /app\.use\(`\$\{API_PREFIX\}(\/[a-z]+)`,\s*(\w+Router)\)/g,
  )) {
    base.set(m[2] as string, m[1] as string);
  }
  for (const m of appText.matchAll(/app\.use\(API_PREFIX,\s*(\w+Router)\)/g)) {
    base.set(m[1] as string, "");
  }
  for (const m of projectText.matchAll(
    /projectRouter\.use\("\/:id",\s*(\w+Router)\)/g,
  )) {
    base.set(m[1] as string, "/projects/{id}");
  }

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
          ? [join(dir, e.name)]
          : [],
    );
  const declared = walk(MODULES).flatMap((file) =>
    [
      ...readFileSync(file, "utf8").matchAll(
        /(\w+Router)\.(get|post|put|patch|delete)\(\s*"([^"]*)",([\s\S]*?)\n\);/g,
      ),
    ].flatMap((m) => {
      const prefix = base.get(m[1] as string);
      if (prefix === undefined || !(m[4] as string).includes("sendJson(")) {
        return [];
      }
      const path =
        `${prefix}${m[3] as string}`
          .replace(/\/$/, "")
          .replace(/:[A-Za-z]+/g, "{id}") || "/";
      return [`${(m[2] as string).toUpperCase()} ${path}`];
    }),
  );
  const keys = Object.keys(ROUTES);
  const covered = (route: string): boolean => {
    const pattern = new RegExp(
      `^${route
        .split("{id}")
        .map((part) => part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
        .join("[^/]+")}$`,
    );
    return keys.some((k) => pattern.test(k));
  };

  it("đọc được mount và route — không phải 0", () => {
    expect(base.size).toBeGreaterThanOrEqual(10);
    expect(declared.length).toBeGreaterThan(50);
  });

  it("không route sendJson nào thiếu dòng trong ROUTES", () => {
    expect(declared.filter((r) => !covered(r)).sort()).toEqual([]);
  });
});
