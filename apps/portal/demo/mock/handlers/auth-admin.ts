import type { CloudCredentialWire } from "@udp/shared-types/wire";
import { cloudCredentialId } from "../audit";
import { nowIso } from "../clock";
import type { Db } from "../db";
import { rememberSignedIn } from "../persona";
import { uuidOf } from "../random";
import {
  bodyOf,
  found,
  HttpProblem,
  intParam,
  noContent,
  ok,
  type MockRequest,
  type Router,
} from "../router";

/**
 * Đăng nhập (§10.3) và trang quản trị nền tảng (§10.11). Bản xem thử nhận mọi email/mật khẩu — mọi phiên là
 * người đang xem mà dải "Bản xem thử" chọn (mặc định quản trị viên nền tảng, để cả khu `/admin` xem được).
 */

const session = (db: Db) => ({ user: db.me, csrfToken: "demo-csrf-token" });

function requireSignedIn(db: Db): void {
  if (!db.signedIn) {
    throw new HttpProblem(
      401,
      "UNAUTHENTICATED",
      "Phiên đăng nhập đã hết, hãy đăng nhập lại",
    );
  }
}

/** Đang có job chạy dở hay cần người xử lý — thứ trang Job của quản trị lọc theo */
const ACTIVE_STATES = new Set([
  "QUEUED",
  "NETWORK",
  "CLUSTER",
  "CLUSTER_ACCESS",
  "DOMAINS",
  "CANCEL_REQUESTED",
  "COMPENSATING",
]);

/** Một trang của danh sách quản trị: `limit` ≤ 100 như Service 1, `total` đếm theo bộ lọc */
function pageOf<T>(req: MockRequest, rows: T[]): { rows: T[]; total: number } {
  const limit = Math.min(Math.max(intParam(req.query, "limit", 50), 1), 100);
  const offset = Math.max(intParam(req.query, "offset", 0), 0);
  return { rows: rows.slice(offset, offset + limit), total: rows.length };
}

/** Như Service 1: mới tạo trước; `order=asc` là cũ nhất trước */
const byCreated =
  <T>(req: MockRequest, createdAt: (row: T) => string) =>
  (a: T, b: T): number =>
    req.query.get("order") === "asc"
      ? createdAt(a).localeCompare(createdAt(b))
      : createdAt(b).localeCompare(createdAt(a));

/** Giá theo giờ của loại tài nguyên hay bị bỏ lại — `null` là chưa định giá được (không bao giờ là 0) */
const ORPHAN_USD_PER_HOUR: Record<string, number> = {
  NatGateway: 0.059,
  ElasticIp: 0.005,
  PublicIpAddress: 0.005,
  RouterNat: 0.044,
  EksCluster: 0.1,
  ManagedCluster: 0.1,
};

/** [Plan #60 H8] Ba trạng thái "có vấn đề" — như `PROBLEM_JOB_STATES` của Service 1 */
const PROBLEM_STATES = new Set([
  "COMPENSATION_FAILED",
  "FAILED",
  "CANCEL_REQUESTED",
]);

