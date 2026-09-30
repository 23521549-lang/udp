import type {
  ProjectDetailResponseWire,
  SegmentListResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  quotaVerdict,
  segmentSizeOf,
} from "../src/features/segment/segment-quota";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * Trả mục nợ `portal-segment-quota`. Tiêu chí Đạt: project ở đúng trần, thêm 1 KiB nữa ⇒
 * cảnh báo bật TRƯỚC khi gửi; và khi Portal tính dưới trần mà server vẫn từ chối (413/422)
 * thì UI vẫn nói được.
 */

/** Cách Postgres in jsonb::text: một khoảng trắng sau mỗi `,` và `:` ngoài chuỗi */
const pgText = (v: unknown): string =>
  JSON.stringify(v, null, 1)
    .replace(/\n\s*/g, " ")
    .replace(/\[ /g, "[")
    .replace(/ \]/g, "]")
    .replace(/\{ /g, "{")
    .replace(/ \}/g, "}");

describe("ước lượng dung lượng segment", () => {
  const c = {
    all: [{ attribute: "country", operator: "in", value: ["VN", "TH"] }],
    userIds: ["u-1", "u-2", "u-1"],
  };

  it("chặn dưới ≤ thước của Postgres ≤ ước lượng trên", () => {
    const size = segmentSizeOf(c);
    const pg = new TextEncoder().encode(
      pgText({ all: c.all, userIds: ["u-1", "u-2"] }),
    ).length;
    expect(size.lower).toBeLessThanOrEqual(pg);
    expect(size.upper).toBeGreaterThanOrEqual(pg);
  });

  it("userIds trùng được khử trước khi đo (server khử trước khi lưu)", () => {
    expect(segmentSizeOf(c).lower).toBe(
      segmentSizeOf({ ...c, userIds: ["u-1", "u-2"] }).lower,
    );
  });

  it("chữ có dấu tính theo byte UTF-8, không theo ký tự", () => {
    const a = segmentSizeOf({ all: [], userIds: ["a"] }).lower;
    const b = segmentSizeOf({ all: [], userIds: ["ạ"] }).lower;
    expect(b - a).toBe(2);
  });

  it("sửa một segment: trừ bản cũ của chính nó trước khi cộng bản mới", () => {
    const next = { lower: 100, upper: 110 };
    expect(
      quotaVerdict({
        projectBytes: 1000,
        maxBytes: 1000,
        editingBytes: 120,
        next,
      }).verdict,
    ).toBe("ok");
    expect(
      quotaVerdict({
        projectBytes: 1000,
        maxBytes: 1000,
        editingBytes: 95,
        next,
      }).verdict,
    ).toBe("over");
    expect(
      quotaVerdict({
        projectBytes: 1000,
        maxBytes: 1000,
        editingBytes: 105,
        next,
      }).verdict,
    ).toBe("maybe");
  });
});

function setup(nearFull: boolean) {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = "OWNER";
  const list = golden<SegmentListResponseWire>("GET /projects/{id}/segments");
  if (nearFull) list.quota.payloadBytes = list.quota.maxPayloadBytes - 100;
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/segments`, () => HttpResponse.json(list)),
    http.post(`${API}/projects/:id/segments`, () =>
      HttpResponse.json(
        {
          type: "about:blank",
          title: "Resource quota exceeded",
          status: 422,
          code: "QUOTA_EXCEEDED",
          traceId: "t-q",
        },
        { status: 422 },
      ),
    ),
  );
  return detail;
}

describe("cảnh báo trần trong hộp tạo segment", () => {
  it("project sát trần + thêm ~1 KiB userIds ⇒ cảnh báo 'vượt trần' TRƯỚC khi gửi", async () => {
    const detail = setup(true);
    renderApp(`/app/projects/${detail.project.id}/segments`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Tạo segment" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Tên"), "lon");
    const ids = Array.from(
      { length: 120 },
      (_, i) => `user-${String(i).padStart(3, "0")}`,
    );
    const tags = within(dialog).getByLabelText("Danh sách khoá người dùng");
    await user.click(tags);
    await user.paste(ids.join(","));
    await user.keyboard("{Enter}");
    expect(
      await within(dialog).findByText(/Vượt trần dung lượng/),
    ).toBeInTheDocument();
  });

  it("Portal tính dưới trần nhưng server vẫn từ chối ⇒ UI nói lỗi của server", async () => {
    const detail = setup(false);
    renderApp(`/app/projects/${detail.project.id}/segments`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Tạo segment" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Tên"), "nho");
    await user.type(
      within(dialog).getByLabelText("Danh sách khoá người dùng"),
      "u-1{Enter}",
    );
    expect(within(dialog).queryByText(/Vượt trần/)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));
    await waitFor(() =>
      expect(
        within(dialog).getByText("Vượt trần tài nguyên của project."),
      ).toBeInTheDocument(),
    );
  });
});

describe("[Plan #58] trang Segment: trạng thái trống và panel", () => {
  it("UX-17: chưa có segment ⇒ nói vì sao, cần gì, và một nút mở hộp tạo", async () => {
    const detail = setup(false);
    const list = golden<SegmentListResponseWire>("GET /projects/{id}/segments");
    list.segments = [];
    server.use(
      http.get(`${API}/projects/:id/segments`, () => HttpResponse.json(list)),
    );
    renderApp(`/app/projects/${detail.project.id}/segments`);
    expect(await screen.findByText("Chưa có segment nào")).toBeInTheDocument();
    expect(screen.getByText(/nhóm người dùng đặt tên sẵn/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Tạo segment đầu tiên" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("UX-38: mở panel ⇒ focus vào panel; Esc ⇒ đóng và focus về đúng dòng", async () => {
    const detail = setup(false);
    server.use(
      http.get(`${API}/projects/:id/segments/:segmentId`, () =>
        HttpResponse.json(golden("GET /projects/{id}/segments/{id}")),
      ),
    );
    const { router } = renderApp(`/app/projects/${detail.project.id}/segments`);
    const list = await screen.findByRole("list", { name: "Danh sách segment" });
    const row = within(list).getAllByRole("link")[0]!;
    const user = userEvent.setup();
    await user.click(row);
    const panel = await screen.findByRole("complementary", {
      name: "Chi tiết segment",
    });
    await waitFor(() => expect(panel).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("segment"),
    );
    await waitFor(() => expect(row).toHaveFocus());
  });
});
