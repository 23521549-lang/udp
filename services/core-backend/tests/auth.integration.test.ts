import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/core/db.js";
import { createApp } from "../src/app.js";

/**
 * Auth qua HTTP thật.
 *
 * Trước bộ này, module auth — phần DUY NHẤT đang phục vụ request — có 0 test,
 * trong khi `packages/db` có gần 200 test canh trigger và GRANT. Mọi lập luận
 * bảo mật của nó (thông báo lỗi hợp nhất, `PUBLIC_FIELDS` chặn `passwordHash`,
 * CSRF không miễn cho `/logout`) chỉ tồn tại dưới dạng chú thích.
 *
 * `createApp()` được tách riêng với lý do tường minh "để test tích hợp dựng
 * được app trong bộ nhớ" — đây là lần đầu lý do đó được dùng tới.
 */

const app = createApp();
const API = "/api/v1";

/** Mỗi lần chạy một email riêng, để test không phụ thuộc trạng thái để lại */
const freshEmail = () => `test-${randomUUID()}@udp.local`;
const PASSWORD = "dev-password-12345";

const created: string[] = [];

async function registerUser(): Promise<{
  email: string;
  cookies: string[];
  csrfToken: string;
}> {
  const email = freshEmail();
  const res = await request(app)
    .post(`${API}/auth/register`)
    .send({ email, password: PASSWORD, name: "Test User" })
    .expect(201);
  created.push(email);
  return {
    email,
    cookies: setCookies(res),
    csrfToken: res.body.csrfToken as string,
  };
}

/** supertest khai `get()` trả string | string[]; chuẩn hoá về mảng một lần */
const setCookies = (res: request.Response): string[] => {
  const raw: unknown = res.get("set-cookie");
  return Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
};

/** Lấy giá trị một cookie từ header Set-Cookie */
const cookieValue = (cookies: string[], name: string): string | undefined =>
  cookies
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.split("=")
    .slice(1)
    .join("=");

beforeAll(async () => {
  // Test này ghi thật; dọn sạch ở afterAll thay vì rollback, vì request đi qua
  // HTTP nên không chia sẻ transaction được với test.
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.user.deleteMany({ where: { email: { in: created } } });
  }
  await prisma.$disconnect();
});

describe("đăng ký và đăng nhập", () => {
  it("register trả 201 và KHÔNG bao giờ lộ passwordHash", async () => {
    const email = freshEmail();
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ email, password: PASSWORD, name: "Test User" })
      .expect(201);
    created.push(email);

    // `PUBLIC_FIELDS` tự nhận là "hàng rào duy nhất" chống lộ hash mật khẩu, và
    // trước test này không ai canh nó.
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain("$2a$");
    expect(res.body.user.email).toBe(email);
  });

  it("email trùng trả 409, KHÔNG phải 500", async () => {
    const { email } = await registerUser();
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ email, password: PASSWORD, name: "Ai đó" })
      .expect(409);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });

  it("mật khẩu dài quá 72 BYTE bị từ chối, dù dưới 72 ký tự", async () => {
    // 72 ký tự tiếng Việt = 114 byte; bcrypt chỉ thấy 46 ký tự đầu, nên hai mật
    // khẩu khác nhau từ ký tự 47 sẽ đăng nhập được cho nhau nếu không chặn.
    const viet = "Mậtkhẩu".repeat(20).slice(0, 72);
    expect(Buffer.byteLength(viet, "utf8")).toBeGreaterThan(72);
    await request(app)
      .post(`${API}/auth/register`)
      .send({ email: freshEmail(), password: viet, name: "X" })
      .expect(400);
  });

  it("login sai mật khẩu và login email lạ trả CÙNG một thông báo", async () => {
    const { email } = await registerUser();

    const wrongPassword = await request(app)
      .post(`${API}/auth/login`)
      .send({ email, password: "sai-mat-khau-hoan-toan" })
      .expect(401);

    const unknownEmail = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: freshEmail(), password: PASSWORD })
      .expect(401);

    // Khác một chữ là đủ để liệt kê tài khoản đã đăng ký.
    expect(wrongPassword.body.detail).toBe(unknownEmail.body.detail);
  });
});

