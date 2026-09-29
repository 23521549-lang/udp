import type {
  ProjectDetailResponseWire,
  PublicEnvironmentWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * Plan #40 AC-7 — tab Environment trong Cài đặt: danh sách từ `GET /projects/:id`, thêm (kèm
 * Idempotency-Key), bật production, xoá có gõ lại tên, và lỗi 409 hiện đúng lý do. Body lấy từ
 * golden capture của Service 1.
 */

const tab = (detail: ProjectDetailResponseWire) =>
  `/app/projects/${detail.project.id}/settings?tab=environments`;

function useEnvironmentHandlers(detail: ProjectDetailResponseWire) {
  const sent: {
    method: string;
    body: unknown;
    idempotencyKey: string | null;
  }[] = [];
  const created = golden<{ environment: PublicEnvironmentWire }>(
    "POST /projects/{id}/environments",
  );
  server.use(
    http.post(`${API}/projects/:id/environments`, async ({ request }) => {
      sent.push({
        method: "POST",
        body: await request.json(),
        idempotencyKey: request.headers.get("Idempotency-Key"),
      });
      // Lần đọc project kế tiếp thấy environment mới — như máy chủ thật
      detail.environments.push({ ...created.environment, name: "qa" });
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch(
      `${API}/projects/:id/environments/:envId`,
      async ({ request }) => {
        sent.push({
          method: "PATCH",
          body: await request.json(),
          idempotencyKey: null,
        });
        return HttpResponse.json(
          golden("PATCH /projects/{id}/environments/{id}"),
        );
      },
    ),
    http.delete(`${API}/projects/:id/environments/:envId`, () =>
      HttpResponse.json(
        {
          type: "https://udp.dev/problems/environment-has-history",
          title: "CONFLICT",
          status: 409,
          detail: "Environment đã có lịch sử (audit, deploy)",
          instance: "/api/v1/projects/x/environments/y",
          traceId: "t-1",
        },
        { status: 409 },
      ),
    ),
  );
  return { sent };
}

describe("tab Environment trong Cài đặt (Plan #40)", () => {
  it("OWNER: thấy mọi environment; thêm qa gửi đúng body kèm Idempotency-Key, danh sách làm mới", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const { sent } = useEnvironmentHandlers(detail);
    renderApp(tab(detail));

    const list = await screen.findByRole("region", { name: "Environment" });
    for (const e of detail.environments) {
      expect(within(list).getByText(e.k8sNamespace)).toBeInTheDocument();
    }
    await userEvent.type(
      screen.getByRole("textbox", { name: "Tên environment mới" }),
      "QA",
    );
    await userEvent.click(screen.getByRole("button", { name: "Thêm" }));

    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toMatchObject({
      method: "POST",
      body: { name: "qa", isProduction: false },
    });
    expect(sent[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await within(list).findByLabelText("qa là production"),
    ).toBeInTheDocument();
  });

  it("OWNER: bật production gửi PATCH chỉ một cờ", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const { sent } = useEnvironmentHandlers(detail);
    renderApp(tab(detail));

    const staging = detail.environments.find((e) => !e.isProduction);
    if (staging === undefined) throw new Error("mẫu thiếu env thường");
    await userEvent.click(
      await screen.findByLabelText(`${staging.name} là production`),
    );
    await waitFor(() => {
      expect(sent).toEqual([
        { method: "PATCH", body: { isProduction: true }, idempotencyKey: null },
      ]);
    });
  });

  it("OWNER: xoá đòi gõ lại tên; máy chủ từ chối vì có lịch sử ⇒ hộp thoại nói đúng lý do", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    useEnvironmentHandlers(detail);
    renderApp(tab(detail));

    const list = await screen.findByRole("region", { name: "Environment" });
    await userEvent.click(
      within(list).getAllByRole("button", { name: /^Xoá environment / })[0]!,
    );
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Xoá environment",
    });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByRole("textbox"),
      detail.environments[0]!.name,
    );
    await userEvent.click(confirm);

    expect(
      await within(dialog).findByText(/đã có lịch sử .* nên được giữ lại/),
    ).toBeInTheDocument();
  });

  it("VIEWER: không có form thêm, không nút xoá, cờ chỉ đọc", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    renderApp(tab(detail));

    const list = await screen.findByRole("region", { name: "Environment" });
    expect(
      screen.queryByRole("textbox", { name: "Tên environment mới" }),
    ).not.toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /^Xoá/ })).toBeNull();
    for (const box of within(list).getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
  });
});
