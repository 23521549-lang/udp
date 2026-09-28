import type {
  FlagDetailWire,
  FlagSummaryWire,
  ProjectDetailResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * [Plan #44] Sửa variant ở chi tiết flag (`PUT …/variants`) và hai nút vòng đời gửi key xác nhận
 * (máy chủ đòi 428 cho mọi đổi vòng đời — bản trước không gửi nên luôn hỏng).
 */

const BLUE = "b1111111-1111-4111-8111-111111111111";
const GREEN = "b2222222-2222-4222-8222-222222222222";

function setup(lifecycleStatus: "DRAFT" | "ACTIVE") {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = "OWNER";
  const dev = [...detail.environments]
    .sort((a, b) => a.rank - b.rank)
    .find((e) => !e.isProduction)!;
  const { flag } = golden<{ flag: FlagDetailWire }>(
    "GET /projects/{id}/flags/{id}",
  );
  flag.flagType = "STRING";
  flag.lifecycleStatus = lifecycleStatus;
  flag.variants = [
    { id: BLUE, key: "blue", value: "#00f" },
    { id: GREEN, key: "green", value: "#0f0" },
  ];
  flag.defaultVariantId = GREEN;
  const summary: FlagSummaryWire = {
    id: flag.id,
    key: flag.key,
    flagType: flag.flagType,
    description: null,
    lifecycleStatus,
    activatedAt: null,
    updatedAt: flag.updatedAt,
  };
  const puts: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [];
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/flags`, () =>
      HttpResponse.json({ flags: [summary], total: 1 }),
    ),
    http.get(`${API}/projects/:id/flags/:flagId`, () =>
      HttpResponse.json({ flag }),
    ),
    http.get(`${API}/projects/:id/flags/:flagId/stats`, () =>
      HttpResponse.json(golden("GET /projects/{id}/flags/{id}/stats")),
    ),
    http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
      HttpResponse.json({ updatedAt: flag.updatedAt, rules: [] }),
    ),
    http.put(
      `${API}/projects/:id/flags/:flagId/variants`,
      async ({ request }) => {
        puts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ flag });
      },
    ),
    http.patch(`${API}/projects/:id/flags/:flagId`, async ({ request }) => {
      patches.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ flag });
    }),
  );
  return { detail, flag, dev, puts, patches };
}

describe("sửa variant", () => {
  it("flag nháp: sửa giá trị, thêm variant ⇒ PUT giữ id cũ, variant mới không id, không cần key", async () => {
    const { detail, flag, dev, puts } = setup("DRAFT");
    renderApp(
      `/app/projects/${detail.project.id}/flags?env=${dev.id}&flag=${flag.id}`,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sửa variant" }),
    );
    const dialog = await screen.findByRole("dialog");
    const first = within(dialog).getByLabelText("Giá trị variant 1");
    await user.clear(first);
    await user.type(first, "#0000ff");
    await user.click(
      within(dialog).getByRole("button", { name: "Thêm variant" }),
    );
    await user.type(within(dialog).getByLabelText("Key variant 3"), "red");
    await user.type(within(dialog).getByLabelText("Giá trị variant 3"), "#f00");
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      lastKnownUpdatedAt: flag.updatedAt,
      variants: [
        { id: BLUE, key: "blue", value: "#0000ff" },
        { id: GREEN, key: "green", value: "#0f0" },
        { key: "red", value: "#f00" },
      ],
      defaultVariantKey: "green",
    });
  });

  it("flag đang phục vụ: Lưu khoá tới khi gõ đúng key; PUT mang confirmFlagKey", async () => {
    const { detail, flag, dev, puts } = setup("ACTIVE");
    renderApp(
      `/app/projects/${detail.project.id}/flags?env=${dev.id}&flag=${flag.id}`,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sửa variant" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("Mặc định: variant 1"));
    const save = within(dialog).getByRole("button", { name: "Lưu" });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/để lưu cho flag/), flag.key);
    await user.click(save);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      defaultVariantKey: "blue",
      confirmFlagKey: flag.key,
    });
  });
});

describe("nút vòng đời", () => {
  it("Kích hoạt đòi gõ key và gửi confirmFlagKey", async () => {
    const { detail, flag, dev, patches } = setup("DRAFT");
    renderApp(
      `/app/projects/${detail.project.id}/flags?env=${dev.id}&flag=${flag.id}`,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Kích hoạt" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Kích hoạt" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/để xác nhận/), flag.key);
    await user.click(confirm);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({
      lastKnownUpdatedAt: flag.updatedAt,
      lifecycleStatus: "ACTIVE",
      confirmFlagKey: flag.key,
    });
  });
});
