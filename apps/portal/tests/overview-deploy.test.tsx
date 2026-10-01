import type {
  DeploymentWire,
  ProjectDetailResponseWire,
} from "@udp/shared-types/wire";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * [Plan #45] Tổng quan đủ §10.6 — thẻ Cluster (từ phong bì chi tiết project) và thẻ Deploy gần
 * nhất (`GET /deployments/latest`, khoá theo env) — và nhật ký một lần deploy ở trang Deploy.
 */

describe("Tổng quan: thẻ Cluster và Deploy gần nhất", () => {
  it("project có cluster ⇒ hiện địa chỉ; env đã deploy ⇒ image và link lịch sử", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    const { deployments } = golden<{ deployments: DeploymentWire[] }>(
      "GET /projects/{id}/deployments",
    );
    const latest = deployments[0]!;
    server.use(
      http.get(`${API}/projects/:id/deployments/latest`, () =>
        HttpResponse.json({ deployment: latest }),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}`);

    const cluster = await screen.findByLabelText("Cluster");
    expect(detail.cluster).not.toBeNull();
    expect(
      within(cluster).getByText(detail.cluster!.clusterId),
    ).toBeInTheDocument();
    const deploy = await screen.findByLabelText("Deploy gần nhất");
    expect(
      await within(deploy).findByText(
        latest.imageTag ?? latest.deploymentId.slice(0, 8),
      ),
    ).toBeInTheDocument();
    expect(
      within(deploy).getByRole("link", { name: "Xem lịch sử deploy" }),
    ).toBeInTheDocument();
  });

  it("project chưa có cluster, env chưa deploy ⇒ nói đúng điều đó", async () => {
    const detail: ProjectDetailResponseWire = {
      ...projectFixture("VIEWER"),
      cluster: null,
    };
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/deployments/latest`, () =>
        HttpResponse.json({ deployment: null }),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}`);

    expect(await screen.findByLabelText("Cluster")).toHaveTextContent(
      "Chưa có cluster",
    );
    const deploy = await screen.findByLabelText("Deploy gần nhất");
    expect(
      await within(deploy).findByText("Chưa có lần deploy nào."),
    ).toBeInTheDocument();
  });
});

describe("trang Deploy: nhật ký một lần deploy", () => {
  it("bấm Nhật ký ⇒ mọi sự kiện của lần đó, kèm chi tiết đã che", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    const logs = golden<{ deploymentId: string }>(
      "GET /projects/{id}/deployments/{id}/logs",
    );
    server.use(
      http.get(`${API}/projects/:id/deployments`, () =>
        HttpResponse.json(golden("GET /projects/{id}/deployments")),
      ),
      http.get(`${API}/projects/:id/metrics/dora`, () =>
        HttpResponse.json(golden("GET /projects/{id}/metrics/dora")),
      ),
      http.get(`${API}/projects/:id/deployments/:deploymentId/logs`, () =>
        HttpResponse.json(logs),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/deployments`);

    const [first] = await screen.findAllByRole("button", { name: "Nhật ký" });
    await userEvent.click(first!);
    const log = await screen.findByRole("list", {
      name: /Nhật ký deploy/,
    });
    expect(within(log).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(log).not.toHaveTextContent("ghp_should_hide");
  });
});

describe("trang Deploy: lượt vá image nền (Plan #61 QĐ-13)", () => {
  it("lần deploy do rebase theo lịch mang nhãn Vá image nền; lần thường thì không", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    const list = golden<{ deployments: DeploymentWire[] }>(
      "GET /projects/{id}/deployments",
    );
    const [first, ...rest] = list.deployments;
    server.use(
      http.get(`${API}/projects/:id/deployments`, () =>
        HttpResponse.json({
          deployments: [{ ...first!, rebase: true }, ...rest],
        }),
      ),
      http.get(`${API}/projects/:id/metrics/dora`, () =>
        HttpResponse.json(golden("GET /projects/{id}/metrics/dora")),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/deployments`);
    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0]!).getByText("Vá image nền")).toBeInTheDocument();
    for (const row of rows.slice(1)) {
      expect(within(row).queryByText("Vá image nền")).toBeNull();
    }
  });
});
