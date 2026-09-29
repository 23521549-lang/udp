import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flaggerGatePath } from "@udp/http";
import { beforeAll, describe, expect, it } from "vitest";
import { NAMESPACE } from "../src/cluster.js";
import { OIDC_PATH } from "../src/vm.js";
import {
  api,
  call,
  eventually,
  kube,
  login,
  newUser,
  openStream,
  register,
  startSink,
  vmTarget,
  type Session,
  type Target,
  type User,
} from "./support.js";

/**
 * **E2E của máy ảo** (Plan #52 QĐ-11) — trên máy diễn tập mà job `vm` của CI dựng bằng CHÍNH `bootstrap.sh` và
 * `release.sh`:
 *
 *   pnpm --filter @udp/deploy e2e:vm
 *
 * Mỗi kiểm tra là một điều mà chỉ một máy công khai thật mới lộ: Traefik + cert-manager phục vụ đúng host, cookie
 * `Secure` và CSRF qua HAI lớp proxy, bảng route theo tiền tố tới đúng service, đường nội bộ không ra ngoài, SSE
 * sống qua Traefik lâu hơn mọi hạn chờ mặc định, bản sao lưu khôi phục được. KHÔNG chạy trên máy thật
 * (`vmTarget` từ chối): nó đăng ký người dùng và khôi phục database.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY = resolve(here, "..");

let target: Target;
let owner: User;
let session: Session;

beforeAll(async () => {
  target = await vmTarget();
  owner = newUser("owner");
  session = await register(target, owner);
}, 240_000);

const isJson = (contentType: string | undefined): boolean =>
  contentType?.includes("application/json") === true ||
  contentType?.includes("application/problem+json") === true;

describe("đường vào công khai", () => {
  it("HTTP chuyển hướng VĨNH VIỄN sang HTTPS cùng host và cùng đường", async () => {
    const reply = await call(target, "GET", "/app/projects", {
      scheme: "http",
    });
    expect([301, 308]).toContain(reply.status);
    expect(reply.headers.location).toBe(`${target.origin}/app/projects`);
  });

  it("chứng chỉ do cert-manager cấp cho ĐÚNG host — kiểm tên như trình duyệt", async () => {
    const reply = await call(target, "GET", "/");
    expect(reply.peerAltNames).toContain(`DNS:${target.host}`);
  });

  it("Portal phục vụ SPA ở gốc và ở một đường sâu", async () => {
    for (const path of ["/", "/app/projects"]) {
      const reply = await call(target, "GET", path);
      expect(reply.status, path).toBe(200);
      expect(reply.headers["content-type"], path).toContain("text/html");
      expect(reply.body, path).toContain('id="root"');
    }
  });
});

describe("Portal + Service 1 qua HTTPS", () => {
  it("đăng ký rồi đăng nhập qua /api: cookie Secure, CSRF đi qua Traefik và nginx", async () => {
    for (const cookie of session.setCookies) {
      expect(cookie, cookie.split("=")[0]).toMatch(/;\s*Secure/i);
    }
    expect((await login(target, owner)).status).toBe(200);
    const projects = await api<{ projects: unknown[] }>(
      target,
      session,
      "GET",
      "/projects",
    );
    expect(projects.status).toBe(200);
    expect(Array.isArray(projects.body.projects)).toBe(true);
  });
});

describe("route theo tiền tố (QĐ-5)", () => {
  it("/sdk và /ofrep tới Service 2 — thiếu khoá là 401 JSON, không phải trang SPA", async () => {
    const sdk = await call(target, "GET", "/sdk/config");
    expect(sdk.status).toBe(401);
    expect(isJson(sdk.headers["content-type"])).toBe(true);
    const ofrep = await call(target, "POST", "/ofrep/v1/evaluate/flags/x", {
      body: JSON.stringify({ context: { targetingKey: "u" } }),
    });
    expect(ofrep.status).toBe(401);
    expect(isJson(ofrep.headers["content-type"])).toBe(true);
  });

  it("/oidc: discovery của issuer công khai và JWKS có khoá — cloud của khách đọc đúng hai đường này", async () => {
    const discovery = await call(
      target,
      "GET",
      `${OIDC_PATH}/.well-known/openid-configuration`,
    );
    expect(discovery.status).toBe(200);
    const doc = JSON.parse(discovery.body) as {
      issuer: string;
      jwks_uri: string;
    };
    expect(doc.issuer).toBe(`${target.origin}${OIDC_PATH}`);
    expect(doc.jwks_uri.startsWith(target.origin)).toBe(true);
    const jwks = await call(target, "GET", new URL(doc.jwks_uri).pathname);
    expect(jwks.status).toBe(200);
    expect(
      (JSON.parse(jwks.body) as { keys: unknown[] }).keys.length,
    ).toBeGreaterThan(0);
  });

  it("/webhooks/flagger tới Service 3 — session lạ, không token: bị từ chối bằng JSON", async () => {
    const reply = await call(
      target,
      "POST",
      flaggerGatePath("00000000-0000-4000-8000-000000000000", "rollback"),
      { body: JSON.stringify({ metadata: {} }) },
    );
    expect([401, 404]).toContain(reply.status);
    expect(isJson(reply.headers["content-type"])).toBe(true);
  });

  it("đường nội bộ, số đo và probe KHÔNG tới service nào — chỉ nhận trang SPA", async () => {
    for (const path of ["/internal/flags", "/metrics", "/healthz", "/readyz"]) {
      const reply = await call(target, "GET", path);
      expect(reply.headers["content-type"], path).toContain("text/html");
      expect(reply.body, path).not.toContain("# HELP");
    }
  });
});

describe("SSE qua Traefik", () => {
  it("stream của một khoá SDK thật sống quá 60 giây và nhận nhịp tim", async () => {
    const created = await api<{
      project: { id: string };
      environments: { id: string }[];
    }>(target, session, "POST", "/projects", {
      name: `e2e-vm-${String(Date.now())}`,
      creationMode: "CREATE_NEW",
      languageRuntime: "node",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const env = created.body.environments[0];
    if (env === undefined) throw new Error("project mới không có environment");
    const key = await api<{ secretKey: string }>(
      target,
      session,
      "POST",
      `/projects/${created.body.project.id}/environments/${env.id}/keys`,
      { keyType: "SERVER", label: "e2e-vm" },
    );
    expect(key.status, JSON.stringify(key.body)).toBe(201);

    const stream = openStream(target, key.body.secretKey);
    try {
      expect(await stream.status).toBe(200);
      await eventually(
        () => (stream.events.length > 0 ? true : undefined),
        15_000,
        "event snapshot đầu tiên",
        200,
      );
      const before = stream.chunks();
      // Hạn chờ mặc định hay gặp của proxy là 60 giây; nhịp tim của Service 2 là 20 giây
      await new Promise((r) => setTimeout(r, 75_000));
      expect(stream.ended()).toBe(false);
      expect(stream.chunks()).toBeGreaterThan(before);
    } finally {
      stream.close();
    }
  }, 120_000);
});

describe("sao lưu → khôi phục (QĐ-7)", () => {
  it("CronJob đẩy bản dump ra ngoài máy; khôi phục đưa database về đúng lúc sao lưu", async () => {
    const sink = await startSink(target.settings.UDP_BACKUP_UPLOAD_URL);
    const dir = mkdtempSync(join(tmpdir(), "udp-restore-"));
    try {
      const job = `udp-backup-e2e-${String(Date.now())}`;
      kube.run([
        "create",
        "job",
        job,
        "--from=cronjob/udp-backup",
        "-n",
        NAMESPACE,
      ]);
      kube.run([
        "wait",
        "--for=condition=complete",
        `job/${job}`,
        "-n",
        NAMESPACE,
        "--timeout=300s",
      ]);
      const [[name, dump] = ["", Buffer.alloc(0)]] = [...sink.received];
      expect(name).toMatch(/^\/udp-[A-Z][a-z]{2}\.dump$/);
      // Chữ ký của định dạng custom của pg_dump
      expect(dump.subarray(0, 5).toString("latin1")).toBe("PGDMP");

      // Người dùng đăng ký SAU bản sao lưu phải biến mất sau khi khôi phục
      const later = newUser("after-backup");
      await register(target, later);
      expect((await login(target, later)).status).toBe(200);

      const file = join(dir, "udp.dump");
      writeFileSync(file, dump);
      const restore = spawnSync(
        "pnpm",
        ["exec", "tsx", "src/vm-restore.ts", file],
        {
          cwd: DEPLOY,
          stdio: "inherit",
        },
      );
      expect(restore.status).toBe(0);

      expect((await login(target, owner)).status).toBe(200);
      expect((await login(target, later)).status).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await sink.close();
    }
  }, 600_000);
});
