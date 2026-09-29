import type {
  AdminPlatformWire,
  ArchitectureWire,
  HomeWire,
  RedMetricsWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  backupVerdict,
  certificateVerdict,
  idleRisk,
} from "../src/features/admin/platform-model";
import { readableJobError } from "../src/features/admin/pages/AdminJobsPage";
import { dayLabel, formatBytes, lastDays } from "../src/lib/format";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp, USER } from "./render";

/**
 * [Plan #53 đợt d] Màn mới của hai khung: Trang chủ, Kiến trúc, Giám sát, Tổng quan project (thẻ
 * Cloud, lưới sức khoẻ, sơ đồ thu nhỏ) và Tổng quan của Bảng điều khiển. Body mock là golden của
 * Service 1 — cùng hình với response thật.
 */

const ADMIN = { ...USER, platformRole: "PLATFORM_ADMIN" as const };

describe("Trang chủ (/app/home)", () => {
  it("/app về /app/home; mỗi việc cần xử lý dẫn tới ĐÚNG chỗ sửa", async () => {
    const home = golden<{ home: HomeWire }>("GET /home");
    server.use(http.get(`${API}/home`, () => HttpResponse.json(home)));
    const { router } = renderApp("/app");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Chào Tester" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/app/home");

    const list = await screen.findByRole("list", { name: "Việc cần xử lý" });
    const link = (text: RegExp) =>
      within(list).getByText(text).closest("a")?.getAttribute("href");
    const p = home.home.attention[0]!.projectId;
    expect(link(/Deploy checkout-api chờ duyệt/)).toMatch(
      new RegExp(`/app/projects/${p}/deployments\\?env=`),
    );
    expect(link(/Domain LOGGING lỗi/)).toBe(
      `/app/projects/${p}/domains/LOGGING`,
    );
    expect(link(/Áp domain thất bại/)).toBe(`/app/projects/${p}/infra`);
    expect(link(/Project hết hạn trong 48 giờ/)).toBe(
      `/app/projects/${p}/settings?tab=project`,
    );
    expect(link(/Rollout checkout-api đang tạm dừng/)).toMatch(
      /\/rollouts\/b206bbe3-/,
    );
  });

  it("rollout đang chạy, thẻ project và deploy 14 ngày", async () => {
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    renderApp("/app/home");
    const rollouts = await screen.findByRole("list", {
      name: "Rollout đang chạy",
    });
    expect(within(rollouts).getByText("Tạm dừng")).toBeInTheDocument();
    expect(within(rollouts).getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("p-b06d9c31")).toBeInTheDocument();
    // Cột của mỗi ngày có tên đầy đủ để trình đọc màn hình đọc được
    expect(
      screen.getByRole("heading", { name: "Deploy 14 ngày" }),
    ).toBeInTheDocument();
  });

  it("chưa tham gia project nào ⇒ mời tạo project đầu tiên", async () => {
    server.use(
      http.get(`${API}/home`, () =>
        HttpResponse.json({
          home: {
            projects: [],
            rollouts: [],
            attention: [],
            deploys: [],
            generatedAt: new Date().toISOString(),
          },
        }),
      ),
    );
    renderApp("/app/home");
    expect(
      await screen.findByRole("link", { name: "Tạo project đầu tiên" }),
    ).toBeInTheDocument();
  });
});

describe("Tổng quan project: thẻ Cloud, lưới sức khoẻ, sơ đồ thu nhỏ", () => {
  it("OWNER thấy 'Đổi cloud'; lỗi đứng đầu lưới; sơ đồ thu nhỏ dẫn sang Kiến trúc", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    renderApp(`/app/projects/${detail.project.id}`);

    const cloud = await screen.findByRole("region", { name: "Cloud" });
    expect(await within(cloud).findByText("AWS")).toBeInTheDocument();
    expect(
      within(cloud).getByRole("link", { name: "Đổi cloud" }),
    ).toHaveAttribute(
      "href",
      `/app/projects/${detail.project.id}/settings?tab=cloud`,
    );

    const grid = screen.getByRole("list", { name: "Sức khoẻ domain" });
    const cells = within(grid).getAllByRole("link");
    expect(cells[0]).toHaveTextContent("Logging");
    expect(cells[0]).toHaveTextContent("Lỗi");
    expect(cells[1]).toHaveTextContent("Lệch cấu hình");

    expect(
      screen.getByRole("link", { name: /Mở sơ đồ đầy đủ/ }),
    ).toHaveAttribute(
      "href",
      `/app/projects/${detail.project.id}/architecture`,
    );
  });

  it("MAINTAINER chỉ xem cấu hình cloud; VIEWER không có nút", async () => {
    const maintainer = projectFixture("MAINTAINER");
    useProjectHandlers(maintainer);
    const view = renderApp(`/app/projects/${maintainer.project.id}`);
    const cloud = await screen.findByRole("region", { name: "Cloud" });
    expect(
      await within(cloud).findByRole("link", { name: "Xem cấu hình cloud" }),
    ).toBeInTheDocument();
    view.unmount();

    const viewer = projectFixture("VIEWER");
    useProjectHandlers(viewer);
    renderApp(`/app/projects/${viewer.project.id}`);
    const cloud2 = await screen.findByRole("region", { name: "Cloud" });
    await within(cloud2).findByText("AWS");
    expect(within(cloud2).queryByRole("link")).toBeNull();
  });
});

