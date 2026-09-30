import type {
  AdminPlatformWire,
  AdminSystemWire,
} from "@udp/shared-types/wire";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_LINKS,
  PLATFORM_NODES,
  serviceState,
} from "../src/features/admin/platform-architecture";
import { API, golden, server } from "./msw";
import { renderApp, USER } from "./render";

/**
 * [Plan #57 QĐ-7] Kiến trúc nền tảng UDP trong Bảng điều khiển: khối, cạnh ghi giao thức, sức khoẻ sống từ ba route
 * sẵn có, "Không rõ" khi tín hiệu vắng, bản bảng thay thế, chỉ PLATFORM_ADMIN. Body mock là golden của Service 1.
 */

const ADMIN = { ...USER, platformRole: "PLATFORM_ADMIN" as const };

const useAdminHandlers = (
  over: {
    system?: AdminSystemWire;
    platform?: { platform: AdminPlatformWire };
  } = {},
) =>
  server.use(
    http.get(`${API}/admin/system/health`, () =>
      HttpResponse.json(over.system ?? golden("GET /admin/system/health")),
    ),
    http.get(`${API}/admin/platform`, () =>
      HttpResponse.json(over.platform ?? golden("GET /admin/platform")),
    ),
    http.get(`${API}/admin/overview`, () =>
      HttpResponse.json(golden("GET /admin/overview")),
    ),
  );

describe("mô hình kiến trúc nền tảng", () => {
  const all = new Set(Object.values(PLATFORM_NODES).flat());

  it("mọi cạnh nối hai khối có trên sơ đồ, không cặp nào lặp", () => {
    for (const l of PLATFORM_LINKS) {
      expect(all.has(l.from) && all.has(l.to)).toBe(true);
    }
    const pairs = PLATFORM_LINKS.map((l) => `${l.from}>${l.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("đúng lời gọi trong mã: S1 đọc Prometheus của khách, S3 xin metrics và token qua S1", () => {
    const has = (from: string, to: string) =>
      PLATFORM_LINKS.some((l) => l.from === from && l.to === to);
    expect(has("s1", "prometheus")).toBe(true);
    expect(has("s3", "prometheus")).toBe(false);
    expect(has("s3", "s1")).toBe(true);
    expect(has("s3", "clusters")).toBe(true);
    expect(has("s3", "s2")).toBe(true);
  });

  it("sức khoẻ service theo tên; vắng tên hay chưa có dữ liệu là 'unknown'", () => {
    const system: AdminSystemWire = {
      services: [
        { name: "udp-core-backend", status: "up" },
        { name: "udp-feature-flag-service", status: "down" },
      ],
      database: "up",
      checkedAt: "2026-09-30T00:00:00.000Z",
    };
    expect(serviceState(system, "s1")).toBe("up");
    expect(serviceState(system, "s2")).toBe("down");
    expect(serviceState(system, "s3")).toBe("unknown");
    expect(serviceState(undefined, "s1")).toBe("unknown");
  });
});

describe("Bảng điều khiển: Kiến trúc nền tảng (/admin/architecture)", () => {
  it("khung máy, sáu khối trong máy, tám hệ bên ngoài, sức khoẻ sống và ba thanh ngân sách", async () => {
    useAdminHandlers();
    renderApp("/admin/architecture", { user: ADMIN });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Kiến trúc nền tảng",
      }),
    ).toBeInTheDocument();
    const map = await screen.findByRole("region", { name: /udp-vm/ });
    for (const name of [
      "Portal",
      "core-backend",
      "flag-service",
      "pd-controller",
      "PostgreSQL",
    ]) {
      // Mỗi khối trong máy là một thẻ có `data-node` (nhãn "PostgreSQL" còn ở thanh ngân sách)
      expect(
        within(map)
          .getAllByText(name)
          .some((el) => el.closest("[data-node]") !== null),
      ).toBe(true);
    }
    for (const name of [
      "Developer",
      "Nhà phát hành",
      "SDK trong ứng dụng",
      "Object Storage",
      "Pipeline CI",
      "Cloud của khách",
      "Prometheus của khách",
      "Cluster của khách",
    ]) {
      expect(within(map).getByText(name)).toBeInTheDocument();
    }
    // Golden: flag-service không phản hồi, pd-controller không rõ
    expect(
      (await screen.findByText("flag-service")).closest("[data-node]"),
    ).toHaveTextContent("Không phản hồi");
    expect(
      screen.getByText("pd-controller").closest("[data-node]"),
    ).toHaveTextContent("Không rõ");
    expect(
      screen.getAllByRole("meter").map((m) => m.getAttribute("aria-label")),
    ).toEqual(["CPU", "RAM", "PostgreSQL"]);
    expect(screen.getByText("0 đồng")).toBeInTheDocument();
  });

  it("tín hiệu của cụm không đọc được ⇒ 'Không rõ' kèm lý do, không đoán", async () => {
    const platform = golden<{ platform: AdminPlatformWire }>(
      "GET /admin/platform",
    );
    platform.platform.node = { state: "unavailable", reason: "NOT_IN_CLUSTER" };
    platform.platform.backup = { state: "unavailable", reason: "FORBIDDEN" };
    useAdminHandlers({ platform });
    renderApp("/admin/architecture", { user: ADMIN });

    expect(
      await screen.findByText("UDP không chạy trong Kubernetes (máy dev)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sao lưu hằng đêm").closest("[data-node]"),
    ).toHaveTextContent(
      // [Plan #58 UX-22] Lý do = nguyên nhân + việc cần làm
      "Thiếu quyền đọc trong Kubernetes: áp lại core-backend-rbac.yaml rồi tải lại trang",
    );
  });

  it("xem dạng bảng: khối và kết nối kèm giao thức", async () => {
    useAdminHandlers();
    renderApp("/admin/architecture", { user: ADMIN });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Xem dạng bảng" }),
    );

    const links = screen.getByRole("table", { name: "Kết nối" });
    const row = (from: string, to: string) =>
      within(links)
        .getAllByRole("row")
        .find((r) => {
          const cells = r.querySelectorAll("th, td");
          return cells[0]?.textContent === from && cells[1]?.textContent === to;
        });
    expect(row("SDK trong ứng dụng", "flag-service")).toHaveTextContent(
      "SSE · OFREP",
    );
    expect(row("core-backend", "Prometheus của khách")).toHaveTextContent(
      "metrics.query",
    );
    expect(row("pd-controller", "core-backend")).toHaveTextContent(
      "metrics · token",
    );
    const parts = screen.getByRole("table", { name: "Khối" });
    expect(
      within(parts).getByRole("row", { name: /flag-service/ }),
    ).toHaveTextContent("Không phản hồi");
  });

  it("người không phải PLATFORM_ADMIN không vào được", async () => {
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    const { router } = renderApp("/admin/architecture");
    await screen.findByRole("heading", { level: 1 });
    expect(router.state.location.pathname).toBe("/app/home");
  });
});
