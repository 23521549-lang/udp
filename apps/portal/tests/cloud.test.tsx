import type { CloudAuthKindWire } from "@udp/shared-types/cloud-api";
import type {
  CloudSetupWire,
  ProjectDetailResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  buildBody,
  initialForm,
} from "../src/features/project/cloud/cloud-form";
import { ApiError } from "../src/lib/http";
import { messageOf, problemSlugOf } from "../src/lib/errors";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * Bước cloud (Plan #26 P7, AC-10): thẻ Cloud trong Cài đặt và bước 2 của wizard. Mọi body
 * lấy từ golden capture của Service 1.
 */

const FEDERATED_THEN_STATIC: Record<
  string,
  [CloudAuthKindWire, CloudAuthKindWire]
> = {
  AWS: ["AWS_ROLE", "AWS_KEY"],
  GCP: ["GCP_WIF", "GCP_KEY"],
  AZURE: ["AZURE_FEDERATED", "AZURE_SECRET"],
};

/**
 * Bộ capture giữ MỘT mẫu cho mỗi route, và mẫu `setup` là của một cloud. Cho cloud khác,
 * giữ nguyên hình dạng đã kiểm của mẫu, chỉ đổi nhãn cloud và `authKind` (federation
 * trước, khoá tĩnh sau — đúng thứ tự máy chủ trả).
 */
function setupFor(provider: string): { setup: CloudSetupWire } {
  const { setup } = golden<{ setup: CloudSetupWire }>(
    "GET /projects/{id}/cloud/setup",
  );
  const kinds = FEDERATED_THEN_STATIC[provider];
  if (kinds === undefined) throw new Error(`cloud lạ: ${provider}`);
  return {
    setup: {
      ...setup,
      provider: provider as CloudSetupWire["provider"],
      methods: setup.methods.map((m, i) => ({
        ...m,
        authKind: kinds[i] ?? m.authKind,
      })),
    },
  };
}

function useCloudHandlers(options: { configured: boolean }) {
  const puts: unknown[] = [];
  server.use(
    http.get(`${API}/projects/:id/cloud`, () =>
      HttpResponse.json(
        options.configured
          ? golden("GET /projects/{id}/cloud")
          : { cloud: null },
      ),
    ),
    http.get(`${API}/projects/:id/cloud/setup`, ({ request }) =>
      HttpResponse.json(
        setupFor(new URL(request.url).searchParams.get("provider") ?? "AWS"),
      ),
    ),
    http.put(`${API}/projects/:id/cloud`, async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json(golden("PUT /projects/{id}/cloud"));
    }),
    http.post(`${API}/projects/:id/cloud/preflight`, () =>
      HttpResponse.json(golden("POST /projects/{id}/cloud/preflight")),
    ),
    http.post(`${API}/projects/:id/cloud/validate`, () =>
      HttpResponse.json(golden("POST /projects/{id}/cloud/validate")),
    ),
  );
  return { puts };
}

const cloudTab = (detail: ProjectDetailResponseWire) =>
  `/app/projects/${detail.project.id}/settings?tab=cloud`;

