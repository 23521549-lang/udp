import type { ArchitectureWire } from "@udp/shared-types/wire";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { useLocaleStore } from "../src/i18n";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * [Plan #57] Góc "Tổng quan hệ thống" của trang Kiến trúc: mặc định, đủ vùng C4, sức khoẻ không chỉ màu, bấm thẻ mở
 * panel, bản bảng thay thế, RED của production và trạng thái chưa có nguồn metrics. Body mock là golden của
 * Service 1 (golden có Container Registry ổn, Monitoring lệch cấu hình, Logging lỗi; dev, staging, prod).
 */

const architecture = () =>
  golden<{ architecture: ArchitectureWire }>("GET /projects/{id}/architecture");

const useRed = (status: "ok" | "notEnabled" = "ok") =>
  server.use(
    http.get(`${API}/projects/:id/metrics/red`, () =>
      status === "ok"
        ? HttpResponse.json(golden("GET /projects/{id}/metrics/red"))
        : HttpResponse.json(
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

/** Thêm công cụ vào body golden — cùng hình với công cụ đã có, khác domain */
function withTools(
  body: { architecture: ArchitectureWire },
  domains: [domainType: string, displayName: string, toolId: string][],
) {
  const base = body.architecture.tools[0]!;
  for (const [domainType, displayName, toolId] of domains) {
    body.architecture.tools.push({
      ...base,
      key: `${domainType}:${toolId}`.toLowerCase(),
      domainType,
      displayName,
      toolId,
    });
  }
  return body;
}

describe("Kiến trúc: Tổng quan hệ thống (mặc định)", () => {
  it("đủ vùng C4, environment và workload, thẻ sức khoẻ bằng chữ; bấm thẻ ⇒ panel và ?tool=", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useRed();
    const { router } = renderApp(
      `/app/projects/${detail.project.id}/architecture`,
    );

    const tabs = await screen.findByRole("tablist", { name: "Góc nhìn" });
    expect(
      within(tabs).getByRole("tab", { name: "Tổng quan hệ thống" }),
    ).toHaveAttribute("aria-selected", "true");
    for (const zone of [
      "Giao hàng",
      "Lưu lượng",
      "Environment",
      "Dữ liệu",
      "Quan sát",
      "Quản trị",
    ]) {
      expect(
        await screen.findByRole("heading", { level: 3, name: zone }),
      ).toBeInTheDocument();
    }
    expect(screen.getByText("Người dùng cuối")).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "checkout-worker ở dev: mở trang Deploy",
      }),
    ).toHaveAttribute(
      "href",
      expect.stringMatching(
        new RegExp(`/app/projects/${detail.project.id}/deployments\\?env=`),
      ),
    );

    // Sức khoẻ bằng biểu tượng + chữ, cùng bảng với lưới sức khoẻ
    const logging = screen.getByRole("button", { name: /Logging/ });
    expect(logging).toHaveTextContent("Lỗi");
    expect(logging).toHaveClass("tone-error");
    expect(
      screen.getByRole("button", { name: /Monitoring/ }),
    ).toHaveTextContent("Lệch cấu hình");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Monitoring/ }));
    expect(router.state.location.search).toEqual({
      tool: "monitoring:prometheus-grafana",
    });
    expect(
      screen.getByRole("complementary", { name: "Công cụ Monitoring" }),
    ).toBeInTheDocument();
  });

  it("bốn con số: công cụ theo sức khoẻ, workload, deploy 14 ngày, RED của production", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useRed();
    renderApp(`/app/projects/${detail.project.id}/architecture`);

    const kpis = await screen.findByRole("region", { name: "Số liệu chính" });
    expect(kpis).toHaveTextContent("1 ổn, 1 cần xem, 1 lỗi");
    expect(kpis).toHaveTextContent("trên 3 environment");
    // Golden: 3 deploy thành công và 1 thất bại trong 14 ngày
    expect(kpis).toHaveTextContent("1 thất bại");
    expect(
      within(kpis).getByRole("heading", { name: "Deploy 14 ngày" }),
    ).toBeInTheDocument();
    // RED: p99 lấy workload chậm nhất, rate cộng qua workload
    expect(await within(kpis).findByText("p99 120 ms")).toBeInTheDocument();
    expect(kpis).toHaveTextContent("prod, 6 giờ qua");
  });

  it("chưa có nguồn metrics ⇒ thẻ nói vậy và dẫn tới trang Domain", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useRed("notEnabled");
    renderApp(`/app/projects/${detail.project.id}/architecture`);

    expect(
      await screen.findByText(/Chưa có nguồn metrics/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Bật ở trang Domain" }),
    ).toHaveAttribute("href", `/app/projects/${detail.project.id}/domains`);
  });

  it("xem dạng bảng: thành phần và kết nối; domain vắng thì cạnh nối qua", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useRed();
    const body = withTools(architecture(), [
      ["INGRESS", "Ingress", "ingress-nginx"],
      ["SERVICE_MESH", "Service Mesh", "istio"],
    ]);
    server.use(
      http.get(`${API}/projects/:id/architecture`, () =>
        HttpResponse.json(body),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/architecture`);

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Xem dạng bảng" }),
    );
    const components = screen.getByRole("table", { name: "Thành phần" });
    expect(
      within(components).getByRole("row", { name: /Logging/ }),
    ).toHaveTextContent("Lỗi");
    const connections = screen.getByRole("table", { name: "Kết nối" });
    const row = (from: string, to: string) =>
      within(connections)
        .getAllByRole("row")
        .find((r) => {
          const cells = r.querySelectorAll("th, td");
          return cells[0]?.textContent === from && cells[1]?.textContent === to;
        });
    expect(row("Người dùng cuối", "Ingress")).toHaveTextContent("HTTPS");
    expect(row("Ingress", "Service Mesh")).toHaveTextContent("định tuyến");
    expect(row("Service Mesh", "Environment")).toHaveTextContent("mTLS");
    // Không GitOps, không Progressive Delivery: registry nối thẳng environment
    expect(row("Container Registry", "Environment")).toHaveTextContent(
      "tag mới",
    );
    expect(row("Environment", "Logging")).toHaveTextContent("logs");

    await user.click(screen.getByRole("button", { name: "Xem dạng sơ đồ" }));
    expect(screen.queryByRole("table", { name: "Kết nối" })).toBeNull();
  });

  it("đổi góc nhìn ⇒ URL có view=infra và sơ đồ hạ tầng; quay lại thì bỏ view", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useRed();
    const { router } = renderApp(
      `/app/projects/${detail.project.id}/architecture`,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("tab", { name: "Hạ tầng & công cụ" }),
    );
    expect(router.state.location.search).toEqual({ view: "infra" });
    expect(
      await screen.findByRole("heading", { name: "AWS ap-southeast-1" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Tổng quan hệ thống" }));
    expect(router.state.location.search).toEqual({});
    expect(
      await screen.findByRole("heading", { level: 3, name: "Giao hàng" }),
    ).toBeInTheDocument();
  });

  it("tiếng Anh: khung không còn chữ Việt", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useRed();
    act(() => useLocaleStore.getState().setLocale("en"));
    renderApp(`/app/projects/${detail.project.id}/architecture`);

    expect(
      await screen.findByRole("heading", { level: 3, name: "Delivery" }),
    ).toBeInTheDocument();
    expect(screen.getByText("End users")).toBeInTheDocument();
    const kpis = screen.getByRole("region", { name: "Key figures" });
    expect(kpis).toHaveTextContent("1 healthy, 1 needs attention, 1 in error");
    expect(await within(kpis).findByText("p99 120 ms")).toBeInTheDocument();
    const map = document.querySelector(".sys-map");
    const clone = map?.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[translate=no]").forEach((n) => n.remove());
    expect(clone.textContent).not.toMatch(
      /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i,
    );
  });
});