function latestProblemJobOf(p: Db["projects"][number]) {
  const job = p.jobs
    .map(({ detail }) => detail.job)
    .filter((j) => PROBLEM_STATES.has(j.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return job === undefined
    ? null
    : {
        id: job.id,
        jobType: job.jobType,
        state: job.state,
        lastError: job.lastError,
        updatedAt: job.updatedAt,
      };
}

/** Tài nguyên mồ côi toàn hệ thống — trang Tài nguyên mồ côi và thẻ ở Tổng quan dùng chung */
export function orphansOf(db: Db) {
  const resources = db.projects.flatMap((p) =>
    p.jobs.flatMap(({ detail }) =>
      detail.resources
        .filter((r) => r.status === "ORPHAN_SUSPECTED")
        .map((r) => ({
          id: uuidOf(`orphan:${detail.job.id}:${r.name}`),
          projectId: p.project.id,
          projectName: p.project.name,
          kind: r.kind,
          provider: p.cloud?.provider ?? ("AWS" as const),
          region: p.cloud?.region ?? "ap-southeast-1",
          providerId: r.providerId,
          usdPerHour: ORPHAN_USD_PER_HOUR[r.kind] ?? null,
          updatedAt: r.updatedAt,
        })),
    ),
  );
  return {
    resources,
    estimatedUsdPerHour:
      Math.round(
        resources.reduce((s, r) => s + (r.usdPerHour ?? 0), 0) * 1000,
      ) / 1000,
    unpriced: resources.filter((r) => r.usdPerHour === null).map((r) => r.kind),
    pricingAsOf: "2026-09-01",
    cloudScanned: true,
  };
}

export function registerAuthAdminRoutes(router: Router, db: Db): void {
  router
    .on("GET", "/auth/me", () => {
      requireSignedIn(db);
      return ok({ user: db.me });
    })
    .on("POST", "/auth/login", () => {
      db.signedIn = true;
      rememberSignedIn(true);
      return ok(session(db));
    })
    .on("POST", "/auth/register", (req) => {
      const { name, email } = bodyOf<{ name?: string; email?: string }>(req);
      db.signedIn = true;
      rememberSignedIn(true);
      if (name !== undefined && name.trim() !== "")
        db.me = { ...db.me, name: name.trim() };
      if (email !== undefined && email.trim() !== "")
        db.me = { ...db.me, email: email.trim().toLowerCase() };
      return ok(session(db), 201);
    })
    .on("POST", "/auth/refresh", () => {
      requireSignedIn(db);
      return ok(session(db));
    })
    .on("POST", "/auth/logout", () => {
      db.signedIn = false;
      rememberSignedIn(false);
      return noContent;
    })
    // [Plan #60] Bản xem thử bật cả hai cách đăng nhập để xem được; thư và GitHub đều GIẢ LẬP, không gửi gì thật
    .on("GET", "/auth/options", () => ok({ passwordReset: true, github: true }))
    .on("POST", "/auth/password/forgot", () => ok({ status: "accepted" }, 202))
    .on("POST", "/auth/password/reset", (req) => {
      const { token } = bodyOf<{ token?: string }>(req);
      if (token === undefined || token.length < 20) {
        throw new HttpProblem(
          404,
          "NOT_FOUND",
          "Đường dẫn đặt lại mật khẩu không còn dùng được. Xin một thư mới ở trang Quên mật khẩu.",
        );
      }
      return noContent;
    })

    // ---------------------------------------------------------- quản trị
    .on("GET", "/admin/users", (req) => {
      const search = (req.query.get("search") ?? "").toLowerCase();
      const role = req.query.get("platformRole");
      const { rows, total } = pageOf(
        req,
        db.users
          .filter(
            (u) =>
              search === "" ||
              u.email.includes(search) ||
              u.name.toLowerCase().includes(search),
          )
          .filter(
            (u) => role === null || role === "" || u.platformRole === role,
          )
          .sort(byCreated(req, (u) => u.createdAt)),
      );
      return ok({ users: rows, total });
    })
    .on("PATCH", "/admin/users/:id/platform-role", (req, [id = ""]) => {
      const user = found(
        db.users.find((u) => u.id === id),
        "người dùng",
      );
      const { platformRole } = bodyOf<{
        platformRole: "USER" | "PLATFORM_ADMIN";
      }>(req);
      if (user.id === db.me.id && platformRole === "USER") {
        throw new HttpProblem(
          409,
          "LAST_ADMIN_SELF_DEMOTE",
          "Không tự bỏ quyền quản trị của chính mình trong bản xem thử: trang /admin sẽ không mở được nữa",
        );
      }
      user.platformRole = platformRole;
      return ok({ user });
    })
    .on("GET", "/admin/projects", (req) => {
      const status = req.query.get("status");
      const search = (req.query.get("search") ?? "").toLowerCase();
      const ownerEmail = (p: (typeof db.projects)[number]): string =>
        db.users.find((u) => u.id === p.project.ownerId)?.email ?? "";
      const { rows, total } = pageOf(
        req,
        db.projects
          .filter(
            (p) =>
              status === null || status === "" || p.project.status === status,
          )
          // Tìm theo tên project hay email của chủ
          .filter(
            (p) =>
              search === "" ||
              p.project.name.toLowerCase().includes(search) ||
              ownerEmail(p).toLowerCase().includes(search),
          )
          .sort(byCreated(req, (p) => p.project.createdAt)),
      );
      return ok({
        total,
        projects: rows.map((p) => {
          const owner = db.users.find((u) => u.id === p.project.ownerId);
          return {
            id: p.project.id,
            name: p.project.name,
            status: p.project.status,
            owner: { id: p.project.ownerId, email: owner?.email ?? "" },
            memberCount: p.members.length,
            cloudProvider: p.cloud?.provider ?? null,
            createdAt: p.project.createdAt,
            // [Plan #60 H8] Như Service 1: job "có vấn đề" mới nhất của project
            latestProblemJob: latestProblemJobOf(p),
          };
        }),
      });
    })
    .on("GET", "/admin/credentials", () =>
      ok({
        // Như Service 1: MỌI credential, mới nhất trước; chỉ cái đang dùng của project còn sống là "đang dùng"
        credentials: db.projects
          .flatMap((p) => {
            const project = { id: p.project.id, name: p.project.name };
            const row = (
              id: string,
              cloud: CloudCredentialWire,
              isActive: boolean,
            ) => ({
              id,
              provider: cloud.provider,
              mode: cloud.mode,
              authKind: cloud.authKind,
              fingerprint: cloud.fingerprint,
              isActive,
              lastValidatedAt: cloud.lastValidatedAt,
              createdAt: cloud.createdAt,
              project,
            });
            return [
              ...p.retiredClouds.map((r) => row(r.id, r.cloud, false)),
              ...(p.cloud === null
                ? []
                : [
                    row(
                      cloudCredentialId(p.project.id),
                      p.cloud,
                      p.project.status !== "DELETED",
                    ),
                  ]),
            ];
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }),
    )
    .on("GET", "/admin/jobs", (req) => {
      const state = req.query.get("state");
      const jobs = db.projects.flatMap((p) =>
        p.jobs.map(({ detail: { job } }) => ({
          id: job.id,
          jobType: job.jobType,
          state: job.state,
          attempt: job.attempt,
          lastError: job.lastError,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          project: { id: p.project.id, name: p.project.name },
        })),
      );
      const matches = (s: string) =>
        state === null ||
        state === "" ||
        state === s ||
        (state === "ACTIVE" && ACTIVE_STATES.has(s));
      const { rows, total } = pageOf(
        req,
        jobs
          .filter((j) => matches(j.state))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
      return ok({ jobs: rows, total });
    })
    .on("GET", "/admin/orphan-resources", () => ok(orphansOf(db)))
    .on("GET", "/admin/system/health", () =>
      ok({
        services: [
          { name: "udp-core-backend", status: "up" },
          { name: "udp-feature-flag-service", status: "up" },
          {
            name: "udp-pd-controller",
            // Tình huống "có rủi ro": bộ điều khiển rollout không trả lời
            status: db.demo.platform === "at-risk" ? "down" : "up",
          },
        ],
        database: "up",
        checkedAt: nowIso(),
      }),
    );
}
