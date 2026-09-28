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
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * Trả mục nợ `portal-config-promote`. Tiêu chí Đạt: diff hiện TRƯỚC khi áp. [Plan #44] Việc áp
 * nay là `POST …/promote` của Service 1, chạy CÙNG `planPromotion` (bộ test của hàm ở
 * `packages/shared-types/tests/promote.test.ts`; salt đích giữ nguyên ở
 * `flag-variants-promote.integration.test.ts`). Ở đây: Portal gửi đúng hai mốc (nguồn đã xem, đích
 * lúc mở hộp) và key xác nhận cho đích production; ô âm 409 ⇒ báo rõ, không đóng hộp.
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
const DST_A = "d0000000-0000-4000-8000-000000000001";

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
  const promotes: {
    fromEnvId: string;
    toEnvId: string;
    sourceUpdatedAt: string;
    lastKnownUpdatedAt: string;
    confirmFlagKey?: string;
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
    http.post(
      `${API}/projects/:id/flags/:flagId/promote`,
      async ({ request }) => {
        promotes.push((await request.json()) as (typeof promotes)[number]);
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
          diff: [
            {
              kind: "changed",
              index: 0,
              ruleType: "ATTRIBUTE_BASED",
              description: null,
              keptId: DST_A,
            },
          ],
          changes: 1,
        });
      },
    ),
  );
  return {
    detail,
    flag,
    dev,
    prod,
    promotes,
    setConflict: (v: boolean) => (conflict = v),
  };
}

describe("sao chép rule: dev → production qua Portal", () => {
  it("diff hiện trước; production đòi gõ key; POST mang hai mốc và key xác nhận", async () => {
    const { detail, flag, dev, prod, promotes } = setup();
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
    expect(promotes).toHaveLength(0);

    const apply = within(dialog).getByRole("button", { name: "Áp dụng" });
    expect(apply).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText(/để áp ở production/),
      flag.key,
    );
    await user.click(apply);
    await waitFor(() => expect(promotes).toHaveLength(1));
    expect(promotes[0]).toEqual({
      fromEnvId: dev.id,
      toEnvId: prod.id,
      sourceUpdatedAt: "2026-09-25T00:00:00.000Z",
      lastKnownUpdatedAt: "2026-09-25T00:30:00.000Z",
      confirmFlagKey: flag.key,
    });
  });

  it("ô âm: nguồn hoặc đích đổi từ lúc đọc ⇒ 409, báo rõ, không đóng hộp", async () => {
    const { detail, flag, dev, prod, promotes, setConflict } = setup();
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
    expect(promotes).toHaveLength(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