describe("thẻ Cloud trong Cài đặt", () => {
  it("OWNER: thấy cấu hình đang dùng và kiểm quyền ra đúng danh sách thiếu", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    useCloudHandlers({ configured: true });
    renderApp(cloudTab(detail));

    expect(await screen.findByText("IAM role tin UDP")).toBeInTheDocument();
    expect(screen.getByText("5f756c4360c5")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Kiểm tra quyền" }),
    );
    const result = await screen.findByRole("status", {
      name: "Kết quả kiểm quyền",
    });
    expect(within(result).getByText("ec2:CreateVpc")).toBeInTheDocument();
    expect(
      within(result).getByText("ec2:ModifyVpcAttribute"),
    ).toBeInTheDocument();
  });

  it("OWNER: kiểm credential bị từ chối ⇒ hiện lý do của cloud", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    useCloudHandlers({ configured: true });
    renderApp(cloudTab(detail));
    await userEvent.click(
      await screen.findByRole("button", { name: "Kiểm tra credential" }),
    );
    expect(await screen.findByText(/AccessDenied/)).toBeInTheDocument();
  });

  it("OWNER: ARN sai định dạng bị chặn ngay ở trang, không gửi đi", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const { puts } = useCloudHandlers({ configured: false });
    renderApp(cloudTab(detail));
    await userEvent.type(
      await screen.findByLabelText("ARN của role"),
      "khong-phai-arn",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lưu cấu hình cloud" }),
    );
    expect(await screen.findByText("roleArn không hợp lệ")).toBeInTheDocument();
    expect(puts).toEqual([]);
  });

  it("OWNER: lưu gửi đúng body của máy chủ và xoá bí mật khỏi form", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const { puts } = useCloudHandlers({ configured: false });
    renderApp(cloudTab(detail));
    await userEvent.click(
      await screen.findByRole("button", { name: /Access key tĩnh/ }),
    );
    await userEvent.type(
      screen.getByLabelText("Access key ID"),
      "AKIAEXAMPLEEXAMPLE12",
    );
    await userEvent.type(
      screen.getByLabelText("Secret access key"),
      "bi-mat-rat-dai-cua-khach-hang",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lưu cấu hình cloud" }),
    );
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      mode: "BYOC",
      provider: "AWS",
      region: "ap-southeast-1",
      credential: {
        authKind: "AWS_KEY",
        accessKeyId: "AKIAEXAMPLEEXAMPLE12",
        secretAccessKey: "bi-mat-rat-dai-cua-khach-hang",
      },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Secret access key")).toHaveValue(""),
    );
  });

  it("MAINTAINER: xem được khối lệnh nhưng không có ô nhập và nút lưu", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useCloudHandlers({ configured: true });
    renderApp(cloudTab(detail));
    expect(
      await screen.findByLabelText("Việc cần làm bên cloud"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Lưu cấu hình cloud" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Kiểm tra quyền" })).toBeNull();
  });

  it("VIEWER: không gọi API cloud, chỉ nói vì sao", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    renderApp(cloudTab(detail));
    // Không có handler cloud: một request lọt đi là lỗi `onUnhandledRequest`
    expect(
      await screen.findByText(
        "Cấu hình cloud chỉ hiện với Maintainer và chủ sở hữu.",
      ),
    ).toBeInTheDocument();
  });
});

describe("wizard tạo project", () => {
  it("tạo xong ở lại bước 2 để kết nối cloud; Để sau thì mở project", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    useCloudHandlers({ configured: false });
    server.use(
      http.get(`${API}/projects/:id/flags`, () =>
        HttpResponse.json(golden("GET /projects/{id}/flags")),
      ),
      http.post(`${API}/projects`, () =>
        HttpResponse.json(detail, { status: 201 }),
      ),
    );
    const { router } = renderApp("/app/projects/new");
    await userEvent.type(
      await screen.findByLabelText("Tên project"),
      "cua-hang",
    );
    await userEvent.click(screen.getByRole("button", { name: "Tạo project" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Kết nối cloud" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Project chưa kết nối cloud nào."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Để sau" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/app/projects/${detail.project.id}`,
      ),
    );
  });
});

describe("form cloud (thuần)", () => {
  it("khoá JSON của GCP: chỉ bốn trường cần được gửi", () => {
    const form = {
      ...initialForm("GCP"),
      authKind: "GCP_KEY" as const,
      keyJson: JSON.stringify({
        type: "service_account",
        project_id: "demo-project",
        private_key_id: "khong-gui",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        client_email: "udp@demo-project.iam.gserviceaccount.com",
        client_id: "123",
      }),
    };
    const built = buildBody(form);
    expect(
      built.ok && built.body.mode === "BYOC" && built.body.credential,
    ).toEqual({
      authKind: "GCP_KEY",
      type: "service_account",
      project_id: "demo-project",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      client_email: "udp@demo-project.iam.gserviceaccount.com",
    });
  });

  it("JSON hỏng ⇒ lỗi ở ô khoá; MANAGED không mang credential", () => {
    expect(
      buildBody({ ...initialForm("GCP"), authKind: "GCP_KEY", keyJson: "{" }),
    ).toEqual({ ok: false, errors: { keyJson: "Không đọc được khoá JSON." } });
    expect(buildBody({ ...initialForm("AZURE"), mode: "MANAGED" })).toEqual({
      ok: true,
      body: { mode: "MANAGED", provider: "AZURE", region: "southeastasia" },
    });
  });
});

describe("slug lỗi", () => {
  const problemError = (type: string, status: number) =>
    new ApiError(
      "http",
      status,
      {
        type,
        title: "x",
        status,
        detail: "chi tiết của máy chủ",
        traceId: "t",
      },
      "x",
    );

  it("CSRF sai và cloud chưa cấu hình có câu riêng, không rơi về câu chung theo status", () => {
    expect(
      messageOf(problemError("https://udp.dev/problems/csrf-invalid", 403)),
    ).toBe("Phiên làm việc đã đổi. Tải lại trang rồi thử lại.");
    const notConfigured = problemError(
      "https://udp.dev/problems/cloud-not-configured",
      409,
    );
    expect(problemSlugOf(notConfigured)).toBe("cloud-not-configured");
    expect(messageOf(notConfigured)).toContain("chưa cấu hình cloud");
  });
});
