import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setThemePreference,
  themePreference,
  watchSystemTheme,
} from "../src/app/theme";
import {
  count,
  defineMessages,
  initialLocale,
  messagesOf,
  useLocaleStore,
} from "../src/i18n";
import {
  compactNumber,
  formatDuration,
  formatNumber,
  formatUsd,
  relativeTime,
} from "../src/lib/format";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp, USER } from "./render";

/**
 * [Plan #54] Hai ngôn ngữ và ba lựa chọn giao diện: tầng i18n (kiểu, chọn ngôn ngữ, định dạng), bộ chọn ở menu
 * tài khoản và trang đăng nhập, và "Theo hệ thống" theo hệ điều hành lúc đang mở trang.
 */

const setLocale = (l: "vi" | "en") =>
  act(() => useLocaleStore.getState().setLocale(l));

describe("tầng i18n", () => {
  it("bản en thiếu khoá, thừa khoá hay sai tham số là lỗi biên dịch", () => {
    // @ts-expect-error TSX-07: bản en thiếu `b` — thiếu một câu là lỗi biên dịch
    defineMessages({ vi: { a: "x", b: "y" }, en: { a: "x" } });
    // @ts-expect-error TSX-08: bản en thừa `c` — khoá lạ không lọt
    defineMessages({ vi: { a: "x" }, en: { a: "x", c: "z" } });
    defineMessages({
      vi: { f: (n: number) => String(n) },
      // @ts-expect-error TSX-09: tham số của chữ có tham số sai kiểu
      en: { f: (n: string) => n },
    });
    const ok = defineMessages({ vi: { a: "x" }, en: { a: "y" } });
    expect(messagesOf(ok).a).toBe("x");
  });

  it("chọn ngôn ngữ: lựa chọn tay › trình duyệt › tiếng Việt", () => {
    const languages = vi.spyOn(navigator, "languages", "get");
    languages.mockReturnValue(["fr-FR", "en-GB"]);
    expect(initialLocale()).toBe("en");
    languages.mockReturnValue(["fr-FR", "de-DE"]);
    expect(initialLocale()).toBe("vi");
    localStorage.setItem("udp_locale", "en");
    languages.mockReturnValue(["vi-VN"]);
    expect(initialLocale()).toBe("en");
    languages.mockRestore();
  });

  it("đổi ngôn ngữ: lưu lại, đặt <html lang>", () => {
    useLocaleStore.getState().setLocale("en");
    expect(localStorage.getItem("udp_locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("số, tiền, thời lượng, '… trước' theo ngôn ngữ; số nhiều tiếng Anh", () => {
    expect(formatNumber(1234.5)).toBe("1.234,5");
    expect(formatDuration(3_900)).toBe("1 giờ 5 phút");
    useLocaleStore.setState({ locale: "en" });
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatDuration(3_900)).toBe("1h 5m");
    expect(formatDuration(0)).toBe("0s");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(compactNumber(12_300)).toBe("12.3K");
    expect(
      relativeTime(new Date(Date.now() - 2 * 3_600_000).toISOString()),
    ).toBe("2 hours ago");
    expect(count(1, "project", "projects")).toBe("1 project");
    expect(count(1200, "project", "projects")).toBe("1,200 projects");
  });
});

describe("bộ chọn ngôn ngữ", () => {
  it("menu tài khoản: đổi sang English là cả khung đổi ngay, không tải lại", async () => {
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    renderApp("/app/home");
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 1 });
    const side = screen.getByRole("complementary", {
      name: "Điều hướng chính",
    });
    await user.click(within(side).getByRole("button", { name: /Dev Tester/ }));
    const language = screen.getByRole("group", { name: "Ngôn ngữ" });
    await user.click(within(language).getByRole("button", { name: "English" }));

    expect(
      screen.getByRole("complementary", { name: "Main navigation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Language" })).getByRole(
        "button",
        { name: "English" },
      ),
    ).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.lang).toBe("en");
  });

  it("trang đăng nhập: người chưa đăng nhập cũng đổi được", async () => {
    renderApp("/login", { user: null });
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: "Đăng nhập" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "English" }));
    expect(
      screen.getByRole("heading", { name: "Sign in" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("câu lỗi theo ngôn ngữ đang chọn", async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json(
          { type: "about:blank", title: "x", status: 429, traceId: "t" },
          { status: 429 },
        ),
      ),
    );
    setLocale("en");
    renderApp("/login", { user: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "a@b.vn");
    await user.type(screen.getByLabelText("Password"), "wrong-123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many requests. Wait a moment and try again.",
    );
  });
});

