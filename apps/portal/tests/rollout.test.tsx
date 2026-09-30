import type {
  ProjectDetailResponseWire,
  RolloutDetailWire,
  RolloutSummaryWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  actionsFor,
  decisionTone,
  pollIntervalOf,
} from "../src/features/rollout/RolloutDetailPage";
import {
  finishedSince,
  watchedName,
} from "../src/features/rollout/use-rollout-watcher";
import { qk } from "../src/lib/query-keys";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

describe("rollout: nhịp hỏi lại tự dừng (§10.14)", () => {
  it("5s khi chạy hay chờ, 10s khi tạm dừng, DỪNG khi kết thúc", () => {
    expect(pollIntervalOf("IN_PROGRESS")).toBe(5000);
    expect(pollIntervalOf("PENDING")).toBe(5000);
    expect(pollIntervalOf("PAUSED")).toBe(10000);
    expect(pollIntervalOf("DONE")).toBe(false);
    expect(pollIntervalOf("FAILED")).toBe(false);
    expect(pollIntervalOf(undefined)).toBe(false);
  });

  it("nút theo trạng thái: đã kết thúc thì không còn nút nào", () => {
    expect(actionsFor("IN_PROGRESS")).toEqual(["PAUSE", "PROMOTE", "ROLLBACK"]);
    expect(actionsFor("PAUSED")).toEqual(["RESUME", "PROMOTE", "ROLLBACK"]);
    expect(actionsFor("DONE")).toEqual([]);
    expect(actionsFor("FAILED")).toEqual([]);
  });

  it("watcher: rollout biến khỏi danh sách đang chạy ⇒ báo kết thúc", () => {
    const a = { id: "a", flagKey: "x", workloadName: null, environmentId: "e" };
    const b = {
      id: "b",
      flagKey: null,
      workloadName: "web",
      environmentId: "e",
    };
    expect(finishedSince([a, b], [{ id: "b" }])).toEqual([a]);
    expect(finishedSince([a, b], [{ id: "a" }, { id: "b" }])).toEqual([]);
  });

  it("[Plan #58 UX-9] watcher gọi rollout bằng tên người đọc được, mã chỉ là đường lui cuối", () => {
    const base = { id: "716f9487-aaaa", environmentId: "e" };
    expect(
      watchedName({ ...base, flagKey: "new-checkout", workloadName: "web" }),
    ).toBe("new-checkout");
    expect(watchedName({ ...base, flagKey: null, workloadName: "web" })).toBe(
      "web",
    );
    expect(watchedName({ ...base, flagKey: null, workloadName: null })).toBe(
      "716f9487",
    );
  });

  it("[Plan #58 UX-6] sắc của dải quyết định theo đúng quyết định", () => {
    const d = {
      reason: "r",
      breach: false,
      breachStreak: 0,
      breachAt: null,
      at: new Date().toISOString(),
    };
    const intent = {
      id: "i",
      action: "PAUSE" as const,
      at: d.at,
      byUser: "a@b.vn",
    };
    expect(decisionTone({}, 2)).toBe("neutral");
    expect(
      decisionTone({ lastDecision: { ...d, decision: "PROMOTE" } }, 2),
    ).toBe("ok");
    // HOLD không vượt ngưỡng = còn chờ dữ liệu
    expect(decisionTone({ lastDecision: { ...d, decision: "HOLD" } }, 2)).toBe(
      "neutral",
    );
    expect(
      decisionTone(
        {
          lastDecision: {
            ...d,
            decision: "HOLD",
            breach: true,
            breachStreak: 1,
          },
        },
        3,
      ),
    ).toBe("warn");
    // Lần vượt tới sẽ tự lùi lại ⇒ lỗi
    expect(
      decisionTone(
        {
          lastDecision: {
            ...d,
            decision: "HOLD",
            breach: true,
            breachStreak: 1,
          },
        },
        2,
      ),
    ).toBe("error");
    expect(
      decisionTone(
        {
          lastDecision: { ...d, decision: "PROMOTE" },
          pendingIntent: intent,
        },
        2,
      ),
    ).toBe("neutral");
  });
});