describe("xoay vòng refresh token và phát hiện tái sử dụng", () => {
  it("refresh cấp token MỚI và thu hồi token cũ", async () => {
    const { cookies, csrfToken } = await registerUser();
    const first = cookieValue(cookies, "udp_refresh");
    expect(first).toBeDefined();

    const res = await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", cookies)
      .set("X-CSRF-Token", csrfToken)
      .expect(200);

    const second = cookieValue(setCookies(res), "udp_refresh");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("dùng LẠI token cũ bị từ chối VÀ thu hồi cả họ phiên", async () => {
    // Đây là tính chất thật sự bắt được trộm token: nếu token cũ vẫn dùng được,
    // một bản sao bị đánh cắp là vô hình với hệ thống.
    const { cookies, csrfToken } = await registerUser();

    const rotated = await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", cookies)
      .set("X-CSRF-Token", csrfToken)
      .expect(200);
    const newCookies = setCookies(rotated);

    // Trình lại token CŨ
    await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", cookies)
      .set("X-CSRF-Token", csrfToken)
      .expect(401);

    // và token MỚI cũng phải chết theo — hai bản sao đang tồn tại, ta không
    // biết bản nào của người dùng thật.
    await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", newCookies)
      .set("X-CSRF-Token", cookieValue(newCookies, "udp_csrf") ?? csrfToken)
      .expect(401);
  });

  it("logout thu hồi phiên ở SERVER, không chỉ xoá cookie", async () => {
    const { cookies, csrfToken } = await registerUser();

    await request(app)
      .post(`${API}/auth/logout`)
      .set("Cookie", cookies)
      .set("X-CSRF-Token", csrfToken)
      .expect(204);

    // Cookie cũ vẫn nằm trong tay kẻ đã sao chép — nhưng phiên đã chết.
    await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", cookies)
      .set("X-CSRF-Token", csrfToken)
      .expect(401);
  });
});

describe("CSRF", () => {
  it("/logout bị chặn khi thiếu header CSRF", async () => {
    const { cookies } = await registerUser();
    await request(app)
      .post(`${API}/auth/logout`)
      .set("Cookie", cookies)
      .expect(403);
  });

  it("/auth/refresh KHÔNG còn được miễn CSRF", async () => {
    // Lập luận miễn trừ cũ ("chưa có phiên để lạm dụng") sai với chính endpoint
    // này: nó chạy được LÀ NHỜ cookie phiên đã tồn tại.
    const { cookies } = await registerUser();
    await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", cookies)
      .expect(403);
  });

  it("cookie tossing bị chặn: cookie VÀ header cùng một giá trị tự chọn", async () => {
    // Đây là ca mà double-submit thuần KHÔNG chặn được, và là lý do §1.2 đòi
    // token phải là HMAC của phiên. Kẻ tấn công từ một subdomain ghi
    // `udp_csrf=X` cho domain cha rồi gửi header `X` — hai giá trị khớp nhau
    // hoàn hảo. Chỉ phép kiểm HMAC mới biết X không phải do server cấp.
    const { cookies } = await registerUser();
    const forged = "gia-mao-nhung-khop-nhau";
    const tossed = cookies.filter((c) => !c.startsWith("udp_csrf="));

    await request(app)
      .post(`${API}/auth/logout`)
      .set("Cookie", [...tossed, `udp_csrf=${forged}`])
      .set("X-CSRF-Token", forged)
      .expect(403);
  });

  it("access cookie hết hạn thì VẪN refresh được", async () => {
    // Hồi quy thật, đã đo: khi CSRF token buộc vào ACCESS token, cookie đó chết
    // sau 15 phút và `/auth/refresh` — endpoint duy nhất cứu được phiên — trả
    // 403 mãi mãi. Người dùng bị đăng xuất sau mười lăm phút dù refresh token
    // còn 7 ngày. Buộc vào `family_id` thay vì access token thì một giá trị
    // CSRF dùng được suốt vòng đời phiên.
    const { cookies, csrfToken } = await registerUser();
    const expired = cookies.filter((c) => !c.startsWith("udp_access="));

    await request(app)
      .post(`${API}/auth/refresh`)
      .set("Cookie", expired)
      .set("X-CSRF-Token", csrfToken)
      .expect(200);
  });

  it("header CSRF sai giá trị cũng bị chặn", async () => {
    const { cookies } = await registerUser();
    await request(app)
      .post(`${API}/auth/logout`)
      .set("Cookie", cookies)
      .set("X-CSRF-Token", "gia-mao")
      .expect(403);
  });
});

describe("lỗi trả về đúng hình dạng RFC 9457", () => {
  it("route không tồn tại trả problem+json kèm traceId và instance", async () => {
    const res = await request(app).get(`${API}/khong-ton-tai`).expect(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.body.instance).toBe(`${API}/khong-ton-tai`);
    expect(res.body).toHaveProperty("traceId");
  });

  it("JSON hỏng trả 400 chứ không 500", async () => {
    const res = await request(app)
      .post(`${API}/auth/login`)
      .set("Content-Type", "application/json")
      .send("{khong-phai-json")
      .expect(400);
    expect(res.body.title).toBe("Malformed JSON body");
  });

  it("body sai schema trả 400 kèm lỗi từng trường", async () => {
    const res = await request(app)
      .post(`${API}/auth/register`)
      .send({ email: "khong-phai-email", password: "ngan", name: "" })
      .expect(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors[0]).toHaveProperty("field");
  });

  it("chưa đăng nhập gọi /me trả 401", async () => {
    await request(app).get(`${API}/auth/me`).expect(401);
  });
});
