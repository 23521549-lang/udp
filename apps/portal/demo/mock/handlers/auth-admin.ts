import { nowIso } from "../clock";
import type { Db } from "../db";
import {
  bodyOf,
  found,
  HttpProblem,
  noContent,
  ok,
  type Router,
} from "../router";

/**
 * Đăng nhập (§10.3) và trang quản trị nền tảng (§10.11). Bản xem thử nhận mọi email/mật khẩu — mọi phiên là
 * người dùng mẫu có quyền PLATFORM_ADMIN, để cả khu `/admin` xem được.
 */

const session = (db: Db) => ({ user: db.me, csrfToken: "demo-csrf-token" });

function requireSignedIn(db: Db): void {
  if (!db.signedIn) {
    throw new HttpProblem(
      401,
      "UNAUTHENTICATED",
      "Phiên đăng nhập đã hết — đăng nhập lại",
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

export function registerAuthAdminRoutes(router: Router, db: Db): void {
  router
    .on("GET", "/auth/me", () => {
      requireSignedIn(db);
      return ok({ user: db.me });
    })
    .on("POST", "/auth/login", () => {
      db.signedIn = true;
      return ok(session(db));
    })
    .on("POST", "/auth/register", (req) => {
      const { name } = bodyOf<{ name?: string }>(req);
      db.signedIn = true;
      if (name !== undefined && name.trim() !== "")
        db.me = { ...db.me, name: name.trim() };
      return ok(session(db), 201);
    })
    .on("POST", "/auth/refresh", () => {
      requireSignedIn(db);
      return ok(session(db));
    })
    .on("POST", "/auth/logout", () => {
      db.signedIn = false;
      return noContent;
    })

    // ---------------------------------------------------------- quản trị
    .on("GET", "/admin/users", (req) => {
      const search = (req.query.get("search") ?? "").toLowerCase();
      return ok({
        users: db.users.filter(
          (u) =>
            search === "" ||
            u.email.includes(search) ||
            u.name.toLowerCase().includes(search),
        ),
      });
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
          "Không tự bỏ quyền quản trị của chính mình trong bản xem thử — trang /admin sẽ không mở được nữa",
        );
      }
      user.platformRole = platformRole;
      return ok({ user });
    })
    .on("GET", "/admin/projects", (req) => {
      const status = req.query.get("status");
      return ok({
        projects: db.projects
          .filter(
            (p) =>
              status === null || status === "" || p.project.status === status,
          )
          .map((p) => {
            const owner = db.users.find((u) => u.id === p.project.ownerId);
            return {
              id: p.project.id,
              name: p.project.name,
              status: p.project.status,
              owner: { id: p.project.ownerId, email: owner?.email ?? "" },
              memberCount: p.members.length,
              cloudProvider: p.cloud?.provider ?? null,
              createdAt: p.project.createdAt,
            };
          }),
      });
    })
    .on("GET", "/admin/credentials", () =>
      ok({
        credentials: db.projects.flatMap((p) =>
          p.cloud === null || p.project.status === "DELETED"
            ? []
            : [
                {
                  id: crypto.randomUUID(),
                  provider: p.cloud.provider,
                  mode: p.cloud.mode,
                  authKind: p.cloud.authKind,
                  fingerprint: p.cloud.fingerprint,
                  isActive: p.cloud.lastValidatedAt !== null,
                  lastValidatedAt: p.cloud.lastValidatedAt,
                  createdAt: p.cloud.createdAt,
                  project: { id: p.project.id, name: p.project.name },
                },
              ],
        ),
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
      return ok({
        jobs: jobs
          .filter((j) => matches(j.state))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      });
    })
    .on("GET", "/admin/orphan-resources", () => {
      const resources = db.projects.flatMap((p) =>
        p.jobs.flatMap(({ detail }) =>
          detail.resources
            .filter((r) => r.status === "ORPHAN_SUSPECTED")
            .map((r) => ({
              id: crypto.randomUUID(),
              projectId: p.project.id,
              projectName: p.project.name,
              kind: r.kind,
              provider: p.cloud?.provider ?? "AWS",
              region: p.cloud?.region ?? "ap-southeast-1",
              providerId: r.providerId,
              usdPerHour:
                r.kind === "NatGateway"
                  ? 0.059
                  : r.kind === "ElasticIp"
                    ? 0.005
                    : null,
              updatedAt: r.updatedAt,
            })),
        ),
      );
      return ok({
        resources,
        estimatedUsdPerHour:
          Math.round(
            resources.reduce((s, r) => s + (r.usdPerHour ?? 0), 0) * 1000,
          ) / 1000,
        unpriced: resources
          .filter((r) => r.usdPerHour === null)
          .map((r) => r.kind),
        pricingAsOf: "2026-09-01",
        cloudScanned: true,
      });
    })
    .on("GET", "/admin/system/health", () =>
      ok({
        services: [
          { name: "udp-core-backend", status: "up" },
          { name: "udp-feature-flag-service", status: "up" },
          { name: "udp-pd-controller", status: "up" },
        ],
        database: "up",
        checkedAt: nowIso(),
      }),
    );
}
