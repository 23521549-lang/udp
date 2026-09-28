import type {
  GoldenPathResponseWire,
  ProjectDetailResponseWire,
  RepoScanWire,
} from "@udp/shared-types/wire";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * [Plan #48] Trang Mã nguồn (§11): Golden Path cho project Create New, kết quả quét repo cho project
 * Import Existing, và thẻ "Sẵn sàng cho flag-level rollout" ở Tổng quan. Body lấy từ golden capture.
 */

function importing(role: "DEVELOPER" | "VIEWER"): ProjectDetailResponseWire {
  const detail = projectFixture(role);
  detail.project.creationMode = "IMPORT_EXISTING";
  detail.project.repoUrl = "https://github.com/acme/legacy-web";
  return detail;
}

describe("Golden Path (Create New)", () => {
  it("cây tệp: chọn tệp ⇒ xem nội dung; Tải .zip ⇒ một tệp zip tên theo slug", async () => {
    const detail = projectFixture("DEVELOPER");
    useProjectHandlers(detail);
    const tree = golden<GoldenPathResponseWire>(
      "GET /projects/{id}/golden-path",
    );
    server.use(
      http.get(`${API}/projects/:id/golden-path`, () =>
        HttpResponse.json(tree),
      ),
    );
    const created: Blob[] = [];
    // jsdom không có createObjectURL — gán hai hàm, không thay cả URL (router cần constructor của nó)
    const original = {
      create: URL.createObjectURL,
      revoke: URL.revokeObjectURL,
    };
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      if (blob instanceof Blob) created.push(blob);
      return "blob:udp";
    };
    URL.revokeObjectURL = () => undefined;
    onTestFinished(() => {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    });
    renderApp(`/app/projects/${detail.project.id}/code`);

    const list = await screen.findByLabelText("Tệp của Golden Path");
    const dockerfile = within(list).getByRole("button", { name: "Dockerfile" });
    await userEvent.click(dockerfile);
    expect(dockerfile).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Nội dung Dockerfile")).toHaveTextContent(
      "FROM python:3.12-slim",
    );
    for (const note of tree.notes) {
      expect(screen.getByText(note)).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("button", { name: "Tải .zip" }));
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("application/zip");
  });

  it("VIEWER ⇒ nói cần quyền, không gọi route (route đòi DEVELOPER)", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    renderApp(`/app/projects/${detail.project.id}/code`);
    expect(
      await screen.findByText("Cần quyền Lập trình viên"),
    ).toBeInTheDocument();
  });
});

describe("quét repo (Import Existing)", () => {
  it("chưa quét ⇒ nói vậy; DEVELOPER quét kèm token ⇒ kết quả, token không còn trong ô", async () => {
    const detail = importing("DEVELOPER");
    useProjectHandlers(detail);
    const scanned = golden<{ scan: RepoScanWire }>(
      "POST /projects/{id}/repo-scan",
    );
    const bodies: unknown[] = [];
    server.use(
      http.get(`${API}/projects/:id/repo-scan`, () =>
        HttpResponse.json({ scan: null }),
      ),
      http.post(`${API}/projects/:id/repo-scan`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(scanned);
      }),
    );
    renderApp(`/app/projects/${detail.project.id}/code`);

    expect(
      await screen.findByText("Chưa quét repo lần nào"),
    ).toBeInTheDocument();
    const token = screen.getByLabelText(
      "Token đọc repo (tuỳ chọn, cho repo riêng tư)",
    );
    await userEvent.type(token, "ghp_bi-mat");
    await userEvent.click(screen.getByRole("button", { name: "Quét repo" }));

    const results = await screen.findByLabelText("Kết quả quét");
    expect(bodies).toEqual([{ token: "ghp_bi-mat" }]);
    expect(token).toHaveValue("");
    expect(within(results).getByText("Dockerfile")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Sẵn sàng cho flag-level rollout"),
    ).toHaveTextContent(
      scanned.scan.flagLevelReady ? "Sẵn sàng" : "Chưa sẵn sàng",
    );
    // Đề xuất có tệp mẫu ⇒ mở xem được
    const withFile = scanned.scan.findings.find(
      (f) => f.suggestion?.file !== undefined,
    );
    if (withFile?.suggestion?.file !== undefined) {
      await userEvent.click(
        within(results).getByRole("button", {
          name: `Xem ${withFile.suggestion.file.path}`,
        }),
      );
      expect(
        screen.getByLabelText(`Mẫu ${withFile.suggestion.file.path}`),
      ).toBeInTheDocument();
    }
  });

  it("VIEWER thấy kết quả đã lưu nhưng không có nút quét", async () => {
    const detail = importing("VIEWER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/repo-scan`, () =>
        HttpResponse.json(golden("GET /projects/{id}/repo-scan")),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/code`);
    expect(await screen.findByLabelText("Kết quả quét")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quét repo" })).toBeNull();
  });
});

describe("Tổng quan: thẻ sẵn sàng cho flag-level rollout", () => {
  it("Import Existing chưa quét ⇒ nói chưa biết và dẫn tới trang Mã nguồn", async () => {
    const detail = importing("VIEWER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/repo-scan`, () =>
        HttpResponse.json({ scan: null }),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}`);
    const card = await screen.findByLabelText(
      "Sẵn sàng cho flag-level rollout",
    );
    expect(await within(card).findByText(/Chưa quét repo/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "xem trang Mã nguồn" }),
    ).toBeInTheDocument();
  });

  it("Import Existing đã quét, thiếu middleware ⇒ Chưa sẵn sàng kèm dòng thiếu", async () => {
    const detail = importing("VIEWER");
    useProjectHandlers(detail);
    const saved = golden<{ scan: RepoScanWire }>(
      "GET /projects/{id}/repo-scan",
    );
    server.use(
      http.get(`${API}/projects/:id/repo-scan`, () => HttpResponse.json(saved)),
    );
    renderApp(`/app/projects/${detail.project.id}`);
    const card = await screen.findByLabelText(
      "Sẵn sàng cho flag-level rollout",
    );
    expect(await within(card).findByText("Chưa sẵn sàng")).toBeInTheDocument();
    expect(
      within(card).getByText("Thiếu: Middleware đo của UDP"),
    ).toBeInTheDocument();
  });

  it("Create New ⇒ không có thẻ (Golden Path sẵn sàng từ đầu), không gọi repo-scan", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    renderApp(`/app/projects/${detail.project.id}`);
    await screen.findByLabelText("Cluster");
    expect(
      screen.queryByLabelText("Sẵn sàng cho flag-level rollout"),
    ).toBeNull();
  });
});
