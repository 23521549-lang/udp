import { randomUUID } from "node:crypto";
import { env, LEGAL } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { defaultAppDeps } from "../src/core/app-deps.js";
import { prisma } from "../src/core/db.js";
import type { Mailer, OutgoingMail } from "../src/core/mail/mailer.js";
import { safeReturnPath } from "../src/modules/auth/auth.controller.js";
import type {
  GithubOAuth,
  GithubProfile,
} from "../src/modules/auth/github.client.js";
import { GithubOAuthError } from "../src/modules/auth/github.client.js";
import { noExternalAuth } from "./helpers/inert-deps.js";

/**
 * [v4.12, Plan #60 QĐ-6, QĐ-7, QĐ-8] Đồng ý Điều khoản khi đăng ký, quên mật khẩu, đăng nhập GitHub — qua HTTP thật và
 * database thật; thư và GitHub là bản giả tiêm qua `AppDeps.auth`, không gửi thư hay gọi GitHub thật.
 */

const API = "/api/v1";
const PASSWORD = "dev-password-12345";
const created: string[] = [];
const freshEmail = () => `recovery-${randomUUID()}@udp.local`;

const sent: OutgoingMail[] = [];
const mailer: Mailer = {
  send: (mail) => {
    sent.push(mail);
    return Promise.resolve();
  },
};

