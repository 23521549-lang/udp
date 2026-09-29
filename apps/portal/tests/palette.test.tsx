import type { ProjectDetailResponseWire } from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Flag } from "lucide-react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  matchItems,
  usePaletteStore,
  type PaletteItem,
} from "../src/features/project/CommandPalette";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * Trả mục nợ `portal-cmdk` — tiêu chí Đạt: mọi hành động trong bảng lệnh tới được bằng bàn phím; phím
 * 1/2/3 đổi environment; không bắt phím khi người dùng đang gõ.
 */

function setup() {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = "OWNER";
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/flags`, () =>
      HttpResponse.json(golden("GET /projects/{id}/flags")),
    ),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/members`, () =>
      HttpResponse.json(golden("GET /projects/{id}/members")),
    ),
    // [Plan #45] Thẻ "Deploy gần nhất" của Tổng quan
    http.get(`${API}/projects/:id/deployments/latest`, () =>
      HttpResponse.json(golden("GET /projects/{id}/deployments/latest")),
    ),
    // [Plan #53] Thẻ Cloud và lưới sức khoẻ của Tổng quan
    http.get(`${API}/projects/:id/architecture`, () =>
      HttpResponse.json(golden("GET /projects/{id}/architecture")),
    ),
    // Mở flag từ bảng lệnh nạp panel xem nhanh — trả 404 là đủ, test chỉ xét URL
    http.get(`${API}/projects/:id/flags/:flagId`, () =>
      HttpResponse.json(
        { title: "Not found", status: 404, traceId: "t" },
        { status: 404 },
      ),
    ),
  );
  const ordered = [...detail.environments].sort((a, b) => a.rank - b.rank);
  return { detail, ordered };
}

describe("bảng lệnh: lọc", () => {
  const item = (label: string): PaletteItem => ({
    group: "Lệnh",
    label,
    hint: "",
    icon: Flag,
    run: () => undefined,
  });

  it("không phân biệt hoa thường và dấu", () => {
    const items = [item("Chuyển sang production"), item("Giao diện tối")];
    expect(matchItems(items, "chuyen SANG").map((i) => i.label)).toEqual([
      "Chuyển sang production",
    ]);
    expect(matchItems(items, "toi").map((i) => i.label)).toEqual([
      "Giao diện tối",
    ]);
    expect(matchItems(items, "  ")).toHaveLength(2);
  });
});

describe("bảng lệnh: bàn phím", () => {
  it("Ctrl K mở; gõ + Enter chạy lệnh đổi environment; Esc đóng", async () => {
    const { detail, ordered } = setup();
    const target = ordered[ordered.length - 1]!;
    const { router } = renderApp(`/app/projects/${detail.project.id}`);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Environment: / });

    await user.keyboard("{Control>}k{/Control}");
    const pal = await screen.findByRole("dialog", { name: "Tìm nhanh" });
    await user.type(within(pal).getByRole("combobox"), `sang ${target.name}`);
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ env: target.id }),
    );
    expect(screen.queryByRole("dialog", { name: "Tìm nhanh" })).toBeNull();

    await user.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Tìm nhanh" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Tìm nhanh" })).toBeNull(),
    );
  });

  it("mũi tên chọn mục, Enter mở flag", async () => {
    const { detail } = setup();
    const flags = golden<{ flags: { id: string; key: string }[] }>(
      "GET /projects/{id}/flags",
    );
    const first = flags.flags[0]!;
    const { router } = renderApp(`/app/projects/${detail.project.id}`);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: /^Environment: / });
    await user.keyboard("{Control>}k{/Control}");
    const pal = await screen.findByRole("dialog", { name: "Tìm nhanh" });
    await within(pal).findByRole("option", { name: new RegExp(first.key) });
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ flag: first.id }),
    );
  });

  it("phím 2 đổi sang environment thứ hai theo rank; đang gõ thì không", async () => {
    const { detail, ordered } = setup();
    const { router } = renderApp(`/app/projects/${detail.project.id}/flags`);
    const user = userEvent.setup();
    const search = await screen.findByLabelText("Tìm flag");

    await user.type(search, "2");
    expect(router.state.location.search).not.toMatchObject({
      env: ordered[1]!.id,
    });

    search.blur();
    await user.keyboard("2");
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        env: ordered[1]!.id,
      }),
    );
  });

  it("nút 'Tìm nhanh' ở thanh bên mở cùng bảng — Ctrl K không phải đường duy nhất", async () => {
    const { detail } = setup();
    renderApp(`/app/projects/${detail.project.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Tìm nhanh/ }));
    expect(
      await screen.findByRole("dialog", { name: "Tìm nhanh" }),
    ).toBeInTheDocument();
    usePaletteStore.setState({ open: false });
  });
});
