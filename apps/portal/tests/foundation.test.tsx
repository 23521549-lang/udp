import type {
  ProjectDetailResponseWire,
  RulesResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { API, golden, server } from "./msw";
import {
  flagFixture,
  projectFixture,
  useProjectHandlers,
} from "./project-fixtures";
import { renderApp, USER } from "./render";

/**
 * Nền của Plan #53 (QĐ-1, QĐ-9): hai khung, không mất dữ liệu, không tác động ngay mà không cho
 * đường lui, URL phản ánh trạng thái, trang 404 trong khung. Mỗi ca là một lỗi đã kiểm chứng ở vòng
 * review 29/09 — test giữ nó không quay lại.
 */

const ADMIN = { ...USER, platformRole: "PLATFORM_ADMIN" as const };

describe("hai khung: Portal và Bảng điều khiển nền tảng", () => {
  it("lối sang Bảng điều khiển nằm trong menu tài khoản, chỉ PLATFORM_ADMIN thấy", async () => {
    server.use(
      http.get(`${API}/projects`, () =>
        HttpResponse.json({ projects: [], total: 0 }),
      ),
      // [Plan #58 UX-5] Danh sách project đọc số việc cần xử lý của mỗi project từ trang chủ
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    const user = userEvent.setup();
    const view = renderApp("/app/projects", { user: ADMIN });
    const nav = await screen.findByRole("complementary", {
      name: "Điều hướng chính",
    });
    // Không còn mục "Quản trị" giữa menu của developer
    expect(within(nav).queryByRole("link", { name: /Quản trị/ })).toBeNull();
    await user.click(within(nav).getByRole("button", { name: /Dev Tester/ }));
    const menu = within(nav).getByRole("group", { name: "Tài khoản" });
    expect(
      within(menu).getByRole("link", { name: "Bảng điều khiển nền tảng" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("button", { name: "Đăng xuất" }),
    ).toBeInTheDocument();
    view.unmount();

    // USER thường: menu tài khoản không có lối nào sang Bảng điều khiển
    renderApp("/app/projects");
    const nav2 = await screen.findByRole("complementary", {
      name: "Điều hướng chính",
    });
    await user.click(within(nav2).getByRole("button", { name: /Dev Tester/ }));
    expect(
      within(nav2).queryByRole("link", { name: "Bảng điều khiển nền tảng" }),
    ).toBeNull();
  });

  it("Bảng điều khiển có menu điện thoại (Esc đóng, trả focus) và đăng xuất — trước đây thiếu cả hai", async () => {
    server.use(
      http.get(`${API}/admin/users`, () =>
        HttpResponse.json(golden("GET /admin/users")),
      ),
      // [Plan #58 UX-26] Huy hiệu số của menu Bảng điều khiển
      http.get(`${API}/admin/overview`, () =>
        HttpResponse.json(golden("GET /admin/overview")),
      ),
    );
    const user = userEvent.setup();
    renderApp("/admin/users", { user: ADMIN });
    const menuBtn = await screen.findByRole("button", { name: "Mở menu" });
    expect(menuBtn).toHaveAttribute("aria-expanded", "false");
    await user.click(menuBtn);
    expect(menuBtn).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(menuBtn).toHaveAttribute("aria-expanded", "false");
    expect(menuBtn).toHaveFocus();

    const side = screen.getByRole("complementary", {
      name: "Điều hướng Bảng điều khiển",
    });
    expect(within(side).getByText("Nhà phát hành")).toBeInTheDocument();
    await user.click(within(side).getByRole("button", { name: /Dev Tester/ }));
    expect(
      within(side).getByRole("link", { name: "Về Portal" }),
    ).toBeInTheDocument();
    expect(
      within(side).getByRole("button", { name: "Đăng xuất" }),
    ).toBeInTheDocument();
  });

  it("đường sai trong /app hiện trang Không tìm thấy NGAY trong khung, có lối về", async () => {
    renderApp("/app/khong-co-trang-nay");
    expect(
      await screen.findByRole("heading", { name: "Không tìm thấy trang" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Về trang chủ" }),
    ).toBeInTheDocument();
    // Vẫn trong khung Portal: thanh bên còn đó
    expect(
      screen.getByRole("complementary", { name: "Điều hướng chính" }),
    ).toBeInTheDocument();
  });
});

describe("không mất dữ liệu", () => {
  function setupRules(detail: ProjectDetailResponseWire) {
    const { flag, summary } = flagFixture(detail);
    const second = {
      ...summary,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      key: "flag-hai",
    };
    const rules: RulesResponseWire = {
      updatedAt: golden<RulesResponseWire>(
        "GET /projects/{id}/flags/{id}/envs/{id}/rules",
      ).updatedAt,
      rules: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          priority: 10,
          ruleType: "ALL",
          condition: {},
          serve: { kind: "variant", variantId: flag.variants[0]!.id },
          description: "cũ",
        },
      ],
    };
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/flags`, () =>
        HttpResponse.json({ flags: [summary, second], total: 2 }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId`, () =>
        HttpResponse.json({ flag }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
        HttpResponse.json(rules),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/stats`, () =>
        HttpResponse.json(golden("GET /projects/{id}/flags/{id}/stats")),
      ),
    );
    return { flag, second };
  }

  it("nháp rule: bấm sang flag khác thì hỏi trước; Huỷ ở lại với nguyên nháp", async () => {
    const detail = projectFixture("MAINTAINER");
    const { flag } = setupRules(detail);
    const user = userEvent.setup();
    const { router } = renderApp(
      `/app/projects/${detail.project.id}/flags?flag=${flag.id}`,
      { history: "browser" },
    );
    const desc = await screen.findByLabelText("Mô tả Rule 1");
    await user.clear(desc);
    await user.type(desc, "đang sửa");
    await screen.findByText(/1 thay đổi ở/);

    // Dòng flag là LINK thật (Ctrl-click mở tab mới) — bấm nó là một điều hướng, và bị chặn
    const other = screen.getByRole("link", { name: /flag-hai/ });
    expect(other).toHaveAttribute("href", expect.stringContaining("flag="));
    await user.click(other);
    const dialog = await screen.findByRole("dialog", {
      name: "Bỏ thay đổi chưa lưu?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Huỷ" }));
    expect(router.state.location.search).toMatchObject({ flag: flag.id });
    expect(screen.getByLabelText("Mô tả Rule 1")).toHaveValue("đang sửa");
  });

  it("Bỏ nháp rule có Hoàn tác (DESIGN.md §7)", async () => {
    const detail = projectFixture("MAINTAINER");
    const { flag } = setupRules(detail);
    const user = userEvent.setup();
    renderApp(`/app/projects/${detail.project.id}/flags?flag=${flag.id}`);
    const desc = await screen.findByLabelText("Mô tả Rule 1");
    await user.clear(desc);
    await user.type(desc, "nháp");
    await user.click(await screen.findByRole("button", { name: "Bỏ" }));
    expect(screen.getByLabelText("Mô tả Rule 1")).toHaveValue("cũ");
    await user.click(await screen.findByRole("button", { name: "Hoàn tác" }));
    expect(screen.getByLabelText("Mô tả Rule 1")).toHaveValue("nháp");
  });

  it("wizard tạo project giữ bước và project trong URL: mở lại đường dẫn là về đúng bước", async () => {
    const detail = projectFixture("OWNER");
    detail.project.status = "DRAFT";
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/domains`, () =>
        HttpResponse.json(golden("GET /projects/{id}/domains")),
      ),
      http.get(`${API}/domains/catalog`, () =>
        HttpResponse.json(golden("GET /domains/catalog")),
      ),
    );
    renderApp(`/app/projects/new?project=${detail.project.id}&step=domains`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Chọn domain" }),
    ).toBeInTheDocument();
  });
});

describe("không tác động ngay mà không có đường lui", () => {
  it("bỏ đánh dấu Production phải xác nhận bằng tên, rồi mới PATCH", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const patches: unknown[] = [];
    server.use(
      http.patch(
        `${API}/projects/:id/environments/:envId`,
        async ({ request }) => {
          patches.push(await request.json());
          return HttpResponse.json(
            golden("PATCH /projects/{id}/environments/{id}"),
          );
        },
      ),
    );
    const prod = detail.environments.find((e) => e.isProduction)!;
    const user = userEvent.setup();
    renderApp(`/app/projects/${detail.project.id}/settings?tab=environments`);
    await user.click(
      await screen.findByLabelText(`${prod.name} là production`),
    );
    const dialog = await screen.findByRole("dialog");
    expect(patches).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/để xác nhận/), prod.name);
    await user.click(
      within(dialog).getByRole("button", { name: "Bỏ đánh dấu production" }),
    );
    await waitFor(() => expect(patches).toEqual([{ isProduction: false }]));
  });

  it("xoá thành viên có Hoàn tác: mời lại đúng email với đúng vai", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const members = golden<{
      members: {
        userId: string;
        projectRole: string;
        user: { email: string };
      }[];
    }>("GET /projects/{id}/members");
    const target = members.members.find((m) => m.projectRole !== "OWNER");
    if (target === undefined)
      throw new Error("mẫu thiếu thành viên không phải chủ");
    const invites: unknown[] = [];
    server.use(
      http.get(`${API}/projects/:id/members`, () => HttpResponse.json(members)),
      http.get(`${API}/projects/:id/invitations`, () =>
        HttpResponse.json(golden("GET /projects/{id}/invitations")),
      ),
      http.get(`${API}/projects/:id/teams`, () =>
        HttpResponse.json(golden("GET /projects/{id}/teams")),
      ),
      http.get(`${API}/teams`, () => HttpResponse.json(golden("GET /teams"))),
      http.delete(
        `${API}/projects/:id/members/:userId`,
        () => new HttpResponse(null, { status: 204 }),
      ),
      http.post(`${API}/projects/:id/members`, async ({ request }) => {
        invites.push(await request.json());
        return HttpResponse.json(golden("POST /projects/{id}/members"), {
          status: 201,
        });
      }),
    );
    const user = userEvent.setup();
    renderApp(`/app/projects/${detail.project.id}/settings?tab=members`);
    await user.click(
      await screen.findByRole("button", {
        name: `Xoá ${target.user.email} khỏi project`,
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Hoàn tác" }));
    await waitFor(() =>
      expect(invites).toEqual([
        { email: target.user.email, projectRole: target.projectRole },
      ]),
    );
  });
});

describe("lỗi 404 không đưa nút Thử lại", () => {
  it("rollout không tồn tại ⇒ lối về danh sách rollout, không có Thử lại", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/rollouts/:rolloutId`, () =>
        HttpResponse.json(
          {
            type: "https://udp.dev/problems/not-found",
            title: "Not Found",
            status: 404,
            detail: "Không tìm thấy rollout",
          },
          {
            status: 404,
            headers: { "Content-Type": "application/problem+json" },
          },
        ),
      ),
    );
    renderApp(
      `/app/projects/${detail.project.id}/rollouts/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
    );
    expect(
      await screen.findByRole("link", { name: "Về danh sách rollout" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull();
  });
});
