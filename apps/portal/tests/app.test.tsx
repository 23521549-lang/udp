import type {
  FlagDetailWire,
  FlagSummaryWire,
  ProjectDetailResponseWire,
  RulesResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { safeRedirect } from "../src/features/auth/AuthPages";
import { defaultEnvOf } from "../src/features/project/env";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * Test đi qua cả ứng dụng: router thật, guard thật, React Query thật. Body của mọi
 * handler lấy từ golden capture của Service 1 — test không tự nghĩ ra hình response.
 */

function projectFixture(role: "OWNER" | "MAINTAINER" | "DEVELOPER" | "VIEWER") {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = role;
  return detail;
}

const envOf = (d: ProjectDetailResponseWire, production: boolean) => {
  const e = d.environments.find((x) => x.isProduction === production);
  if (e === undefined) throw new Error("mẫu thiếu environment");
  return e;
};

/** Một flag ACTIVE có cấu hình ở mọi env của project mẫu */
function flagFixture(detail: ProjectDetailResponseWire): {
  flag: FlagDetailWire;
  summary: FlagSummaryWire;
} {
  const { flag } = golden<{ flag: FlagDetailWire }>(
    "GET /projects/{id}/flags/{id}",
  );
  flag.lifecycleStatus = "ACTIVE";
  const template = flag.envs[0];
  if (template === undefined) throw new Error("mẫu flag thiếu env");
  flag.envs = detail.environments.map((e, i) => ({
    ...template,
    environment: { id: e.id, name: e.name, isProduction: e.isProduction },
    configId: `${template.configId.slice(0, 35)}${String(i)}`,
    isEnabled: false,
  }));
  const summary: FlagSummaryWire = {
    id: flag.id,
    key: flag.key,
    flagType: flag.flagType,
    description: flag.description,
    lifecycleStatus: flag.lifecycleStatus,
    activatedAt: flag.activatedAt,
    updatedAt: flag.updatedAt,
    env: {
      configId: template.configId,
      isEnabled: false,
      isTracked: false,
      ruleCount: 0,
    },
  };
  return { flag, summary };
}

function useProjectHandlers(detail: ProjectDetailResponseWire) {
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/members`, () =>
      HttpResponse.json(golden("GET /projects/{id}/members")),
    ),
  );
}

describe("đăng nhập và guard", () => {
  it("chưa đăng nhập mở /app/projects ⇒ về /login, giữ đường cũ để quay lại", async () => {
    const { router } = renderApp("/app/projects", { user: null });
    expect(
      await screen.findByRole("heading", { name: "Đăng nhập" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toMatchObject({
      redirectTo: "/app/projects",
    });
  });

  it("đăng nhập đúng ⇒ vào danh sách project", async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json(golden("POST /auth/login")),
      ),
      http.get(`${API}/projects`, () =>
        HttpResponse.json(golden("GET /projects")),
      ),
    );
    const { router } = renderApp("/login", { user: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "a@b.vn");
    await user.type(screen.getByLabelText("Mật khẩu"), "secret-123");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/app/projects"),
    );
  });

  it("lỗi theo trường hiện NGAY cạnh ô nhập, không qua toast", async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json(
          {
            type: "about:blank",
            title: "Validation failed",
            status: 400,
            errors: [{ field: "email", message: "Email không hợp lệ" }],
            traceId: "t-1",
          },
          { status: 400 },
        ),
      ),
    );
    renderApp("/login", { user: null });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "x");
    await user.type(screen.getByLabelText("Mật khẩu"), "y");
    await user.click(screen.getByRole("button", { name: "Đăng nhập" }));
    const email = screen.getByLabelText("Email");
    await waitFor(() => expect(email).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText("Email không hợp lệ")).toBeInTheDocument();
  });

  it("redirectTo sang origin khác hay ngoài /app bị bỏ (chặn open redirect)", () => {
    expect(safeRedirect("https://evil.example/app")).toBe("/app/projects");
    expect(safeRedirect("//evil.example/app")).toBe("/app/projects");
    expect(safeRedirect("/login")).toBe("/app/projects");
    expect(safeRedirect("/app/projects/x?env=1")).toBe("/app/projects/x?env=1");
    expect(safeRedirect(undefined)).toBe("/app/projects");
  });
});

describe("project và environment", () => {
  it("danh sách project hiện tên và vai do SERVER tính (myRole)", async () => {
    const list = golden<{ projects: { name: string }[] }>("GET /projects");
    server.use(http.get(`${API}/projects`, () => HttpResponse.json(list)));
    renderApp("/app/projects");
    const first = list.projects[0];
    expect(first).toBeDefined();
    expect(await screen.findByText(first!.name)).toBeInTheDocument();
    expect(screen.getAllByText("Chủ sở hữu").length).toBeGreaterThan(0);
  });

  it("env mặc định KHÔNG BAO GIỜ là production khi URL không nói env nào (§10.12)", async () => {
    const detail = projectFixture("OWNER");
    const envs = [...detail.environments].reverse();
    expect(defaultEnvOf(envs)?.isProduction).toBe(false);
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/flags`, () =>
        HttpResponse.json({ flags: [] }),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}`);
    const sw = await screen.findByRole("button", { name: /^Environment: / });
    expect(sw).not.toHaveAccessibleName(
      `Environment: ${envOf(detail, true).name}`,
    );
  });

  it("env lạ trên URL (dán từ project khác) bị thay bằng env mặc định", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    let asked: string | null = null;
    server.use(
      http.get(`${API}/projects/:id/flags`, ({ request }) => {
        asked = new URL(request.url).searchParams.get("envId");
        return HttpResponse.json({ flags: [] });
      }),
    );
    renderApp(
      `/app/projects/${detail.project.id}/flags?env=99999999-9999-4999-8999-999999999999`,
    );
    await screen.findByText("Chưa có flag nào");
    expect(asked).toBe(defaultEnvOf(detail.environments)?.id);
  });
});

describe("flag", () => {
  it("bật flag ở production cần GÕ LẠI key, và PATCH mang confirmFlagKey", async () => {
    const detail = projectFixture("MAINTAINER");
    const prod = envOf(detail, true);
    const { flag, summary } = flagFixture(detail);
    const rules: RulesResponseWire = { updatedAt: flag.updatedAt, rules: [] };
    const bodies: unknown[] = [];
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/flags`, () =>
        HttpResponse.json({ flags: [summary] }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId`, () =>
        HttpResponse.json({ flag }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
        HttpResponse.json(rules),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/stats`, () =>
        HttpResponse.json(golden("GET /projects/{id}/flags/{id}/stats")),
      ),
      http.patch(
        `${API}/projects/:id/flags/:flagId/envs/:envId`,
        async ({ request }) => {
          bodies.push(await request.json());
          const env = flag.envs.find((e) => e.environment.id === prod.id)!;
          return HttpResponse.json({ env: { ...env, isEnabled: true } });
        },
      ),
    );
    renderApp(
      `/app/projects/${detail.project.id}/flags?env=${prod.id}&flag=${flag.id}`,
    );
    const user = userEvent.setup();
    const sw = await screen.findByRole("switch", {
      name: `Bật flag ở ${prod.name}`,
    });
    await user.click(sw);

    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Áp dụng" });
    expect(confirm).toBeDisabled();
    expect(bodies).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/để xác nhận/), flag.key);
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ isEnabled: true, confirmFlagKey: flag.key });
  });

  it("ở dev, bật flag áp NGAY (không hộp thoại) và có Hoàn tác", async () => {
    const detail = projectFixture("DEVELOPER");
    const dev = defaultEnvOf(detail.environments)!;
    const { flag, summary } = flagFixture(detail);
    const bodies: unknown[] = [];
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/flags`, () =>
        HttpResponse.json({ flags: [summary] }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId`, () =>
        HttpResponse.json({ flag }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
        HttpResponse.json({ updatedAt: flag.updatedAt, rules: [] }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/stats`, () =>
        HttpResponse.json(golden("GET /projects/{id}/flags/{id}/stats")),
      ),
      http.patch(
        `${API}/projects/:id/flags/:flagId/envs/:envId`,
        async ({ request }) => {
          bodies.push(await request.json());
          const env = flag.envs.find((e) => e.environment.id === dev.id)!;
          return HttpResponse.json({ env });
        },
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/flags?flag=${flag.id}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("switch", { name: `Bật flag ở ${dev.name}` }),
    );
    await waitFor(() => expect(bodies).toEqual([{ isEnabled: true }]));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Hoàn tác" }));
    await waitFor(() =>
      expect(bodies).toEqual([{ isEnabled: true }, { isEnabled: false }]),
    );
  });

  it("VIEWER không thấy nút Tạo flag và không bật/tắt được", async () => {
    const detail = projectFixture("VIEWER");
    const { flag, summary } = flagFixture(detail);
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/flags`, () =>
        HttpResponse.json({ flags: [summary] }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId`, () =>
        HttpResponse.json({ flag }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
        HttpResponse.json({ updatedAt: flag.updatedAt, rules: [] }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/stats`, () =>
        HttpResponse.json(golden("GET /projects/{id}/flags/{id}/stats")),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/flags?flag=${flag.id}`);
    expect(await screen.findByRole("switch")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Tạo flag/ })).toBeNull();
  });

  it("lưu rule gửi lại id của rule cũ và mốc lastKnownUpdatedAt của server", async () => {
    const detail = projectFixture("OWNER");
    const { flag, summary } = flagFixture(detail);
    const rulesGolden = golden<RulesResponseWire>(
      "GET /projects/{id}/flags/{id}/envs/{id}/rules",
    );
    const variant = flag.variants[0]!;
    const rules: RulesResponseWire = {
      updatedAt: rulesGolden.updatedAt,
      rules: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          priority: 10,
          ruleType: "ALL",
          condition: {},
          serve: { kind: "variant", variantId: variant.id },
          description: "cũ",
        },
      ],
    };
    const puts: {
      lastKnownUpdatedAt: string;
      rules: { id?: string; description: string | null }[];
    }[] = [];
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/flags`, () =>
        HttpResponse.json({ flags: [summary] }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId`, () =>
        HttpResponse.json({ flag }),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/envs/:envId/rules`, () =>
        HttpResponse.json(rules),
      ),
      http.get(`${API}/projects/:id/flags/:flagId/stats`, () =>
        HttpResponse.json(golden("GET /projects/{id}/flags/{id}/stats")),
      ),
      http.put(
        `${API}/projects/:id/flags/:flagId/envs/:envId/rules`,
        async ({ request }) => {
          const body = (await request.json()) as (typeof puts)[number];
          puts.push(body);
          return HttpResponse.json({
            updatedAt: new Date().toISOString(),
            rules: body.rules.map((r, i) => ({
              ...rules.rules[0]!,
              id: r.id ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              priority: (i + 1) * 10,
              description: r.description,
            })),
          });
        },
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/flags?flag=${flag.id}`);
    const user = userEvent.setup();
    const desc = await screen.findByLabelText("Mô tả Rule 1");
    await user.clear(desc);
    await user.type(desc, "mới");
    expect(await screen.findByText(/1 thay đổi ở/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Lưu\s*Ctrl S$/ }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.lastKnownUpdatedAt).toBe(rules.updatedAt);
    expect(puts[0]!.rules[0]!.id).toBe(rules.rules[0]!.id);
    expect(puts[0]!.rules[0]!.description).toBe("mới");
  });
});

describe("SDK key", () => {
  it("key mới hiện plaintext đúng MỘT lần; đóng hộp là không còn trên trang", async () => {
    const detail = projectFixture("OWNER");
    const created = golden<{ secretKey: string }>(
      "POST /projects/{id}/environments/{id}/keys",
    );
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/environments/:envId/keys`, () =>
        HttpResponse.json({ keys: [] }),
      ),
      http.post(`${API}/projects/:id/environments/:envId/keys`, () =>
        HttpResponse.json(created, { status: 201 }),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/settings?tab=keys`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Tạo key" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Tạo key" }));
    expect(await screen.findByText(created.secretKey)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Đã lưu key" }));
    await waitFor(() =>
      expect(screen.queryByText(created.secretKey)).toBeNull(),
    );
  });
});
