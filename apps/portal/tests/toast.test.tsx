import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIFETIME_MS,
  lifetimeOf,
  toast,
  Toaster,
} from "../src/components/Toast";

/**
 * [Plan #58 UX-9] Toast có nút ở lại đủ lâu để bấm kịp (WCAG 2.2.1) và đóng được; mỗi câu chỉ được đọc lên MỘT
 * lần (một vùng `aria-live` cố định, không kèm `role` trên từng toast).
 */
describe("toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("thời gian hiện: có nút (Hoàn tác, Xem) ⇒ 20 giây; lỗi 8 giây; còn lại 4 giây", () => {
    expect(lifetimeOf({ tone: "info" })).toBe(LIFETIME_MS.info);
    expect(lifetimeOf({ tone: "error" })).toBe(LIFETIME_MS.error);
    expect(lifetimeOf({ tone: "info", undo: () => undefined })).toBe(20_000);
    expect(
      lifetimeOf({
        tone: "info",
        action: { label: "Xem", run: () => undefined },
      }),
    ).toBe(20_000);
  });

  it("toast có nút: bấm nút chạy việc và đóng toast; có nút đóng", async () => {
    const run = vi.fn();
    render(<Toaster />);
    act(() => toast.action("Rollout web đã kết thúc.", { label: "Xem", run }));
    const user = userEvent.setup();
    expect(
      screen.getByRole("button", { name: "Đóng thông báo" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xem" }));
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByText("Rollout web đã kết thúc.")).toBeNull();
  });

  it("không đọc hai lần: vùng đọc lên có sẵn, toast không mang role status/alert", () => {
    const { container } = render(<Toaster />);
    const regions = [...container.querySelectorAll("[aria-live]")];
    expect(regions.map((r) => r.getAttribute("aria-live"))).toEqual([
      "assertive",
      "polite",
    ]);
    act(() => {
      toast.info("Đã lưu");
      toast.error("Không lưu được");
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(regions[0]).toHaveTextContent("Không lưu được");
    expect(regions[1]).toHaveTextContent("Đã lưu");
  });

  it("toast có nút vẫn còn sau 5 giây, tự đóng sau 20 giây; toast thường đóng sau 4 giây", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      toast.info("Đã lưu rule", () => undefined);
      toast.info("Đã sao chép");
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("Đã lưu rule")).toBeInTheDocument();
    expect(screen.queryByText("Đã sao chép")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.queryByText("Đã lưu rule")).toBeNull();
  });
});
