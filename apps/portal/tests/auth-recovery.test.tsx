import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { LEGAL_VERSION } from "../src/features/legal/LegalPage";
import { useLocaleStore } from "../src/i18n";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * [Plan #60 QĐ-6, QĐ-7, QĐ-8] Đồng ý Điều khoản khi đăng ký, quên mật khẩu, đăng nhập GitHub, hai trang pháp lý —
 * qua router thật và msw (golden của Service 1).
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Triển khai đã cấu hình thư và OAuth App (mẫu golden mặc định là chưa bật gì) */
const enableAll = () =>
  server.use(
    http.get(`${API}/auth/options`, () =>
      HttpResponse.json({ passwordReset: true, github: true }),
    ),
  );

describe("đăng ký: ô đồng ý Điều khoản (QĐ-6)", () => {
  it("chưa tích ⇒ lỗi dưới ô, focus vào ô, KHÔNG gửi; tích rồi ⇒ gửi kèm acceptTerms", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${API}/auth/register`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(golden("POST /auth/register"), {
          status: 201,
        });
      }),
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    const { router } = renderApp("/register", { user: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Tên"), "Lan");
    await user.type(screen.getByLabelText("Email"), "lan@congty.vn");
    await user.type(screen.getByLabelText("Mật khẩu"), "mat-khau-dai");
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    const box = screen.getByRole("checkbox", { name: /Tôi đồng ý/ });
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveAccessibleDescription("Tích ô này để tạo tài khoản.");
    expect(bodies).toEqual([]);

    // Hai văn bản mở ở thẻ mới: form không mất
    expect(
      screen.getByRole("link", { name: "Điều khoản sử dụng" }),
    ).toHaveAttribute("target", "_blank");
    await user.click(box);
    expect(box).toHaveAttribute("aria-invalid", "false");
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/app/home"),
    );
    expect(bodies).toEqual([
      {
        name: "Lan",
        email: "lan@congty.vn",
        password: "mat-khau-dai",
        acceptTerms: true,
      },
    ]);
  });

  it("nút GitHub ở trang đăng ký cũng cần ô đồng ý; tích rồi thì đường dẫn mang acceptTerms", async () => {
    enableAll();
    renderApp("/register?redirectTo=%2Fapp%2Fteams", { user: null });
    const user = userEvent.setup();
    const github = await screen.findByRole("link", {
      name: "Tiếp tục với GitHub",
    });
    expect(github.getAttribute("href")).toBe(
      "/api/v1/auth/github/start?intent=register&acceptTerms=1&redirectTo=%2Fapp%2Fteams",
    );
    await user.click(github);
    const box = screen.getByRole("checkbox", { name: /Tôi đồng ý/ });
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAccessibleDescription("Tích ô này để tạo tài khoản.");
  });

  it("GitHub trả về 'chưa có tài khoản' ⇒ trang đăng ký nói rõ việc tiếp theo", async () => {
    renderApp("/register?oauth=no_account", { user: null });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chưa có tài khoản UDP gắn với GitHub này",
    );
  });
});

describe("đăng nhập: Quên mật khẩu và GitHub theo cấu hình (QĐ-7, QĐ-8)", () => {
  it("triển khai bật cả hai ⇒ có link Quên mật khẩu cạnh nhãn và nút GitHub", async () => {
    enableAll();
    renderApp("/login", { user: null });
    expect(
      await screen.findByRole("link", { name: "Quên mật khẩu?" }),
    ).toHaveAttribute("href", "/forgot-password");
    expect(
      screen.getByRole("link", { name: "Tiếp tục với GitHub" }),
    ).toHaveAttribute("href", "/api/v1/auth/github/start?intent=login");
  });

  it("triển khai chưa cấu hình (mẫu golden) ⇒ không có nút nào dẫn vào ngõ cụt", async () => {
    renderApp("/login", { user: null });
    await screen.findByRole("button", { name: "Đăng nhập" });
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Quên mật khẩu?" })).toBeNull(),
    );
    expect(
      screen.queryByRole("link", { name: "Tiếp tục với GitHub" }),
    ).toBeNull();
  });

  it("mã lỗi GitHub trên URL ⇒ câu theo ngôn ngữ; vừa đổi mật khẩu ⇒ câu xác nhận", async () => {
    act(() => useLocaleStore.getState().setLocale("en"));
    renderApp("/login?oauth=email_taken", { user: null });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already has a UDP account",
    );
  });

  it("đổi mật khẩu xong ⇒ trang đăng nhập xác nhận", async () => {
    renderApp("/login?reset=done", { user: null });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Đã đổi mật khẩu",
    );
  });
});

describe("quên và đặt lại mật khẩu (QĐ-7)", () => {
  it("xin thư: kết quả như nhau, nhắc xem thư rác", async () => {
    let asked: unknown;
    server.use(
      http.post(`${API}/auth/password/forgot`, async ({ request }) => {
        asked = await request.json();
        return HttpResponse.json(golden("POST /auth/password/forgot"), {
          status: 202,
        });
      }),
    );
    renderApp("/forgot-password", { user: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), " lan@congty.vn ");
    await user.click(screen.getByRole("button", { name: "Gửi đường dẫn" }));
    expect(
      await screen.findByRole("heading", { name: "Kiểm tra hộp thư" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("thư rác");
    expect(asked).toEqual({ email: "lan@congty.vn" });
  });

  it("đặt lại: mã đọc từ fragment rồi xoá khỏi thanh địa chỉ; xong thì về đăng nhập", async () => {
    let sent: unknown;
    server.use(
      http.post(`${API}/auth/password/reset`, async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { router } = renderApp("/reset-password#ma-dat-lai-dai-du-20-ky-tu", {
      user: null,
    });
    const user = userEvent.setup();
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    await user.type(
      await screen.findByLabelText("Mật khẩu mới"),
      "mat-khau-moi-12",
    );
    await user.click(screen.getByRole("button", { name: "Đổi mật khẩu" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toEqual({ reset: "done" });
    expect(sent).toEqual({
      token: "ma-dat-lai-dai-du-20-ky-tu",
      password: "mat-khau-moi-12",
    });
  });

  it("mã không còn dùng được ⇒ nói rõ và đưa đường xin thư mới", async () => {
    server.use(
      http.post(`${API}/auth/password/reset`, () =>
        HttpResponse.json(
          {
            type: "about:blank",
            title: "Not found",
            status: 404,
            detail: "Đường dẫn đặt lại mật khẩu không còn dùng được.",
            traceId: "t",
          },
          {
            status: 404,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      ),
    );
    renderApp("/reset-password#ma-cu-da-dung-roi-hon-20", { user: null });
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("Mật khẩu mới"),
      "mat-khau-moi-12",
    );
    await user.click(screen.getByRole("button", { name: "Đổi mật khẩu" }));
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByRole("link", { name: "Xin thư mới" }),
    ).toHaveAttribute("href", "/forgot-password");
  });

  it("mở trang không có mã ⇒ không hiện form, chỉ đường xin thư mới", async () => {
    renderApp("/reset-password", { user: null });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "thiếu mã đặt lại",
    );
    expect(screen.queryByLabelText("Mật khẩu mới")).toBeNull();
  });
});

describe("hai trang pháp lý (QĐ-6)", () => {
  it("công khai, có mục lục và ngày phiên bản; phiên bản khớp LEGAL.termsVersion mà Service 1 ghi", async () => {
    const src = readFileSync(
      join(here, "..", "..", "..", "packages", "config", "src", "constants.ts"),
      "utf8",
    );
    expect(src).toMatch(
      new RegExp(`termsVersion: "${LEGAL_VERSION.replace(/-/g, "\\-")}"`),
    );

    renderApp("/terms", { user: null });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Điều khoản sử dụng",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/phiên bản 2026-10-01/)).toBeInTheDocument();
    const toc = screen.getByRole("navigation", { name: "Mục lục" });
    expect(within(toc).getAllByRole("link").length).toBeGreaterThan(5);
    expect(
      screen.getByRole("link", { name: "Chính sách quyền riêng tư" }),
    ).toHaveAttribute("href", "/privacy");
  });

  it("Quyền riêng tư nói rõ cookie và bên thứ ba thật (kể cả Google Fonts)", async () => {
    renderApp("/privacy", { user: null });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Chính sách quyền riêng tư",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/udp_access, udp_refresh, udp_csrf/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Google Fonts/)).toBeInTheDocument();
  });
});
