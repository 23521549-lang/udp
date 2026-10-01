import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { KnownDomainType } from "../src/features/domain/domain-info.messages";
import {
  DOMAIN_COUNT,
  LANDING_TOOLS,
  SAFETY_QUOTA,
  TOOL_COUNT,
} from "../src/features/landing/landing-facts";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * [Plan #59] Trang giới thiệu, đăng nhập và đăng ký. Hai ô đầu canh luật trung thực: mọi con số trên trang công khai
 * khớp nguồn sự thật của nó (catalog adapter của Service 1, trần tài nguyên của `@udp/config`), nên số trên trang
 * không thể lặng lẽ sai khi hệ thống đổi.
 */

const here = dirname(fileURLToPath(import.meta.url));

describe("sự thật trên trang giới thiệu", () => {
  it("bảng công cụ khớp catalog thật của Service 1: đủ domain, đủ công cụ, không thừa", () => {
    const catalog = golden<{
      domains: { domainType: string; tools: { toolId: string }[] }[];
    }>("GET /domains/catalog").domains;
    expect(Object.keys(LANDING_TOOLS).sort()).toEqual(
      catalog.map((d) => d.domainType).sort(),
    );
    for (const d of catalog) {
      expect(
        [...LANDING_TOOLS[d.domainType as KnownDomainType]].sort(),
      ).toEqual(d.tools.map((t) => t.toolId).sort());
    }
    expect(DOMAIN_COUNT).toBe(catalog.length);
    expect(TOOL_COUNT).toBe(catalog.reduce((n, d) => n + d.tools.length, 0));
  });

  it("trần an toàn khớp DEFAULT_RESOURCE_QUOTA mà Service 1 cưỡng chế", () => {
    const src = readFileSync(
      join(here, "..", "..", "..", "packages", "config", "src", "constants.ts"),
      "utf8",
    );
    const start = src.indexOf("export const DEFAULT_RESOURCE_QUOTA");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("} as const", start));
    for (const [key, value] of Object.entries(SAFETY_QUOTA)) {
      expect(block).toMatch(new RegExp(`\\b${key}: ${String(value)},`));
    }
  });
});

describe("trang giới thiệu", () => {
  it("chưa đăng nhập: / là trang giới thiệu; mọi nút chính dẫn tới đăng ký, có đường đăng nhập", async () => {
    renderApp("/", { user: null });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Phát hành an toàn, trên hạ tầng của chính bạn.",
      }),
    ).toBeInTheDocument();
    const starts = screen.getAllByRole("link", { name: /miễn phí/ });
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const link of starts)
      expect(link).toHaveAttribute("href", "/register");
    const nav = screen.getByRole("navigation", { name: "Điều hướng chính" });
    expect(within(nav).getByRole("link", { name: "Câu hỏi" })).toHaveAttribute(
      "href",
      "#faq",
    );
    expect(
      screen.getAllByRole("link", { name: "Đăng nhập" })[0],
    ).toHaveAttribute("href", "/login");
    // Số đếm được, không viết tay
    expect(
      screen.getByRole("heading", {
        name: `${String(DOMAIN_COUNT)} domain, ${String(TOOL_COUNT)} công cụ.`,
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.title).toBe("UDP · Phát hành an toàn trên cloud của bạn"),
    );
  });

  it("đã đăng nhập: / vào thẳng trang chủ như trước", async () => {
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    const { router } = renderApp("/");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/app/home"),
    );
  });

  it("đổi sang tiếng Anh ngay trên thanh điều hướng; nút ghi tên ngôn ngữ đích bằng chính ngôn ngữ đó", async () => {
    renderApp("/", { user: null });
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", {
      name: "Chuyển sang tiếng Anh",
    });
    expect(toggle).toHaveAttribute("lang", "en");
    await user.click(toggle);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Ship safely, on infrastructure you own.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch to Vietnamese" }),
    ).toHaveAttribute("lang", "vi");
  });

  it("mã SDK theo tab: đổi ngôn ngữ là đổi gói cài", async () => {
    renderApp("/", { user: null });
    const user = userEvent.setup();
    const tabs = await screen.findByRole("tablist", {
      name: "Ngôn ngữ của mã mẫu",
    });
    expect(
      screen.getByRole("region", { name: "Lệnh cài cho Node.js" }),
    ).toHaveTextContent("@udp/openfeature-provider");
    await user.click(within(tabs).getByRole("tab", { name: "Python" }));
    expect(
      screen.getByRole("region", { name: "Lệnh cài cho Python" }),
    ).toHaveTextContent("pip install openfeature-sdk udp-openfeature");
  });
});

describe("đăng nhập và đăng ký", () => {
  it("logo ở góc trên dẫn về trang giới thiệu", async () => {
    renderApp("/login", { user: null });
    expect(
      await screen.findByRole("link", { name: "UDP, về trang giới thiệu" }),
    ).toHaveAttribute("href", "/");
  });

  it("ô mật khẩu: nút hiện là nút bật; gợi ý vẫn gắn vào ô", async () => {
    renderApp("/register", { user: null });
    const user = userEvent.setup();
    const input = await screen.findByLabelText("Mật khẩu");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAccessibleDescription("Ít nhất 8 ký tự.");
    const toggle = screen.getByRole("button", { name: "Hiện mật khẩu" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(input).toHaveAttribute("type", "password");
  });

  it("trang đăng ký có panel bên với điều có ngay, số lấy từ catalog", async () => {
    renderApp("/register", { user: null });
    const aside = await screen.findByRole("complementary", {
      name: "Khi đăng ký, bạn có",
    });
    expect(aside).toHaveTextContent(
      `Đủ ${String(DOMAIN_COUNT)} domain và ${String(TOOL_COUNT)} công cụ DevOps`,
    );
    expect(
      screen.getByText(
        "Miễn phí trong giai đoạn thử nghiệm. Không cần thẻ thanh toán.",
      ),
    ).toBeInTheDocument();
  });
});
