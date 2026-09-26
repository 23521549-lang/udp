import type {
  FlagSummaryWire,
  ProjectDetailResponseWire,
} from "@udp/shared-types/wire";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_RETRY_MS } from "../src/features/project/project-stream";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * Plan #41 AC-3, AC-5 — luồng cấu hình của project (sự kiện ⇒ CHỈ `invalidateQueries`, luồng
 * đóng ⇒ mở lại sau backoff) và danh sách flag theo trang (không màn hình nào xin quá 50 hàng).
 */

class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (() => void)[]>();
  readyState = 1;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  /** Máy chủ từ chối (phiên hết hạn): trình duyệt đóng luồng và KHÔNG tự nối lại */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const projectStreams = () =>
  FakeEventSource.instances.filter((s) => s.url.endsWith("/stream"));

/** Trang flag giả theo `offset`/`limit` — ghi lại mọi truy vấn để kiểm trần 50 */
function useFlagPages(count: number) {
  const template = golden<{ flags: FlagSummaryWire[] }>(
    "GET /projects/{id}/flags",
  ).flags[0]!;
  const all = Array.from({ length: count }, (_, i) => ({
    ...template,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    key: `flag-${String(i).padStart(3, "0")}`,
    lifecycleStatus: "ACTIVE" as const,
  }));
  const asked: URLSearchParams[] = [];
  server.use(
    http.get(`${API}/projects/:id/flags`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      asked.push(params);
      const search = params.get("search") ?? "";
      const matched = all.filter((f) => f.key.includes(search));
      const offset = Number(params.get("offset"));
      const limit = Number(params.get("limit"));
      return HttpResponse.json({
        flags: matched.slice(offset, offset + limit),
        total: matched.length,
      });
    }),
  );
  return { asked };
}

const flagsUrl = (detail: ProjectDetailResponseWire) =>
  `/app/projects/${detail.project.id}/flags`;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("luồng cấu hình của project (AC-3)", () => {
  it("flag_changed ⇒ invalidate đúng các key cấu hình của project, KHÔNG setQueryData", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    useFlagPages(3);
    const { queryClient } = renderApp(flagsUrl(detail));
    await waitFor(() => expect(projectStreams()).toHaveLength(1));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const write = vi.spyOn(queryClient, "setQueryData");

    // `ready` đầu tiên không làm mới gì — dữ liệu vừa được tải
    act(() => projectStreams()[0]?.emit("ready"));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => projectStreams()[0]?.emit("flag_changed"));
    const keys = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ["flags", detail.project.id],
        ["flag", detail.project.id],
        ["flagRules", detail.project.id],
        ["segments", detail.project.id],
      ]),
    );
    expect(write).not.toHaveBeenCalled();

    // Nối lại xong (`ready` lần hai) ⇒ làm mới: sự kiện lúc đứt không được phát lại
    invalidate.mockClear();
    act(() => projectStreams()[0]?.emit("ready"));
    expect(invalidate).toHaveBeenCalled();
  });

  it("luồng bị đóng hẳn ⇒ mở lại sau backoff, không mở lại lúc đang tự nối", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    useFlagPages(0);
    renderApp(flagsUrl(detail));
    await waitFor(() => expect(projectStreams()).toHaveLength(1));
    vi.useFakeTimers();

    act(() => {
      const first = projectStreams()[0];
      if (first !== undefined) first.readyState = 0; // đang tự nối lại
      first?.onerror?.();
    });
    act(() => {
      vi.advanceTimersByTime(STREAM_RETRY_MS.max);
    });
    expect(projectStreams()).toHaveLength(1);

    act(() => {
      projectStreams()[0]?.fail();
    });
    act(() => {
      vi.advanceTimersByTime(STREAM_RETRY_MS.first - 1);
    });
    expect(projectStreams()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(projectStreams()).toHaveLength(2);
  });
});

describe("danh sách flag theo trang (AC-5)", () => {
  it("120 flag: trang đầu 50, sang trang sau xin offset 50; tìm kiếm gửi máy chủ và quay về trang đầu; không lời nào quá 50", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const { asked } = useFlagPages(120);
    renderApp(flagsUrl(detail));

    expect(await screen.findByText("1–50 / 120")).toBeInTheDocument();
    expect(screen.getByText("flag-000")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Trang sau" }));
    expect(await screen.findByText("flag-050")).toBeInTheDocument();
    expect(asked.some((p) => p.get("offset") === "50")).toBe(true);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Tìm flag" }),
      "flag-11",
    );
    expect(await screen.findByText("flag-110")).toBeInTheDocument();
    const searched = asked.filter((p) => p.get("search") === "flag-11");
    expect(searched.at(-1)?.get("offset")).toBe("0");

    expect(asked.every((p) => Number(p.get("limit")) <= 50)).toBe(true);
    // Thanh số đọc `total` bằng limit=1, không tải danh sách để đếm
    expect(asked.some((p) => p.get("limit") === "1")).toBe(true);
  });
});