/** GitHub giả: mỗi `code` là một hồ sơ; `code` lạ ⇒ GitHub từ chối */
const profiles = new Map<string, GithubProfile>();
const github: GithubOAuth = {
  authorizeUrl: (state, redirectUri) =>
    `https://github.example/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchange: (code) => {
    const profile = profiles.get(code);
    return profile === undefined
      ? Promise.reject(new GithubOAuthError("bad_verification_code"))
      : Promise.resolve(profile);
  },
};

const app = createApp({ ...defaultAppDeps(), auth: { mailer, github } });
const plainApp = createApp({ ...defaultAppDeps(), auth: noExternalAuth });

/** Owner: `audit_logs` là append-only với `udp_s1` — dọn dữ liệu test cần quyền owner như mọi test khác */
const owner = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_auth_recovery_test",
});

afterAll(async () => {
  await owner.auditLog.deleteMany({
    where: { action: "auth.password.reset", targetType: "User" },
  });
  await prisma.user.deleteMany({ where: { email: { in: created } } });
  await owner.$disconnect();
});

async function register(email = freshEmail()): Promise<string> {
  await request(app)
    .post(`${API}/auth/register`)
    .send({ email, password: PASSWORD, name: "Người thử", acceptTerms: true })
    .expect(201);
  created.push(email);
  return email;
}

const login = (email: string, password: string) =>
  request(app).post(`${API}/auth/login`).send({ email, password });

/** Đợi thư gửi nền (không chờ trong route) tới hộp giả */
async function mailTo(email: string): Promise<OutgoingMail> {
  for (let i = 0; i < 50; i++) {
    const hit = sent.find((m) => m.to === email);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`không có thư tới ${email}`);
}

const tokenOf = (mail: OutgoingMail): string => {
  const m = /\/reset-password#([A-Za-z0-9_-]+)/.exec(mail.text);
  if (m?.[1] === undefined) throw new Error("thư không có đường dẫn");
  return m[1];
};

describe("đồng ý Điều khoản khi đăng ký (QĐ-6)", () => {
  it("thiếu acceptTerms ⇒ 400 tại đúng trường; có ⇒ ghi phiên bản hiện hành và thời điểm", async () => {
    const email = freshEmail();
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ email, password: PASSWORD, name: "X" })
      .expect(400);
    expect(
      (res.body.errors as { field: string }[]).map((e) => e.field),
    ).toContain("acceptTerms");

    await register(email);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { termsVersion: true, termsAcceptedAt: true },
    });
    expect(user.termsVersion).toBe(LEGAL.termsVersion);
    expect(user.termsAcceptedAt).toBeInstanceOf(Date);
  });
});

describe("GET /auth/options", () => {
  it("nói đúng những gì triển khai bật", async () => {
    expect(
      (await request(app).get(`${API}/auth/options`).expect(200)).body,
    ).toEqual({ passwordReset: true, github: true });
    expect(
      (await request(plainApp).get(`${API}/auth/options`).expect(200)).body,
    ).toEqual({ passwordReset: false, github: false });
  });
});

describe("quên mật khẩu (QĐ-7)", () => {
  it("email lạ và email có tài khoản trả CÙNG 202; chỉ email có tài khoản nhận thư", async () => {
    const stranger = freshEmail();
    const a = await request(app)
      .post(`${API}/auth/password/forgot`)
      .send({ email: stranger })
      .expect(202);
    const email = await register();
    const b = await request(app)
      .post(`${API}/auth/password/forgot`)
      .send({ email })
      .expect(202);
    expect(a.body).toEqual(b.body);
    const mail = await mailTo(email);
    expect(mail.subject).toContain("Đặt lại mật khẩu");
    expect(mail.text).toContain("reset the password");
    expect(sent.some((m) => m.to === stranger)).toBe(false);
  });

  it("đặt lại: mật khẩu mới dùng được, cũ thì không; token dùng một lần; phiên cũ bị thu hồi; có nhật ký", async () => {
    const email = await register();
    const session = await login(email, PASSWORD).expect(200);
    const raw: unknown = session.get("set-cookie");
    const cookies = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
    const csrf = session.body.csrfToken as string;

    await request(app)
      .post(`${API}/auth/password/forgot`)
      .send({ email })
      .expect(202);
    const token = tokenOf(await mailTo(email));
    const next = "mat-khau-moi-12345";
    await request(app)
      .post(`${API}/auth/password/reset`)
      .send({ token, password: next })
      .expect(204);

    await login(email, PASSWORD).expect(401);
    await login(email, next).expect(200);
    // Dùng lại token ⇒ 404 cùng một câu
    await request(app)
      .post(`${API}/auth/password/reset`)
      .send({ token, password: "lan-hai-12345" })
      .expect(404);
    // Phiên mở trước khi đặt lại không refresh được nữa
    await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", cookies)
      .set("X-CSRF-Token", csrf)
      .expect(401);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    expect(
      await prisma.auditLog.count({
        where: { action: "auth.password.reset", targetId: user.id },
      }),
    ).toBe(1);
  });

  it("xin thư mới thì thư cũ hết dùng được; token hết hạn ⇒ 404", async () => {
    const email = await register();
    const ask = () =>
      request(app)
        .post(`${API}/auth/password/forgot`)
        .send({ email })
        .expect(202);
    await ask();
    const first = tokenOf(await mailTo(email));
    sent.length = 0;
    await ask();
    const second = tokenOf(await mailTo(email));
    expect(second).not.toBe(first);
    await request(app)
      .post(`${API}/auth/password/reset`)
      .send({ token: first, password: "khong-duoc-12345" })
      .expect(404);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await request(app)
      .post(`${API}/auth/password/reset`)
      .send({ token: second, password: "het-han-12345" })
      .expect(404);
  });

  it("triển khai chưa cấu hình thư ⇒ 404, không giả vờ đã gửi", async () => {
    await request(plainApp)
      .post(`${API}/auth/password/forgot`)
      .send({ email: freshEmail() })
      .expect(404);
  });
});

describe("đăng nhập GitHub (QĐ-8)", () => {
  /** Một chuyến đi trọn: bắt đầu (cookie state) rồi quay về với `code` */
  async function roundTrip(
    query: string,
    code: string,
    tamper?: (state: string) => string,
  ): Promise<request.Response> {
    const agent = request.agent(app);
    const start = await agent
      .get(`${API}/auth/github/start${query}`)
      .expect(302);
    const location = new URL(start.headers.location as string);
    const state = location.searchParams.get("state") ?? "";
    expect(location.searchParams.get("redirect_uri")).toMatch(
      /\/api\/v1\/auth\/github\/callback$/,
    );
    return agent
      .get(`${API}/auth/github/callback`)
      .query({ code, state: tamper === undefined ? state : tamper(state) })
      .expect(302);
  }

  const profile = (email: string | null): GithubProfile => ({
    id: String(Math.floor(Math.random() * 1e12)),
    login: `octo-${randomUUID().slice(0, 6)}`,
    name: "Octo Cat",
    email,
  });

  it("đăng ký bằng GitHub (đã đồng ý): tạo tài khoản không mật khẩu kèm liên kết; lần sau đăng nhập đúng người", async () => {
    const email = freshEmail();
    created.push(email);
    const p = profile(email);
    profiles.set("c-new", p);
    const res = await roundTrip(
      "?intent=register&acceptTerms=1&redirectTo=%2Fapp%2Fprojects",
      "c-new",
    );
    expect(res.headers.location).toMatch(/\/app\/projects$/);
    expect(String(res.get("set-cookie"))).toContain("udp_access=");
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: {
        id: true,
        passwordHash: true,
        termsVersion: true,
        identities: { select: { provider: true, providerUserId: true } },
      },
    });
    expect(user.passwordHash).toBeNull();
    expect(user.termsVersion).toBe(LEGAL.termsVersion);
    expect(user.identities).toEqual([
      { provider: "GITHUB", providerUserId: p.id },
    ]);
    // Mật khẩu không có thì đăng nhập mật khẩu là "sai thông tin", không lỗi máy chủ
    await login(email, "bat-ky-12345").expect(401);

    profiles.set("c-again", { ...p, login: "doi-ten", email: "khac@x.vn" });
    const again = await roundTrip("", "c-again");
    expect(again.headers.location).toMatch(/\/app\/home$/);
    expect(await prisma.user.count({ where: { email: "khac@x.vn" } })).toBe(0);
  });

  it("email đã có tài khoản mật khẩu ⇒ KHÔNG tự liên kết (chặn chiếm tài khoản đặt trước)", async () => {
    const email = await register();
    profiles.set("c-taken", profile(email));
    const res = await roundTrip("?intent=register&acceptTerms=1", "c-taken");
    expect(res.headers.location).toMatch(/\/login\?oauth=email_taken$/);
    expect(
      await prisma.userIdentity.count({
        where: { user: { email } },
      }),
    ).toBe(0);
  });

  it("chưa có tài khoản mà đến từ trang đăng nhập (chưa đồng ý) ⇒ về trang đăng ký, không tạo gì", async () => {
    const email = freshEmail();
    profiles.set("c-login", profile(email));
    const res = await roundTrip("?intent=login", "c-login");
    expect(res.headers.location).toMatch(/\/register\?oauth=no_account$/);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("state sai ⇒ thất bại; người dùng từ chối ⇒ denied; GitHub không có email đã xác minh ⇒ no_email", async () => {
    profiles.set("c-state", profile(freshEmail()));
    const bad = await roundTrip(
      "?intent=register&acceptTerms=1",
      "c-state",
      (s) => `${s}x`,
    );
    expect(bad.headers.location).toMatch(/\/login\?oauth=failed$/);

    const denied = await request(app)
      .get(`${API}/auth/github/callback`)
      .query({ error: "access_denied", state: "x" })
      .expect(302);
    expect(denied.headers.location).toMatch(/\/login\?oauth=denied$/);

    profiles.set("c-noemail", profile(null));
    const noEmail = await roundTrip(
      "?intent=register&acceptTerms=1",
      "c-noemail",
    );
    expect(noEmail.headers.location).toMatch(/\/login\?oauth=no_email$/);
  });

  it("chưa cấu hình GitHub ⇒ 404", async () => {
    await request(plainApp).get(`${API}/auth/github/start`).expect(404);
  });

  it("đích quay về chỉ là đường nội bộ của hai khung (chặn open redirect)", () => {
    expect(safeReturnPath("/app/projects?x=1")).toBe("/app/projects?x=1");
    expect(safeReturnPath("/admin/jobs")).toBe("/admin/jobs");
    expect(safeReturnPath("/invite#t")).toBe("/invite#t");
    expect(safeReturnPath("https://evil.example/app")).toBe("/app/home");
    expect(safeReturnPath("//evil.example/app")).toBe("/app/home");
    expect(safeReturnPath("/apple")).toBe("/app/home");
    expect(safeReturnPath(null)).toBe("/app/home");
  });
});