describe("Kiến trúc", () => {
  it("khung lồng nhau đọc được; bấm công cụ ⇒ panel kể quan hệ bằng chữ, URL giữ ?tool=", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    const { router } = renderApp(
      `/app/projects/${detail.project.id}/architecture`,
    );

    expect(
      await screen.findByRole("heading", {
        name: "AWS ap-southeast-1",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mạng" })).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Workload ở dev" }),
    ).toHaveTextContent("checkout-worker");
    expect(
      screen.getByText("Chưa có workload nào deploy qua UDP."),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Monitoring/ }));
    expect(router.state.location.search).toMatchObject({
      tool: "monitoring:prometheus-grafana",
    });
    const panel = screen.getByRole("complementary", {
      name: "Công cụ Monitoring",
    });
    expect(within(panel).getByText("registry.oci")).toBeInTheDocument();
    // Bấm quan hệ ⇒ chọn công cụ kia
    await user.click(
      within(panel).getByRole("button", { name: "Container Registry" }),
    );
    expect(
      await screen.findByRole("complementary", {
        name: "Công cụ Container Registry",
      }),
    ).toHaveTextContent("Monitoring dùng");
    expect(
      screen.getByRole("button", { name: /Container Registry/, pressed: true }),
    ).toBeInTheDocument();
  });

  it("danh sách phụ thuộc bằng chữ; tổ hợp không hợp lệ ⇒ nói rõ, không vẽ cạnh", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    const body = golden<{ architecture: ArchitectureWire }>(
      "GET /projects/{id}/architecture",
    );
    body.architecture.valid = false;
    body.architecture.edges = [];
    server.use(
      http.get(`${API}/projects/:id/architecture`, () =>
        HttpResponse.json(body),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/architecture?tool=nope`);
    expect(
      await screen.findByText(/chưa qua kiểm tra, nên chưa có thứ tự deploy/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Phụ thuộc dạng danh sách/)).toBeNull();
    // Công cụ lạ trên URL không mở panel rỗng
    expect(
      screen.queryByRole("complementary", { name: /^Công cụ/ }),
    ).toBeNull();
  });
});

describe("Giám sát", () => {
  const useMonitoringHandlers = () => {
    server.use(
      http.get(`${API}/projects/:id/metrics/dora`, () =>
        HttpResponse.json(golden("GET /projects/{id}/metrics/dora")),
      ),
      http.get(`${API}/projects/:id/cost`, () =>
        HttpResponse.json(golden("GET /projects/{id}/cost")),
      ),
    );
  };

  it("mỗi workload ba biểu đồ; lệnh port-forward cho Grafana trong cụm; đổi khoảng ⇒ URL và query mới", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useMonitoringHandlers();
    const ranges: string[] = [];
    server.use(
      http.get(`${API}/projects/:id/metrics/red`, ({ request }) => {
        ranges.push(new URL(request.url).searchParams.get("range") ?? "");
        return HttpResponse.json(golden("GET /projects/{id}/metrics/red"));
      }),
    );
    const { router } = renderApp(
      `/app/projects/${detail.project.id}/monitoring`,
    );

    const api = await screen.findByRole("region", {
      name: "Workload checkout-api",
    });
    expect(
      within(api)
        .getAllByRole("heading", { level: 4 })
        .map((h) => h.textContent),
    ).toEqual(["Request mỗi giây", "Tỉ lệ lỗi 5xx", "Độ trễ p99"]);
    expect(
      screen.getByText(/kubectl -n udp-system port-forward/),
    ).toBeInTheDocument();
    expect(ranges).toEqual(["6h"]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "24 giờ" }));
    await waitFor(() => expect(ranges).toContain("24h"));
    expect(router.state.location.search).toMatchObject({ range: "24h" });
    // Chi phí chỉ MAINTAINER trở lên thấy
    expect(
      await screen.findByRole("heading", { name: "Chi phí 30 ngày" }),
    ).toBeInTheDocument();
  });

  it("chưa có nguồn metrics (409) ⇒ nói cách bật, phần còn lại vẫn hiện; VIEWER không thấy chi phí", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useMonitoringHandlers();
    server.use(
      http.get(`${API}/projects/:id/metrics/red`, () =>
        HttpResponse.json(
          {
            type: "https://udp.dev/problems/metrics-not-enabled",
            title: "Metrics not enabled",
            status: 409,
            traceId: "t-1",
          },
          { status: 409 },
        ),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/monitoring`);
    expect(
      await screen.findByText("Chưa có nguồn metrics"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("list", { name: "Sức khoẻ domain" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Chi phí/ })).toBeNull();
  });

  it("nguồn SaaS ⇒ nút mở công cụ ở trang mới", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useMonitoringHandlers();
    const body = golden<{ metrics: RedMetricsWire }>(
      "GET /projects/{id}/metrics/red",
    );
    body.metrics.console = {
      kind: "url",
      label: "Mở Datadog",
      url: "https://app.datadoghq.eu",
    };
    server.use(
      http.get(`${API}/projects/:id/metrics/red`, () =>
        HttpResponse.json(body),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/monitoring`);
    const open = await screen.findByRole("link", { name: /Mở Datadog/ });
    expect(open).toHaveAttribute("href", "https://app.datadoghq.eu");
    expect(open).toHaveAttribute("target", "_blank");
  });
});

describe("Bảng điều khiển: Tổng quan", () => {
  const useAdminHandlers = (platform?: AdminPlatformWire) => {
    server.use(
      http.get(`${API}/admin/overview`, () =>
        HttpResponse.json(golden("GET /admin/overview")),
      ),
      http.get(`${API}/admin/platform`, () =>
        HttpResponse.json(
          platform === undefined ? golden("GET /admin/platform") : { platform },
        ),
      ),
      http.get(`${API}/admin/system/health`, () =>
        HttpResponse.json(golden("GET /admin/system/health")),
      ),
      http.get(`${API}/admin/jobs`, () =>
        HttpResponse.json(golden("GET /admin/jobs")),
      ),
    );
  };

  it("/admin về /admin/overview: máy, database so với ổ, sao lưu, chứng chỉ, số liệu nền tảng", async () => {
    useAdminHandlers();
    const { router } = renderApp("/admin", { user: ADMIN });
    const machine = await screen.findByRole("region", { name: "Máy" });
    expect(router.state.location.pathname).toBe("/admin/overview");
    expect(within(machine).getByText("udp-vm")).toBeInTheDocument();
    expect(within(machine).getByRole("meter", { name: "CPU" })).toHaveAttribute(
      "aria-valuemax",
      "2",
    );
    expect(screen.getByRole("region", { name: "Sao lưu" })).toHaveTextContent(
      "Đều đặn",
    );
    expect(
      screen.getByRole("region", { name: "Bản phát hành" }),
    ).toHaveTextContent("Không khai UDP_RELEASE");
    expect(
      await screen.findByRole("meter", { name: "Dữ liệu trên ổ PostgreSQL" }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText("53")).length).toBeGreaterThan(0);
  });

  it("tín hiệu không đọc được ⇒ nói lý do, không đoán", async () => {
    const platform = golden<{ platform: AdminPlatformWire }>(
      "GET /admin/platform",
    ).platform;
    useAdminHandlers({
      ...platform,
      node: { state: "unavailable", reason: "NOT_IN_CLUSTER" },
      certificate: { state: "unavailable", reason: "FORBIDDEN" },
    });
    renderApp("/admin/overview", { user: ADMIN });
    expect(
      await screen.findByText("UDP không chạy trong Kubernetes (máy dev)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ServiceAccount của Service 1 thiếu quyền đọc"),
    ).toBeInTheDocument();
  });
});

describe("danh sách quản trị: trang và bộ lọc trên URL", () => {
  it("người dùng: sang trang sau ⇒ offset lên URL và lên request", async () => {
    const offsets: string[] = [];
    const users = golden<{ users: unknown[]; total: number }>(
      "GET /admin/users",
    );
    server.use(
      http.get(`${API}/admin/users`, ({ request }) => {
        offsets.push(new URL(request.url).searchParams.get("offset") ?? "");
        return HttpResponse.json({ ...users, total: 130 });
      }),
    );
    const { router } = renderApp("/admin/users", { user: ADMIN });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Trang sau/ }));
    await waitFor(() => expect(offsets).toContain("50"));
    expect(router.state.location.search).toMatchObject({ offset: 50 });
  });

  it("job lỗi: trạng thái bằng chữ, lỗi đọc được, trạng thái lên URL", async () => {
    const states: string[] = [];
    server.use(
      http.get(`${API}/admin/jobs`, ({ request }) => {
        states.push(new URL(request.url).searchParams.get("state") ?? "");
        return HttpResponse.json({
          jobs: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              jobType: "PROVISION",
              state: "FAILED",
              attempt: 2,
              lastError: {
                step: "CLUSTER",
                message: "Hết hạn mức vCPU của vùng",
                orphans: ["eip-1"],
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              project: {
                id: "22222222-2222-4222-8222-222222222222",
                name: "shop",
              },
            },
          ],
          total: 1,
        });
      }),
    );
    const { router } = renderApp("/admin/jobs", { user: ADMIN });
    // Câu đọc được nằm ngoài khối "Chi tiết kỹ thuật" (JSON thô vẫn giữ để không mất gì)
    expect(
      await screen.findByText(/Hết hạn mức vCPU của vùng/, { selector: "p" }),
    ).toHaveTextContent("Còn 1 tài nguyên chưa dọn.");
    expect(screen.getByText("Dựng hạ tầng")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Dọn chưa hết tài nguyên" }),
    );
    await waitFor(() => expect(states).toContain("COMPENSATION_FAILED"));
    expect(router.state.location.search).toMatchObject({
      state: "COMPENSATION_FAILED",
    });
  });
});

describe("mô hình thuần của các màn mới", () => {
  const NOW = Date.parse("2026-09-30T00:00:00Z");
  const DAY = 86_400_000;

  it("nguy cơ bị thu hồi chỉ khi CPU VÀ RAM lúc này đều dưới 20%", () => {
    const node = {
      state: "ok" as const,
      name: "vm",
      cpuCores: 2,
      cpuUsedCores: 0.2,
      memoryBytes: 1000,
      memoryUsedBytes: 100,
    };
    expect(idleRisk(node).tone).toBe("warn");
    expect(idleRisk({ ...node, memoryUsedBytes: 500 }).tone).toBe("ok");
    expect(idleRisk(node).text).toMatch(/^Lúc này/);
  });

  it("sao lưu: lần hỏng mới hơn lần thành công là lỗi; quá 2 ngày là cảnh báo", () => {
    const b = {
      state: "ok" as const,
      schedule: "0 3 * * *",
      lastScheduleAt: null,
      lastSuccessAt: new Date(NOW - DAY).toISOString(),
      lastFailureAt: null,
    };
    expect(backupVerdict(b, NOW).tone).toBe("ok");
    expect(
      backupVerdict(
        { ...b, lastFailureAt: new Date(NOW - 1000).toISOString() },
        NOW,
      ).tone,
    ).toBe("error");
    expect(
      backupVerdict(
        { ...b, lastSuccessAt: new Date(NOW - 3 * DAY).toISOString() },
        NOW,
      ).tone,
    ).toBe("warn");
    expect(backupVerdict({ ...b, lastSuccessAt: null }, NOW).tone).toBe("warn");
  });

  it("chứng chỉ: chưa sẵn sàng hay hết hạn là lỗi; dưới 14 ngày là cảnh báo", () => {
    const c = {
      state: "ok" as const,
      name: "udp-tls",
      ready: true,
      notAfter: new Date(NOW + 60 * DAY).toISOString(),
      issuer: "le",
    };
    expect(certificateVerdict(c, NOW).tone).toBe("ok");
    expect(certificateVerdict({ ...c, ready: false }, NOW).tone).toBe("error");
    expect(
      certificateVerdict(
        { ...c, notAfter: new Date(NOW + 5 * DAY).toISOString() },
        NOW,
      ).tone,
    ).toBe("warn");
  });

  it("lỗi job: khuôn {step, message, orphans} đọc được; dạng khác rơi về chi tiết kỹ thuật", () => {
    expect(
      readableJobError({ step: "NETWORK", message: "x", orphans: ["a", "b"] }),
    ).toEqual({ step: "NETWORK", message: "x", orphans: 2 });
    expect(readableJobError({ code: 1 })).toBeNull();
    expect(readableJobError("boom")).toBeNull();
    expect(readableJobError(null)).toBeNull();
  });

  it("ngày lịch không bị múi giờ đẩy sang ngày bên cạnh; ổ đĩa tính bằng GiB", () => {
    expect(dayLabel("2026-09-29").short).toBe("29/9");
    expect(lastDays(3, new Date(2026, 8, 1, 12))).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
    ]);
    expect(formatBytes(20 * 1024 ** 3)).toBe("20 GiB");
    expect(formatBytes(4 * 1024 * 1024)).toBe("4 MiB");
  });
});
