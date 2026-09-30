import type {
  ArchitectureWire,
  ProjectDetailResponseWire,
  RolloutDetailWire,
} from "@udp/shared-types/wire";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { actionsFor } from "../src/features/rollout/RolloutDetailPage";
import { MetricsSetupGuide } from "../src/features/rollout/rollout-form";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * [Plan #51] Rollout SERVICE_LEVEL ở Portal (§10.9): bước SCOPE, ô chiến lược × chế độ theo công cụ của project
 * (CÙNG `serviceLevelIssue` với Service 1), và trang chi tiết nói bằng PHIÊN BẢN thay vì variant.
 */

type Domains = {
  domainSetVersion: number;
  domains: {
    domainType: string;
    isEnabled: boolean;
    selectedTool: string | null;
  }[];
  preferences: unknown[];
};

function setup(tool: string | null) {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = "OWNER";
  const dev = [...detail.environments]
    .sort((a, b) => a.rank - b.rank)
    .find((e) => !e.isProduction)!;
  const domains = golden<Domains>("GET /projects/{id}/domains");
  domains.domains = domains.domains.map((d) =>
    d.domainType === "PROGRESSIVE_DELIVERY"
      ? { ...d, isEnabled: tool !== null, selectedTool: tool }
      : d,
  );
  const { rollout } = golden<{ rollout: RolloutDetailWire }>(
    "GET /projects/{id}/rollouts/{id}",
  );
  const posts: Record<string, unknown>[] = [];
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/domains`, () => HttpResponse.json(domains)),
    // Danh sách flag của hộp tạo rollout và lưới sức khoẻ của Tổng quan — không phải thứ test này kiểm
    http.get(`${API}/projects/:id/flags`, () =>
      HttpResponse.json(golden("GET /projects/{id}/flags")),
    ),
    http.get(`${API}/projects/:id/architecture`, () =>
      HttpResponse.json(golden("GET /projects/{id}/architecture")),
    ),
    http.post(`${API}/projects/:id/rollouts/probe`, () => {
      const probe = golden<{ probe: { hasSeries: boolean } }>(
        "POST /projects/{id}/rollouts/probe",
      );
      probe.probe.hasSeries = true;
      return HttpResponse.json(probe);
    }),
    http.post(`${API}/projects/:id/rollouts`, async ({ request }) => {
      posts.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ rollout }, { status: 201 });
    }),
    http.get(`${API}/projects/:id/rollouts/:rid`, () =>
      HttpResponse.json({ rollout }),
    ),
  );
  return { detail, dev, posts };
}

async function openServiceForm(tool: string | null) {
  const world = setup(tool);
  renderApp(
    `/app/projects/${world.detail.project.id}/rollouts?env=${world.dev.id}`,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Tạo rollout" }));
  await user.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Theo phiên bản",
    }),
  );
  // Đổi phạm vi dựng một hộp thoại MỚI — lấy lại, không giữ tham chiếu của hộp cũ
  await screen.findByRole("group", { name: "Chế độ" });
  const dialog = screen.getByRole("dialog");
  return { ...world, user, dialog };
}

describe("tạo rollout SERVICE_LEVEL", () => {
  it("Flagger: Blue/Green bị khoá kèm lý do; UDP quyết + canary gửi đúng thân SERVICE_LEVEL", async () => {
    const { user, dialog, posts } = await openServiceForm("flagger");
    expect(await within(dialog).findByText("Flagger")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Blue/Green" }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "UDP quyết" }));
    await user.type(
      within(dialog).getByLabelText("Workload (tên service trong cluster)"),
      "web",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Kiểm tra metric" }),
    );
    await within(dialog).findByText(/Có metric/);
    await user.type(within(dialog).getByLabelText("Tag image mới"), "1.4.2");
    await user.click(
      within(dialog).getByRole("button", { name: "Tạo rollout" }),
    );

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      scope: "SERVICE_LEVEL",
      strategy: "CANARY",
      controlMode: "udp-driven",
      workloadName: "web",
      imageTag: "1.4.2",
      stepPercent: 20,
    });
    expect(posts[0]).not.toHaveProperty("trafficMatch");
  });

  it("Argo Rollouts: 'Theo header' chỉ mở ở chế độ UDP quyết, và gửi kèm header chọn nhóm", async () => {
    const { user, dialog, posts } = await openServiceForm("argo-rollouts");
    const byHeader = await within(dialog).findByRole("button", {
      name: "Theo header",
    });
    expect(byHeader).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "UDP quyết" }));
    expect(byHeader).toBeEnabled();
    await user.click(byHeader);

    await user.type(
      within(dialog).getByLabelText("Workload (tên service trong cluster)"),
      "web",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Kiểm tra metric" }),
    );
    await within(dialog).findByText(/Có metric/);
    await user.type(within(dialog).getByLabelText("Tag image mới"), "v2");
    const create = within(dialog).getByRole("button", { name: "Tạo rollout" });
    expect(create).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText("Header chọn nhóm"),
      "X-Beta",
    );
    await user.type(within(dialog).getByLabelText("Giá trị"), "1");
    await user.click(create);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      strategy: "ATTRIBUTE_SPLIT",
      controlMode: "udp-driven",
      trafficMatch: { header: "X-Beta", value: "1" },
    });
  });

  it("project chưa bật Progressive Delivery ⇒ nói rõ và không cho tạo", async () => {
    const { dialog } = await openServiceForm(null);
    expect(
      await within(dialog).findByText(/chưa bật domain Progressive Delivery/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Tạo rollout" }),
    ).toBeDisabled();
  });

  it("[Plan #58 UX-29] ô workload gợi ý workload đã deploy ở environment, vẫn gõ tay được", async () => {
    const world = setup("flagger");
    const arch = golden<{ architecture: ArchitectureWire }>(
      "GET /projects/{id}/architecture",
    );
    const first = arch.architecture.environments[0]!;
    arch.architecture.environments = [{ ...first, id: world.dev.id }];
    server.use(
      http.get(`${API}/projects/:id/architecture`, () =>
        HttpResponse.json(arch),
      ),
    );
    renderApp(
      `/app/projects/${world.detail.project.id}/rollouts?env=${world.dev.id}`,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Tạo rollout" }),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Theo phiên bản",
      }),
    );
    const input = await screen.findByLabelText(
      "Workload (tên service trong cluster)",
    );
    await waitFor(() => expect(input).toHaveAttribute("list"));
    const list = document.getElementById(input.getAttribute("list") ?? "");
    expect(
      [...(list?.querySelectorAll("option") ?? [])].map((o) => o.value),
    ).toEqual(first.workloads.map((w) => w.name));
    expect(input).toHaveAccessibleDescription(/đã deploy ở/);
    // Luật tên nói bằng lời thường, không dẫn tên chuẩn
    await user.type(input, "Web_1");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(/chữ thường, số, dấu gạch ngang/);
    expect(screen.queryByText(/DNS-1123/)).toBeNull();
  });

  it("[Plan #58 UX-39] lỗi theo ô của máy chủ nằm dưới đúng ô, gắn vào ô, và focus về ô lỗi đầu tiên", async () => {
    const { user, dialog } = await openServiceForm("flagger");
    server.use(
      http.post(`${API}/projects/:id/rollouts`, () =>
        HttpResponse.json(
          {
            type: "about:blank",
            title: "Validation failed",
            status: 400,
            errors: [
              { field: "thresholds.latencyP99Ms", message: "Quá lớn" },
              { field: "imageTag", message: "Không có tag này" },
            ],
            traceId: "t-1",
          },
          { status: 400 },
        ),
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "UDP quyết" }));
    await user.type(
      within(dialog).getByLabelText("Workload (tên service trong cluster)"),
      "web",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Kiểm tra metric" }),
    );
    await within(dialog).findByText(/Có metric/);
    const tag = within(dialog).getByLabelText("Tag image mới");
    await user.type(tag, "1.4.2");
    await user.click(
      within(dialog).getByRole("button", { name: "Tạo rollout" }),
    );

    await waitFor(() => expect(tag).toHaveAttribute("aria-invalid", "true"));
    expect(tag).toHaveAccessibleDescription(/Không có tag này/);
    const latency = within(dialog).getByLabelText("Độ trễ p99 tối đa (ms)");
    expect(latency).toHaveAttribute("aria-invalid", "true");
    expect(latency).toHaveAccessibleDescription(/Quá lớn/);
    // Ô lỗi đầu tiên theo thứ tự trên form nhận focus
    await waitFor(() => expect(tag).toHaveFocus());
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "sửa các ô được đánh dấu",
    );
  });
});

describe("trang chi tiết SERVICE_LEVEL", () => {
  it("nói bằng phiên bản; tool-driven không có Tạm dừng; lên 100% xác nhận bằng phiên bản mới", async () => {
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
    detail.project.myRole = "OWNER";
    const service: RolloutDetailWire = {
      ...rollout,
      projectId: detail.project.id,
      scope: "SERVICE_LEVEL",
      controlMode: "tool-driven",
      strategy: "CANARY",
      status: "IN_PROGRESS",
      workloadName: "web",
      versionOld: "v1",
      versionNew: "v2",
      baselinePercentage: 0,
    };
    delete service.flag;
    delete service.pendingIntent;
    server.use(
      http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
      http.get(`${API}/projects/:id/rollouts`, () =>
        HttpResponse.json({ rollouts: [] }),
      ),
      http.get(`${API}/projects/:id/rollouts/:rid`, () =>
        HttpResponse.json({ rollout: service }),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/rollouts/${service.id}`);
    const user = userEvent.setup();

    expect(
      await screen.findByText("Lưu lượng phiên bản mới"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Công cụ giao hàng tự phân tích và tự quyết"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tạm dừng" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Lên 100%" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Phiên bản v2 nhận 100% traffic."),
    ).toBeInTheDocument();
  });

  it("actionsFor: tool-driven bỏ Tạm dừng/Tiếp tục, giữ promote và rollback", () => {
    expect(actionsFor("IN_PROGRESS", "tool-driven")).toEqual([
      "PROMOTE",
      "ROLLBACK",
    ]);
    expect(actionsFor("PAUSED", "tool-driven")).toEqual([
      "PROMOTE",
      "ROLLBACK",
    ]);
    expect(actionsFor("IN_PROGRESS", "udp-driven")).toEqual([
      "PAUSE",
      "PROMOTE",
      "ROLLBACK",
    ]);
  });
});

describe("hướng dẫn cài middleware (§10.13)", () => {
  it("project Python nhận đúng middleware của provider Python (Plan #47), không còn câu 'chưa phát hành'", () => {
    render(
      <MetricsSetupGuide
        runtime="python"
        workload="web"
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText(/UDPMetricsMiddleware/)).toBeInTheDocument();
    expect(screen.queryByText(/chưa phát hành/)).toBeNull();
  });
});
