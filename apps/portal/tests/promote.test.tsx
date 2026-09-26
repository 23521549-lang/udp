import type {
  FlagDetailWire,
  FlagSummaryWire,
  ProjectDetailResponseWire,
  RuleWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { planPromotion, stableJson } from "../src/features/flag/promote-model";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * Trả mục nợ `portal-config-promote`. Tiêu chí Đạt: diff hiện TRƯỚC khi áp, và
 * `bucket_salt` của env đích không đổi — Portal giữ salt bằng cách gửi lại `id` của rule
 * ĐÍCH (server giữ salt theo `id`, đã chứng minh ở `rule-replace.integration.test.ts`).
 * Ô âm: env đích đổi từ lúc đọc ⇒ 409, không gì bị ghi đè.
 */

const VAR_ON = "11111111-1111-4111-8111-111111111111";
const VAR_OFF = "22222222-2222-4222-8222-222222222222";

const rule = (
  id: string,
  priority: number,
  over: Partial<RuleWire> = {},
): RuleWire => ({
  id,
  priority,
  ruleType: "ATTRIBUTE_BASED",
  condition: { all: [{ attribute: "country", operator: "eq", value: "VN" }] },
  serve: { kind: "variant", variantId: VAR_ON },
  description: null,
  ...over,
});

const SRC_A = "a0000000-0000-4000-8000-000000000001";
const SRC_B = "a0000000-0000-4000-8000-000000000002";
const DST_A = "d0000000-0000-4000-8000-000000000001";
const DST_X = "d0000000-0000-4000-8000-000000000009";

describe("mô hình sao chép rule", () => {
  it("rule khớp (cùng loại + điều kiện) mang id của rule ĐÍCH, không bao giờ id nguồn", () => {
    const source = [
      rule(SRC_A, 10, {
        serve: {
          kind: "distribution",
          weights: [
            { variantId: VAR_OFF, weight: 50_000 },
            { variantId: VAR_ON, weight: 50_000 },
          ],
        },
      }),
      rule(SRC_B, 20, { ruleType: "ALL", condition: {} }),
    ];
    const target = [
      // cùng điều kiện nhưng khoá theo thứ tự khác — vẫn là một điều kiện
      rule(DST_A, 10, {
        condition: {
          all: [{ value: "VN", operator: "eq", attribute: "country" }],
        },
      }),
      rule(DST_X, 20, {
        ruleType: "USER_BASED",
        condition: { userIds: ["u1"] },
      }),
    ];
    const plan = planPromotion(source, target, "2026-09-25T01:00:00.000Z");
    const ids = plan.body.rules.map((r) => r.id);
    expect(ids).toEqual([DST_A, undefined]);
    expect(JSON.stringify(plan.body)).not.toContain(SRC_A);
    expect(JSON.stringify(plan.body)).not.toContain(SRC_B);
    expect(plan.body.lastKnownUpdatedAt).toBe("2026-09-25T01:00:00.000Z");
    expect(plan.diff.map((d) => d.kind)).toEqual([
      "changed",
      "added",
      "removed",
    ]);
    expect(plan.changes).toBe(3);
  });

  it("đích đã giống hệt ⇒ 0 thay đổi", () => {
    const plan = planPromotion([rule(SRC_A, 10)], [rule(DST_A, 10)], "x");
    expect(plan.changes).toBe(0);
    expect(plan.body.rules[0]?.id).toBe(DST_A);
  });

  it("stableJson không phụ thuộc thứ tự khoá", () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });
});

