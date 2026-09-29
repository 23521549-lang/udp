import type {
  ProjectDetailResponseWire,
  RolloutDetailWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  actionsFor,
  pollIntervalOf,
} from "../src/features/rollout/RolloutDetailPage";
import { finishedSince } from "../src/features/rollout/use-rollout-watcher";
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
    const prev = [
      { id: "a", flagKey: "x" },
      { id: "b", flagKey: null },
    ];
    expect(finishedSince(prev, [{ id: "b" }])).toEqual([
      { id: "a", flagKey: "x" },
    ]);
    expect(finishedSince(prev, [{ id: "a" }, { id: "b" }])).toEqual([]);
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
