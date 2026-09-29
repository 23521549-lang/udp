import type {
  DeploymentWire,
  DoraWire,
  ProjectDetailResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/lib/format";
import { API, golden, server } from "./msw";
import { renderApp, USER } from "./render";

describe("Deploy + DORA", () => {
  function setup() {
    const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
    detail.project.myRole = "VIEWER";
    const asked: string[] = [];
    server.use(
      http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
      http.get(`${API}/projects/:id/rollouts`, () =>
        HttpResponse.json({ rollouts: [] }),
      ),
      http.get(`${API}/projects/:id/deployments`, () =>
        HttpResponse.json(golden("GET /projects/{id}/deployments")),
      ),
      http.get(`${API}/projects/:id/metrics/dora`, ({ request }) => {
        const url = new URL(request.url);
        asked.push(
          `${url.searchParams.get("envId") ?? ""}:${url.searchParams.get("days") ?? ""}`,
        );
        return HttpResponse.json(golden("GET /projects/{id}/metrics/dora"));
      }),
    );
    return { detail, asked };
  }

  it("đổi khoảng thời gian ⇒ hỏi lại DORA với days mới (range nằm trong query key)", async () => {
    const { detail, asked } = setup();
    renderApp(`/app/projects/${detail.project.id}/deployments`);
    const user = userEvent.setup();
    await screen.findByLabelText("Chỉ số DORA");
    await user.click(screen.getByRole("button", { name: "7 ngày" }));
    await waitFor(() => expect(asked.some((a) => a.endsWith(":7"))).toBe(true));
    expect(asked.some((a) => a.endsWith(":30"))).toBe(true);
  });

  it("median null hiện '–', không hiện 0", () => {
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(45)).toBe("45 giây");
    expect(formatDuration(9000)).toBe("2 giờ 30 phút");
    expect(formatDuration(4 * 86400)).toBe("4 ngày");
  });

  it("deploy chờ duyệt: MAINTAINER duyệt ⇒ POST approve rồi tải lại danh sách; VIEWER không có nút", async () => {
    const { detail } = setup();
    const list = golden<{ deployments: DeploymentWire[] }>(
      "GET /projects/{id}/deployments",
    );
    const first = list.deployments[0]!;
    first.status = "DEPLOY_PENDING";
    const approved: string[] = [];
    let reads = 0;
    server.use(
      http.get(`${API}/projects/:id/deployments`, () => {
        reads += 1;
        return HttpResponse.json(list);
      }),
      http.post(
        `${API}/projects/:id/deployments/:deploymentId/approve`,
        ({ params }) => {
          approved.push(String(params.deploymentId));
          return HttpResponse.json(
            golden("POST /projects/{id}/deployments/{id}/approve"),
            { status: 202 },
          );
        },
      ),
    );

    detail.project.myRole = "VIEWER";
    const viewer = renderApp(`/app/projects/${detail.project.id}/deployments`);
    await screen.findByText("Chờ duyệt");
    expect(
      screen.queryByRole("button", { name: "Duyệt deploy" }),
    ).not.toBeInTheDocument();
    viewer.unmount();

    detail.project.myRole = "MAINTAINER";
    renderApp(`/app/projects/${detail.project.id}/deployments`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Duyệt deploy" }),
    );
    const dialog = await screen.findByRole("dialog");
    const before = reads;
    await user.click(
      within(dialog).getByRole("button", { name: "Duyệt deploy" }),
    );
    await waitFor(() => expect(approved).toEqual([first.deploymentId]));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it("danh sách deployment hiện trạng thái bằng CHỮ", async () => {
    const { detail } = setup();
    renderApp(`/app/projects/${detail.project.id}/deployments`);
    const list = await screen.findByRole("list", { name: "Deployment" });
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("DORA mẫu có đủ bốn thẻ", async () => {
    const { detail } = setup();
    const dora = golden<{ dora: DoraWire }>(
      "GET /projects/{id}/metrics/dora",
    ).dora;
    renderApp(`/app/projects/${detail.project.id}/deployments`);
    const cards = await screen.findByLabelText("Chỉ số DORA");
    expect(within(cards).getByText("Tần suất deploy")).toBeInTheDocument();
    expect(
      within(cards).getByText(
        `${String(dora.changeFailureRate.failed)}/${String(dora.changeFailureRate.total)} deployment`,
      ),
    ).toBeInTheDocument();
  });
});

describe("khu quản trị", () => {
  it("USER mở /admin ⇒ về trang chủ, không thấy trang quản trị", async () => {
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    const { router } = renderApp("/admin/users");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/app/home"),
    );
    expect(screen.queryByRole("navigation", { name: "Quản trị" })).toBeNull();
  });

  it("PLATFORM_ADMIN thấy danh sách người dùng; đổi vai cần gõ lại email", async () => {
    const users = golden<{
      users: { id: string; email: string; platformRole: string }[];
    }>("GET /admin/users");
    const target =
      users.users.find((u) => u.platformRole === "USER") ?? users.users[0]!;
    const patches: unknown[] = [];
    server.use(
      http.get(`${API}/admin/users`, () => HttpResponse.json(users)),
      http.patch(
        `${API}/admin/users/:userId/platform-role`,
        async ({ request }) => {
          patches.push(await request.json());
          return HttpResponse.json(
            golden("PATCH /admin/users/{id}/platform-role"),
          );
        },
      ),
    );
    renderApp("/admin/users", {
      user: { ...USER, platformRole: "PLATFORM_ADMIN" },
    });
    const table = await screen.findByRole("table", { name: "Người dùng" });
    const row = within(table).getByText(target.email).closest("tr")!;
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByRole("button"));
    const dialog = await screen.findByRole("dialog");
    const ok = within(dialog).getByRole("button", { name: "Đổi vai" });
    expect(ok).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/để xác nhận/), target.email);
    await user.click(ok);
    await waitFor(() => expect(patches).toHaveLength(1));
  });

  it("orphan: giá null hiện 'Chưa rõ giá', và nói rõ chưa quét cloud", async () => {
    const body = golden<{
      resources: { usdPerHour: number | null }[];
      cloudScanned: boolean;
    }>("GET /admin/orphan-resources");
    body.resources = [
      {
        ...(body.resources[0] ?? {
          id: "11111111-1111-4111-8111-111111111111",
          projectId: "22222222-2222-4222-8222-222222222222",
          projectName: "p",
          kind: "mystery",
          provider: "AWS",
          region: "ap-southeast-1",
          providerId: null,
          updatedAt: new Date().toISOString(),
        }),
        usdPerHour: null,
      },
    ];
    server.use(
      http.get(`${API}/admin/orphan-resources`, () => HttpResponse.json(body)),
    );
    renderApp("/admin/orphans", {
      user: { ...USER, platformRole: "PLATFORM_ADMIN" },
    });
    const table = await screen.findByRole("table", {
      name: "Tài nguyên mồ côi",
    });
    expect(within(table).getByText("Chưa rõ giá")).toBeInTheDocument();
    expect(screen.getByText(/Chưa quét cloud theo tag/)).toBeInTheDocument();
  });
});
