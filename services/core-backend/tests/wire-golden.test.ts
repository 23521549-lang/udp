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