function setup(rollout: RolloutDetailWire, role: "OWNER" | "VIEWER" = "OWNER") {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = role;
  rollout.projectId = detail.project.id;
  const actions: unknown[] = [];
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/rollouts/:rid`, () =>
      HttpResponse.json({ rollout }),
    ),
    http.post(
      `${API}/projects/:id/rollouts/:rid/actions`,
      async ({ request }) => {
        actions.push(await request.json());
        return HttpResponse.json(
          {
            intentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            status: "accepted",
          },
          { status: 202 },
        );
      },
    ),
  );
  return { detail, actions };
}

describe("rollout: trang chi tiết", () => {
  it("rollback cần XÁC NHẬN; tạm dừng thì gửi ngay", async () => {
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    rollout.status = "IN_PROGRESS";
    delete rollout.pendingIntent;
    const { detail, actions } = setup(rollout);
    renderApp(`/app/projects/${detail.project.id}/rollouts/${rollout.id}`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Rollback" }));
    const dialog = await screen.findByRole("dialog");
    expect(actions).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Rollback" }));
    await waitFor(() => expect(actions).toEqual([{ action: "ROLLBACK" }]));

    await user.click(screen.getByRole("button", { name: "Tạm dừng" }));
    await waitFor(() =>
      expect(actions).toEqual([{ action: "ROLLBACK" }, { action: "PAUSE" }]),
    );
  });

  it("intent đang chờ ⇒ nút hiện 'Đang thực hiện…' và mọi nút khoá (§10.12 B3)", async () => {
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    rollout.status = "IN_PROGRESS";
    rollout.pendingIntent = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      action: "PAUSE",
      at: new Date().toISOString(),
      byUser: "a@b.vn",
    };
    const { detail } = setup(rollout);
    renderApp(`/app/projects/${detail.project.id}/rollouts/${rollout.id}`);
    const busy = await screen.findByRole("button", {
      name: "Đang thực hiện…",
    });
    expect(busy).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rollback" })).toBeDisabled();
  });

  it("tự rollback ⇒ banner nói rõ, và không còn nút điều khiển", async () => {
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    rollout.status = "FAILED";
    rollout.failReason = "AUTO_ROLLBACK";
    delete rollout.pendingIntent;
    const { detail } = setup(rollout);
    renderApp(`/app/projects/${detail.project.id}/rollouts/${rollout.id}`);
    expect(
      await screen.findByText("Hệ thống đã tự rollback"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();
  });

  it("VIEWER xem được nhưng không có nút điều khiển", async () => {
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    rollout.status = "IN_PROGRESS";
    delete rollout.pendingIntent;
    const { detail } = setup(rollout, "VIEWER");
    renderApp(`/app/projects/${detail.project.id}/rollouts/${rollout.id}`);
    await screen.findByText(/Lưu lượng variant mới/);
    expect(screen.queryByRole("button", { name: "Tạm dừng" })).toBeNull();
  });
});

describe("[Plan #58] rollout: dải quyết định và báo kết thúc", () => {
  it("UX-6: trong ngưỡng ⇒ dải 'ổn', không cam; hết giờ giữ bậc ⇒ 'Có thể lên bậc tiếp', không 'sau 0 giây'", async () => {
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    rollout.status = "IN_PROGRESS";
    delete rollout.pendingIntent;
    rollout.events = [];
    rollout.createdAt = new Date(Date.now() - 3_600_000).toISOString();
    rollout.lastDecision = {
      decision: "PROMOTE",
      reason: "Không vượt ngưỡng",
      breach: false,
      breachStreak: 0,
      breachAt: null,
      at: new Date().toISOString(),
    };
    const { detail } = setup(rollout);
    renderApp(`/app/projects/${detail.project.id}/rollouts/${rollout.id}`);
    const banner = (await screen.findByText("Không vượt ngưỡng")).closest(
      ".alert",
    );
    expect(banner).toHaveClass("ok");
    expect(banner).not.toHaveClass("amber");
    expect(screen.getByText(/Có thể lên bậc tiếp/)).toBeInTheDocument();
    expect(screen.queryByText(/sau 0 giây/)).toBeNull();
    // Một từ cho nhóm so sánh; "Mốc rollback" thành lời thường
    expect(screen.queryByText("Mốc rollback")).toBeNull();
    expect(screen.getByText("Lưu lượng khi lùi lại")).toBeInTheDocument();
  });

  it("UX-9: rollout kết thúc ⇒ toast gọi bằng tên (không mã) và nút 'Xem kết quả' mở đúng rollout", async () => {
    const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
    detail.project.myRole = "OWNER";
    const { rollouts } = golden<{ rollouts: RolloutSummaryWire[] }>(
      "GET /projects/{id}/rollouts",
    );
    const running = {
      ...rollouts[0]!,
      scope: "SERVICE_LEVEL" as const,
      flagKey: null,
      workloadName: "web",
    };
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    rollout.id = running.id;
    let active = [running];
    server.use(
      http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
      http.get(`${API}/projects/:id/rollouts`, ({ request }) =>
        HttpResponse.json({
          rollouts:
            new URL(request.url).searchParams.get("status") === "IN_PROGRESS"
              ? active
              : [],
        }),
      ),
      http.get(`${API}/projects/:id/rollouts/:rid`, () =>
        HttpResponse.json({ rollout }),
      ),
    );
    const { queryClient, router } = renderApp(
      `/app/projects/${detail.project.id}/rollouts`,
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryData(qk.activeRollouts(detail.project.id)),
      ).toBeDefined(),
    );
    active = [];
    await queryClient.refetchQueries({
      queryKey: qk.activeRollouts(detail.project.id),
    });
    expect(
      await screen.findByText("Rollout web đã kết thúc."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/2fed0906/)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Xem kết quả" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/app/projects/${detail.project.id}/rollouts/${running.id}`,
      ),
    );
    expect(router.state.location.search).toMatchObject({
      env: running.environmentId,
    });
  });
});
