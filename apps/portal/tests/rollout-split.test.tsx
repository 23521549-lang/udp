import type {
  FlagDetailWire,
  FlagSummaryWire,
  ProjectDetailResponseWire,
  RolloutDetailWire,
  RuleWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * [Plan #46] ATTRIBUTE_SPLIT ở mức flag (§7.2, §10.9): hộp tạo chỉ liệt kê rule theo thuộc tính/segment,
 * ẩn nhịp bậc và ngưỡng, gửi MỘT bậc; trang chi tiết nói hệ thống không tự quyết và nút PROMOTE là "đổi
 * mặc định".
 */

const ON = "c1111111-1111-4111-8111-111111111111";
const OFF = "c2222222-2222-4222-8222-222222222222";

function setup() {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = "OWNER";
  const dev = [...detail.environments]
    .sort((a, b) => a.rank - b.rank)
    .find((e) => !e.isProduction)!;
  const { flag } = golden<{ flag: FlagDetailWire }>(
    "GET /projects/{id}/flags/{id}",
  );
  flag.lifecycleStatus = "ACTIVE";
  flag.variants = [
    { id: ON, key: "on", value: true },
    { id: OFF, key: "off", value: false },
  ];
  const tpl = flag.envs[0]!;
  flag.envs = [
    {
      ...tpl,
      isEnabled: true,
      environment: { id: dev.id, name: dev.name, isProduction: false },
    },
  ];
  const summary: FlagSummaryWire = {
    id: flag.id,
    key: flag.key,
    flagType: flag.flagType,
    description: null,
    lifecycleStatus: "ACTIVE",
    activatedAt: null,
    updatedAt: flag.updatedAt,
  };
  const serve = {
    kind: "distribution" as const,
    weights: [
      { variantId: ON, weight: 0 },
      { variantId: OFF, weight: 100_000 },
    ],
  };
  const rules: RuleWire[] = [
    {
      id: "d1111111-1111-4111-8111-111111111111",
      priority: 10,
      ruleType: "ALL",
      condition: {},
      serve,
      description: "mọi người",
    },
    {
      id: "d2222222-2222-4222-8222-222222222222",
      priority: 20,
      ruleType: "ATTRIBUTE_BASED",
      condition: {
        all: [{ attribute: "country", operator: "eq", value: "VN" }],
      },
      serve,
      description: "người dùng VN",
    },
  ];
  const posts: Record<string, unknown>[] = [];
  const { rollout } = golden<{ rollout: RolloutDetailWire }>(
    "GET /projects/{id}/rollouts/{id}",
  );
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
    http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
      HttpResponse.json({ updatedAt: flag.updatedAt, rules }),
    ),
    http.post(`${API}/projects/:id/rollouts/probe`, () => {
      // Mẫu golden ghi ca "chưa có metric"; ở đây workload đã có
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
  return { detail, dev, flag, posts };
}

describe("tạo rollout ATTRIBUTE_SPLIT", () => {
  it("chỉ rule theo thuộc tính, không ô bậc/ngưỡng, gửi strategy và MỘT bậc 100%", async () => {
    const { detail, dev, flag, posts } = setup();
    renderApp(`/app/projects/${detail.project.id}/rollouts?env=${dev.id}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Tạo rollout" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Theo thuộc tính" }),
    );
    expect(
      within(dialog).queryByLabelText("Mỗi bậc tăng (%)"),
    ).not.toBeInTheDocument();

    await user.selectOptions(
      await within(dialog).findByLabelText("Flag (đang dùng)"),
      flag.id,
    );
    const ruleSelect = await within(dialog).findByLabelText(
      "Rule theo thuộc tính",
    );
    const options = within(ruleSelect)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options.some((t) => t.includes("người dùng VN"))).toBe(true);
    expect(options.some((t) => t.includes("mọi người"))).toBe(false);
    await user.selectOptions(
      ruleSelect,
      "d2222222-2222-4222-8222-222222222222",
    );
    await user.selectOptions(
      await within(dialog).findByLabelText("Variant mới cho nhóm khớp"),
      ON,
    );
    await user.type(within(dialog).getByLabelText(/Workload/), "checkout");
    await user.click(
      within(dialog).getByRole("button", { name: "Kiểm tra metric" }),
    );
    const create = within(dialog).getByRole("button", { name: "Tạo rollout" });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      strategy: "ATTRIBUTE_SPLIT",
      stepPercent: 100,
      targetVariantId: ON,
      targetingRuleId: "d2222222-2222-4222-8222-222222222222",
    });
  });
});

describe("chi tiết rollout ATTRIBUTE_SPLIT", () => {
  it("nói hệ thống không tự quyết; PROMOTE là đổi mặc định, có xác nhận", async () => {
    const { detail } = setup();
    const { rollout } = golden<{ rollout: RolloutDetailWire }>(
      "GET /projects/{id}/rollouts/{id}",
    );
    rollout.strategy = "ATTRIBUTE_SPLIT";
    rollout.status = "IN_PROGRESS";
    delete rollout.pendingIntent;
    server.use(
      http.get(`${API}/projects/:id/rollouts/:rid`, () =>
        HttpResponse.json({ rollout }),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/rollouts/${rollout.id}`);
    expect(
      await screen.findByText(/hệ thống không tự promote hay rollback/),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Đổi mặc định sang/ }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "không riêng nhóm khớp",
    );
  });
});