function setup() {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = "OWNER";
  const ordered = [...detail.environments].sort((a, b) => a.rank - b.rank);
  const dev = ordered.find((e) => !e.isProduction)!;
  const prod = ordered.find((e) => e.isProduction)!;
  const { flag } = golden<{ flag: FlagDetailWire }>(
    "GET /projects/{id}/flags/{id}",
  );
  flag.lifecycleStatus = "ACTIVE";
  flag.variants = [
    { id: VAR_ON, key: "on", value: true },
    { id: VAR_OFF, key: "off", value: false },
  ];
  const tpl = flag.envs[0]!;
  flag.envs = ordered.map((e) => ({
    ...tpl,
    environment: { id: e.id, name: e.name, isProduction: e.isProduction },
  }));
  const summary: FlagSummaryWire = {
    id: flag.id,
    key: flag.key,
    flagType: flag.flagType,
    description: null,
    lifecycleStatus: "ACTIVE",
    activatedAt: null,
    updatedAt: flag.updatedAt,
  };
  const rulesByEnv: Record<string, { updatedAt: string; rules: RuleWire[] }> = {
    [dev.id]: {
      updatedAt: "2026-09-25T00:00:00.000Z",
      rules: [rule(SRC_A, 10)],
    },
    [prod.id]: {
      updatedAt: "2026-09-25T00:30:00.000Z",
      rules: [
        rule(DST_A, 10, { serve: { kind: "variant", variantId: VAR_OFF } }),
      ],
    },
  };
  const puts: {
    envId: string;
    body: { lastKnownUpdatedAt: string; rules: { id?: string }[] };
  }[] = [];
  let conflict = false;
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
    http.get(
      `${API}/projects/:id/flags/:flagId/envs/:envId/rules`,
      ({ params }) =>
        HttpResponse.json(
          rulesByEnv[params.envId as string] ?? {
            updatedAt: flag.updatedAt,
            rules: [],
          },
        ),
    ),
    http.put(
      `${API}/projects/:id/flags/:flagId/envs/:envId/rules`,
      async ({ params, request }) => {
        const body = (await request.json()) as (typeof puts)[number]["body"];
        puts.push({ envId: params.envId as string, body });
        if (conflict) {
          return HttpResponse.json(
            {
              title: "Resource was modified by someone else",
              status: 409,
              code: "OPTIMISTIC_LOCK",
              traceId: "t",
            },
            { status: 409 },
          );
        }
        return HttpResponse.json({
          updatedAt: new Date().toISOString(),
          rules: rulesByEnv[prod.id]!.rules,
        });
      },
    ),
  );
  return {
    detail,
    flag,
    dev,
    prod,
    puts,
    setConflict: (v: boolean) => (conflict = v),
  };
}

describe("sao chép rule: dev → production qua Portal", () => {
  it("diff hiện trước; production đòi gõ key; PUT mang id ĐÍCH và mốc của ĐÍCH", async () => {
    const { detail, flag, dev, prod, puts } = setup();
    renderApp(
      `/app/projects/${detail.project.id}/flags?env=${dev.id}&flag=${flag.id}`,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sao chép sang..." }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(
      within(dialog).getByLabelText("Sang environment"),
      prod.id,
    );

    const table = await within(dialog).findByRole("table", {
      name: "Thay đổi sẽ áp",
    });
    expect(within(table).getByText("Đổi")).toBeInTheDocument();
    expect(within(table).getByText("giữ nguyên")).toBeInTheDocument();
    expect(puts).toHaveLength(0);

    const apply = within(dialog).getByRole("button", { name: "Áp dụng" });
    expect(apply).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText(/để áp ở production/),
      flag.key,
    );
    await user.click(apply);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.envId).toBe(prod.id);
    expect(puts[0]!.body.lastKnownUpdatedAt).toBe("2026-09-25T00:30:00.000Z");
    expect(puts[0]!.body.rules.map((r) => r.id)).toEqual([DST_A]);
  });

  it("ô âm: env đích đổi từ lúc đọc ⇒ 409, báo rõ, không đóng hộp", async () => {
    const { detail, flag, dev, prod, puts, setConflict } = setup();
    setConflict(true);
    renderApp(
      `/app/projects/${detail.project.id}/flags?env=${dev.id}&flag=${flag.id}`,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sao chép sang..." }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(
      within(dialog).getByLabelText("Sang environment"),
      prod.id,
    );
    await within(dialog).findByRole("table", { name: "Thay đổi sẽ áp" });
    await user.type(
      within(dialog).getByLabelText(/để áp ở production/),
      flag.key,
    );
    await user.click(within(dialog).getByRole("button", { name: "Áp dụng" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "vừa được người khác sửa",
    );
    expect(puts).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
