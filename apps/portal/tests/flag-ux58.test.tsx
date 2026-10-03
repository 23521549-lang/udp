import type {
  FlagSummaryWire,
  ProjectDetailResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { servingOf } from "../src/features/flag/flag-labels";
import { useShortcutStore } from "../src/lib/shortcuts";
import { API, golden, server } from "./msw";
import {
  flagFixture,
  projectFixture,
  useProjectHandlers,
} from "./project-fixtures";
import { renderApp } from "./render";

/**
 * [Plan #58] Khu flag: flag nháp không bị gọi là "Bật" (UX-4), phím tắt một phím tắt được (UX-40), panel xem nhanh
 * giữ và trả focus (UX-38), và "Phát hành dần" ngay từ flag (UX-29).
 */

function setupFlag(
  role: "MAINTAINER" | "DEVELOPER",
  lifecycle: "ACTIVE" | "DRAFT",
) {
  const detail = projectFixture(role);
  const { flag, summary } = flagFixture(detail);
  flag.lifecycleStatus = lifecycle;
  const row: FlagSummaryWire = {
    ...summary,
    lifecycleStatus: lifecycle,
    env: { ...summary.env!, isEnabled: true },
  };
  useProjectHandlers(detail);
  server.use(
    http.get(`${API}/projects/:id/flags`, () =>
      HttpResponse.json({ flags: [row], total: 1 }),
    ),
    http.get(`${API}/projects/:id/flags/:flagId`, () =>
      HttpResponse.json({ flag }),
    ),
    http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
      HttpResponse.json({ updatedAt: flag.updatedAt, rules: [] }),
    ),
    http.get(`${API}/projects/:id/flags/:flagId/stats`, () =>
      HttpResponse.json(golden("GET /projects/{id}/flags/{id}/stats")),
    ),
  );
  return { detail, flag };
}

describe("[Plan #58 UX-4] flag nháp không phục vụ", () => {
  it("servingOf: nháp và lưu trữ không bao giờ là 'bật', dù công tắc environment đang bật", () => {
    const env = {
      configId: "c",
      isEnabled: true,
      isTracked: false,
      ruleCount: 0,
    };
    expect(servingOf({ lifecycleStatus: "DRAFT", env })).toBe("draft");
    expect(servingOf({ lifecycleStatus: "ARCHIVED", env })).toBe("archived");
    expect(servingOf({ lifecycleStatus: "ACTIVE", env })).toBe("on");
    expect(
      servingOf({
        lifecycleStatus: "ACTIVE",
        env: { ...env, isEnabled: false },
      }),
    ).toBe("off");
  });

  it("danh sách ghi 'Nháp, chưa phục vụ'; con số của dòng có nhãn cho trình đọc màn hình", async () => {
    const { detail, flag } = setupFlag("DEVELOPER", "DRAFT");
    renderApp(`/app/projects/${detail.project.id}/flags`);
    const row = await screen.findByRole("link", {
      name: new RegExp(flag.key),
    });
    expect(within(row).getByText("Nháp, chưa phục vụ")).toBeInTheDocument();
    expect(within(row).queryByText("Bật")).toBeNull();
    expect(row).toHaveAccessibleName(expect.stringMatching(/Cập nhật/));
  });

  it("panel của flag nháp: dải báo kèm Kích hoạt nằm TRÊN công tắc environment", async () => {
    const { detail, flag } = setupFlag("MAINTAINER", "DRAFT");
    renderApp(`/app/projects/${detail.project.id}/flags?flag=${flag.id}`);
    const panel = await screen.findByRole("complementary", {
      name: "Chi tiết flag",
    });
    const note = await within(panel).findByRole("note");
    expect(note).toHaveTextContent("Nháp, chưa phục vụ");
    const activate = within(note).getByRole("button", { name: "Kích hoạt" });
    const toggle = await within(panel).findByRole("switch");
    expect(
      activate.compareDocumentPosition(toggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Flag nháp chưa phát hành dần được: không có nút đó
    expect(
      within(panel).queryByRole("button", { name: "Phát hành dần" }),
    ).toBeNull();
  });
});

describe("[Plan #58 UX-40] phím tắt một phím tắt được", () => {
  afterEach(() => useShortcutStore.setState({ enabled: true }));

  it("tắt ⇒ 'c' không mở hộp tạo flag và nút không còn gợi ý phím; bật ⇒ mở", async () => {
    const { detail, flag } = setupFlag("DEVELOPER", "ACTIVE");
    useShortcutStore.setState({ enabled: false });
    renderApp(`/app/projects/${detail.project.id}/flags`);
    await screen.findByRole("link", { name: new RegExp(flag.key) });
    const user = userEvent.setup();
    await user.keyboard("c");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Tạo flag" }).querySelector("kbd"),
    ).toBeNull();

    useShortcutStore.setState({ enabled: true });
    await user.keyboard("c");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("[Plan #58 UX-38] panel flag giữ và trả focus", () => {
  it("mở ⇒ focus vào panel; Esc ⇒ đóng và focus về đúng dòng đã mở", async () => {
    const { detail, flag } = setupFlag("DEVELOPER", "ACTIVE");
    const { router } = renderApp(`/app/projects/${detail.project.id}/flags`);
    const row = await screen.findByRole("link", {
      name: new RegExp(flag.key),
    });
    const user = userEvent.setup();
    await user.click(row);
    const panel = await screen.findByRole("complementary", {
      name: "Chi tiết flag",
    });
    await waitFor(() => expect(panel).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("flag"),
    );
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe("[Plan #58 UX-29] phát hành dần ngay từ flag", () => {
  it("nút 'Phát hành dần' mở hộp tạo rollout với flag này đã chọn", async () => {
    const { detail, flag } = setupFlag("MAINTAINER", "ACTIVE");
    renderApp(`/app/projects/${detail.project.id}/flags?flag=${flag.id}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Phát hành dần" }),
    );
    const dialog = await screen.findByRole("dialog");
    const select = await within(dialog).findByLabelText("Flag (đang dùng)");
    await waitFor(() => expect(select).toHaveValue(flag.id));
    expect(within(dialog).getByLabelText("Tìm flag đang dùng")).toHaveValue(
      flag.key,
    );
  });
});

describe("[Plan #58 UX-1] trang Dọn dẹp flag", () => {
  it("mỗi flag cần dọn là một hàng riêng của danh sách", async () => {
    const detail: ProjectDetailResponseWire = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/flags/stale`, () =>
        HttpResponse.json(golden("GET /projects/{id}/flags/stale")),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/flags/cleanup`);
    const list = await screen.findByRole("list", { name: "Flag cần dọn" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    // Khớp đúng bộ chọn của kiểu hàng (`.lst > label.it`, portal.css)
    for (const r of rows) {
      expect(r.parentElement).toHaveClass("lst");
      expect(r.tagName).toBe("LABEL");
      expect(r).toHaveClass("it");
      expect(within(r).getByRole("checkbox")).toBeInTheDocument();
    }
  });
});
