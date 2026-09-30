import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ConfirmDialog } from "../src/components/ConfirmDialog";
import { Dialog } from "../src/components/Dialog";
import { Field } from "../src/components/Field";
import { InfoTip } from "../src/components/InfoTip";
import { useLocaleStore } from "../src/i18n";
import { useShortcutStore } from "../src/lib/shortcuts";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * [Plan #58] Phần khung chung của đợt tối ưu UX: hộp thoại không cướp focus khi trang cha vẽ lại (UX-37), giải thích
 * thuật ngữ bằng bấm (UX-19), trợ giúp ở cùng một chỗ (UX-21), tiêu đề thẻ trình duyệt theo màn (UX-31), phím tắt
 * một phím tắt được (UX-40), ô form có gợi ý và lỗi gắn với ô (UX-39).
 */

describe("hộp thoại (UX-37)", () => {
  it("trang cha vẽ lại (onClose là hàm mới) không kéo con trỏ về ô đầu", async () => {
    function Parent() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            rerender {tick}
          </button>
          <Dialog title="Tạo" onClose={() => undefined}>
            <input aria-label="một" />
            <input aria-label="hai" />
          </Dialog>
        </>
      );
    }
    render(<Parent />);
    const user = userEvent.setup();
    expect(screen.getByLabelText("một")).toHaveFocus();
    await user.click(screen.getByLabelText("hai"));
    // Trang cha cập nhật như danh sách tự làm mới
    act(() => screen.getByRole("button", { name: /rerender/ }).click());
    act(() => screen.getByRole("button", { name: /rerender/ }).click());
    screen.getByLabelText("hai").focus();
    act(() => screen.getByRole("button", { name: /rerender/ }).click());
    expect(screen.getByLabelText("hai")).toHaveFocus();
  });

  it("hộp nguy hiểm không có ô gõ xác nhận: focus vào Huỷ; mô tả được nối vào hộp", () => {
    render(
      <ConfirmDialog
        title="Thu hồi khoá?"
        description="Ứng dụng dùng khoá này sẽ mất quyền ngay."
        confirmLabel="Thu hồi"
        danger
        onConfirm={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Huỷ" })).toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Ứng dụng dùng khoá này sẽ mất quyền ngay.",
    );
  });
});

describe("giải thích thuật ngữ (UX-19)", () => {
  it("mở bằng bấm, đóng bằng Esc và trả focus về nút", async () => {
    render(<InfoTip term="canary" />);
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: /Giải thích: Bản thử/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("note")).toHaveTextContent(
      "Phần nhỏ người dùng nhận bản mới trước",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(button).toHaveFocus();
  });
});

describe("ô form (UX-39)", () => {
  it("gợi ý và lỗi được nối vào ô, ô báo không hợp lệ", () => {
    render(
      <Field label="Tên workload" hint="Chữ thường và số" error="Tên đã có">
        {(p) => <input className="inp" {...p} />}
      </Field>,
    );
    const input = screen.getByLabelText("Tên workload");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Chữ thường và số Tên đã có");
  });
});

describe("khung chung", () => {
  const useHome = () =>
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );

  it("trợ giúp ở thanh bên: bắt đầu nhanh và thuật ngữ tìm được, gõ không dấu vẫn ra (UX-21)", async () => {
    useHome();
    renderApp("/app/home");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Trợ giúp" }));
    const help = screen.getByRole("dialog", { name: "Trợ giúp" });
    expect(within(help).getByText("Bắt đầu nhanh")).toBeInTheDocument();
    await user.type(within(help).getByLabelText("Tìm thuật ngữ"), "khoa sdk");
    expect(within(help).getByText("Khoá SDK")).toBeInTheDocument();
    expect(within(help).queryByText("Cluster")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Trợ giúp" })).toBeNull();
  });

  it("tiêu đề thẻ trình duyệt theo h1 của màn (UX-31)", async () => {
    useHome();
    renderApp("/app/home");
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(document.title).toMatch(/^Chào .+ · UDP$/));
  });

  it("phím tắt một phím tắt được trong menu tài khoản (UX-40)", async () => {
    useHome();
    renderApp("/app/home");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Dev Tester/ }));
    const group = screen.getByRole("group", { name: "Phím tắt một phím" });
    await user.click(within(group).getByRole("button", { name: "Tắt" }));
    expect(useShortcutStore.getState().enabled).toBe(false);
    expect(localStorage.getItem("udp_shortcuts")).toBe("off");
  });

  it("tiếng Anh: nút trợ giúp và thuật ngữ theo ngôn ngữ", async () => {
    useHome();
    act(() => useLocaleStore.getState().setLocale("en"));
    renderApp("/app/home");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog", { name: "Help" })).toHaveTextContent(
      "Kill switch",
    );
  });
});