/** `matchMedia` giả: jsdom không có, và test cần đổi "hệ điều hành" lúc đang chạy */
function fakeSystemTheme(initialDark: boolean) {
  let dark = initialDark;
  const handlers = new Set<() => void>();
  const mql = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, h: () => void) => handlers.add(h),
    removeEventListener: (_: string, h: () => void) => handlers.delete(h),
  };
  vi.stubGlobal("matchMedia", () => mql);
  return {
    set(next: boolean) {
      dark = next;
      for (const h of handlers) h();
    },
  };
}

describe("giao diện ba lựa chọn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Theo hệ thống theo hệ điều hành lúc đang mở; chọn tay thì thắng", () => {
    const os = fakeSystemTheme(false);
    watchSystemTheme();
    setThemePreference("system");
    expect(themePreference()).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    os.set(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    setThemePreference("light");
    expect(localStorage.getItem("udp_theme")).toBe("light");
    os.set(false);
    os.set(true);
    expect(document.documentElement.dataset.theme).toBe("light");

    setThemePreference("system");
    expect(localStorage.getItem("udp_theme")).toBeNull();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("menu tài khoản: ba nút, nút đang chọn được đánh dấu", async () => {
    fakeSystemTheme(false);
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    renderApp("/app/home");
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: /Dev Tester/ }));
    const appearance = screen.getByRole("group", { name: "Giao diện" });
    expect(
      within(appearance).getByRole("button", { name: "Theo hệ thống" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(within(appearance).getByRole("button", { name: "Tối" }));
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(
      within(appearance).getByRole("button", { name: "Tối" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

/**
 * [Plan #54 AC-2] Vài màn chính bằng tiếng Anh, đi qua CHÍNH đường người dùng đi: tiêu đề, điều hướng, nhãn, câu
 * có tham số, số theo quy ước en-US. Lượt tiếng Anh của cổng `portal-demo` phủ mọi màn trên trình duyệt thật.
 */
describe("màn chính bằng tiếng Anh", () => {
  it("trang chủ: lời chào, việc cần xử lý, câu có tham số", async () => {
    setLocale("en");
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    renderApp("/app/home");
    expect(
      // [Plan #58 UX-24] Tiếng Anh gọi bằng tên riêng (chữ ĐẦU): "Dev Tester" ⇒ "Hi Dev"
      await screen.findByRole("heading", { level: 1, name: "Hi Dev" }),
    ).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Needs attention" });
    expect(
      within(list).getByText("Deployment checkout-api awaiting approval"),
    ).toBeInTheDocument();
    expect(
      within(list).getByText("Project expires within 48 hours"),
    ).toBeInTheDocument();
  });

  it("danh sách flag: tiêu đề, cột, nút theo tiếng Anh", async () => {
    setLocale("en");
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    renderApp(`/app/projects/${detail.project.id}/flags`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Flags" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create flag/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search flags" }),
    ).toHaveAttribute("placeholder", "Search by key or description…");
  });

  it("Bảng điều khiển: Tổng quan và điều hướng bằng tiếng Anh, số theo en-US", async () => {
    setLocale("en");
    server.use(
      http.get(`${API}/admin/overview`, () =>
        HttpResponse.json(golden("GET /admin/overview")),
      ),
      http.get(`${API}/admin/platform`, () =>
        HttpResponse.json(golden("GET /admin/platform")),
      ),
      http.get(`${API}/admin/system/health`, () =>
        HttpResponse.json(golden("GET /admin/system/health")),
      ),
      http.get(`${API}/admin/jobs`, () =>
        HttpResponse.json(golden("GET /admin/jobs")),
      ),
    );
    renderApp("/admin/overview", {
      user: { ...USER, platformRole: "PLATFORM_ADMIN" },
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Platform console" }),
    ).toHaveTextContent("Orphaned resources");
    expect(
      await screen.findByRole("heading", { name: "Machine running UDP" }),
    ).toBeInTheDocument();
  });

  it("Giám sát: khoảng thời gian và nút mở công cụ theo mã của máy chủ", async () => {
    setLocale("en");
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/metrics/red`, () =>
        HttpResponse.json(golden("GET /projects/{id}/metrics/red")),
      ),
      http.get(`${API}/projects/:id/metrics/dora`, () =>
        HttpResponse.json(golden("GET /projects/{id}/metrics/dora")),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/monitoring`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Monitoring" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "24 hours" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Open Grafana" }),
    ).toBeInTheDocument();
  });
});
