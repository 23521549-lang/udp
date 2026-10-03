import type {
  AdminOverviewWire,
  AdminPlatformWire,
  AdminSystemWire,
} from "@udp/shared-types/wire";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  adminJobsSearch,
  adminOrphansSearch,
  defaultJobState,
} from "../src/features/admin/admin-search";
import { needsAttention } from "../src/features/admin/attention";
import { cloudConsoleUrl } from "../src/features/admin/cloud-console";
import { dailyAtVietnam } from "../src/features/admin/platform-model";
import {
  parseSort,
  sortParam,
  sortRows,
  toggleSort,
} from "../src/features/admin/sort";
import { useLocaleStore } from "../src/i18n";
import { API, golden, server } from "./msw";
import { renderApp, USER } from "./render";

/**
 * [Plan #58 UX-3…UX-36] Bảng điều khiển sau vòng UX: dải "Cần xử lý", menu nhóm có huy hiệu, tab job có số, panel
 * project, bảng sắp được, lọc vai/tìm project, Ctrl K. Dữ liệu dựng tay (không phải golden) để mỗi phép kiểm biết đúng
 * hàng nào đứng đâu; hình dạng vẫn đi qua schema dây của `adminApi`.
 */

const ADMIN = { ...USER, platformRole: "PLATFORM_ADMIN" as const };
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const SHOP = "11111111-1111-4111-8111-111111111111";
const BILLING = "22222222-2222-4222-8222-222222222222";
const OLD = "33333333-3333-4333-8333-333333333333";

/** [Plan #60 H8] Job "có vấn đề" mới nhất mà Service 1 trả kèm dòng project — cùng job với danh sách Job lỗi dưới */
const problem = (id: string, state: string, name: string) => ({
  id,
  jobType: "PROVISION",
  state,
  lastError: {
    step: "NETWORK",
    message: `Không xoá được NAT của ${name}`,
    orphans: ["nat"],
  },
  updatedAt: ago(1),
});

const PROJECTS = [
  {
    id: SHOP,
    name: "shop",
    status: "ERROR",
    owner: { id: "a1a1a1a1-1111-4111-8111-111111111111", email: "an@shop.vn" },
    memberCount: 3,
    cloudProvider: "AWS",
    createdAt: ago(40),
    latestProblemJob: problem(
      "f0000001-0000-4000-8000-000000000001",
      "COMPENSATION_FAILED",
      "shop",
    ),
  },
  {
    id: BILLING,
    name: "billing",
    status: "ACTIVE",
    owner: {
      id: "b2b2b2b2-2222-4222-8222-222222222222",
      email: "binh@billing.vn",
    },
    memberCount: 1,
    cloudProvider: "AZURE",
    createdAt: ago(20),
    latestProblemJob: problem(
      "f0000002-0000-4000-8000-000000000002",
      "FAILED",
      "billing",
    ),
  },
  {
    id: OLD,
    name: "old",
    status: "DELETED",
    owner: { id: "a1a1a1a1-1111-4111-8111-111111111111", email: "an@shop.vn" },
    memberCount: 1,
    cloudProvider: null,
    createdAt: ago(90),
    latestProblemJob: null,
  },
];

const AZURE_ID =
  "/subscriptions/abc/resourceGroups/udp/providers/Microsoft.Network/natGateways/udp";
const ORPHANS = {
  resources: [
    {
      id: "c0000001-0000-4000-8000-000000000001",
      projectId: SHOP,
      projectName: "shop",
      kind: "ElasticIp",
      provider: "AWS",
      region: "ap-southeast-1",
      providerId: "eipalloc-1",
      usdPerHour: 0.005,
      updatedAt: ago(10),
    },
    {
      id: "c0000002-0000-4000-8000-000000000002",
      projectId: BILLING,
      projectName: "billing",
      kind: "NatGateway",
      provider: "AZURE",
      region: "southeastasia",
      providerId: AZURE_ID,
      usdPerHour: 0.059,
      updatedAt: ago(2),
    },
    {
      id: "c0000003-0000-4000-8000-000000000003",
      projectId: SHOP,
      projectName: "shop",
      kind: "EksCluster",
      provider: "AWS",
      region: "ap-southeast-1",
      providerId: null,
      usdPerHour: null,
      updatedAt: ago(30),
    },
  ],
  estimatedUsdPerHour: 0.064,
  unpriced: ["EksCluster"],
  pricingAsOf: "2026-09-01",
  cloudScanned: true,
};

const job = (id: string, state: string, projectId: string, name: string) => ({
  id,
  jobType: "PROVISION",
  state,
  attempt: 2,
  lastError: {
    step: "NETWORK",
    message: `Không xoá được NAT của ${name}`,
    orphans: ["nat"],
  },
  createdAt: ago(3),
  updatedAt: ago(1),
  project: { id: projectId, name },
});
const JOBS: Record<string, ReturnType<typeof job>[]> = {
  COMPENSATION_FAILED: [
    job(
      "f0000001-0000-4000-8000-000000000001",
      "COMPENSATION_FAILED",
      SHOP,
      "shop",
    ),
  ],
  FAILED: [
    job("f0000002-0000-4000-8000-000000000002", "FAILED", BILLING, "billing"),
  ],
  CANCEL_REQUESTED: [],
};

const CREDENTIALS = [
  {
    id: "e0000001-0000-4000-8000-000000000001",
    provider: "AZURE",
    mode: "BYOC",
    authKind: "AZURE_SECRET",
    fingerprint: "ab12cd",
    isActive: true,
    lastValidatedAt: null,
    createdAt: ago(20),
    project: { id: BILLING, name: "billing" },
  },
  {
    id: "e0000002-0000-4000-8000-000000000002",
    provider: "AWS",
    mode: "BYOC",
    authKind: "AWS_ROLE",
    fingerprint: "ef34gh",
    isActive: true,
    lastValidatedAt: ago(1),
    createdAt: ago(40),
    project: { id: SHOP, name: "shop" },
  },
];

const overviewWith = (
  over: (o: AdminOverviewWire) => AdminOverviewWire = (o) => o,
): AdminOverviewWire => {
  const o = golden<{ overview: AdminOverviewWire }>(
    "GET /admin/overview",
  ).overview;
  return over({
    ...o,
    projects: {
      total: 2,
      byStatus: { DRAFT: 0, PROVISIONING: 0, ACTIVE: 1, ERROR: 1 },
    },
    jobs: { running: 0, failed: 1, compensationFailed: 1, cancelRequested: 0 },
    orphans: { count: 3, usdPerHour: 0.064, unpriced: 1 },
  });
};

const platformOk = (): AdminPlatformWire => {
  const p = golden<{ platform: AdminPlatformWire }>(
    "GET /admin/platform",
  ).platform;
  return {
    ...p,
    release: "c519f0c",
    backup:
      p.backup.state === "ok"
        ? { ...p.backup, lastSuccessAt: ago(0.05), lastFailureAt: null }
        : p.backup,
    certificate:
      p.certificate.state === "ok"
        ? { ...p.certificate, ready: true, notAfter: ago(-60) }
        : p.certificate,
  };
};

const SYSTEM_UP: AdminSystemWire = {
  services: [
    { name: "udp-core-backend", status: "up" },
    { name: "udp-feature-flag-service", status: "up" },
    { name: "udp-pd-controller", status: "up" },
  ],
  database: "up",
  checkedAt: new Date(NOW).toISOString(),
};

/** Mọi route quản trị; máy chủ giả lọc đúng như máy chủ thật sẽ lọc (tìm, trạng thái, vai) */
function useConsole({
  overview = overviewWith(),
  platform = platformOk(),
  system = SYSTEM_UP,
  users = golden<{ users: { platformRole: string }[]; total: number }>(
    "GET /admin/users",
  ),
}: {
  overview?: AdminOverviewWire;
  platform?: AdminPlatformWire;
  system?: AdminSystemWire;
  users?: { users: { platformRole: string }[]; total: number };
} = {}) {
  const asked: URLSearchParams[] = [];
  server.use(
    http.get(`${API}/admin/overview`, () => HttpResponse.json({ overview })),
    http.get(`${API}/admin/platform`, () => HttpResponse.json({ platform })),
    http.get(`${API}/admin/system/health`, () => HttpResponse.json(system)),
    http.get(`${API}/admin/projects`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      asked.push(q);
      const search = q.get("search");
      const status = q.get("status");
      const rows = PROJECTS.filter(
        (p) =>
          (status === null || p.status === status) &&
          (search === null ||
            p.name.includes(search) ||
            p.owner.email.includes(search)),
      );
      return HttpResponse.json({ projects: rows, total: rows.length });
    }),
    http.get(`${API}/admin/users`, ({ request }) => {
      const q = new URL(request.url).searchParams;
      asked.push(q);
      const role = q.get("platformRole");
      const search = q.get("search");
      const rows = users.users.filter(
        (u) =>
          (role === null || u.platformRole === role) &&
          (search === null || JSON.stringify(u).includes(search)),
      );
      return HttpResponse.json({ users: rows, total: rows.length });
    }),
    http.get(`${API}/admin/jobs`, ({ request }) => {
      const state = new URL(request.url).searchParams.get("state") ?? "";
      const jobs = JOBS[state] ?? [];
      return HttpResponse.json({ jobs, total: jobs.length });
    }),
    http.get(`${API}/admin/orphan-resources`, () => HttpResponse.json(ORPHANS)),
    http.get(`${API}/admin/credentials`, () =>
      HttpResponse.json({ credentials: CREDENTIALS }),
    ),
  );
  return asked;
}

// ------------------------------------------------------------------ mô hình thuần

describe("mô hình thuần của Bảng điều khiển (Plan #58)", () => {
  it("cần xử lý: lỗi trước cảnh báo; cùng mức thì dọn chưa hết ⇒ mồ côi ⇒ project lỗi ⇒ service ⇒ sao lưu", () => {
    const p = platformOk();
    const { items, unreadable } = needsAttention(
      {
        overview: overviewWith(),
        platform: {
          ...p,
          node: {
            state: "ok",
            name: "vm",
            cpuCores: 2,
            cpuUsedCores: 0.1,
            memoryBytes: 1000,
            memoryUsedBytes: 100,
          },
          backup:
            p.backup.state === "ok"
              ? { ...p.backup, lastFailureAt: ago(0.01) }
              : p.backup,
          certificate:
            p.certificate.state === "ok"
              ? { ...p.certificate, notAfter: ago(-5) }
              : p.certificate,
          postgresVolume: { state: "unavailable", reason: "FORBIDDEN" },
        },
        system: {
          ...SYSTEM_UP,
          services: [
            { name: "udp-core-backend", status: "up" },
            { name: "udp-feature-flag-service", status: "down" },
            { name: "udp-pd-controller", status: "unknown" },
          ],
        },
      },
      NOW,
    );
    expect(items.map((i) => `${i.kind}:${i.tone}`)).toEqual([
      "cleanup:error",
      "orphans:error",
      "errorProjects:error",
      "service:error",
      "backup:error",
      "certificate:warn",
      "idle:warn",
    ]);
    // Một service chưa rõ và ổ PostgreSQL không đọc được: không phải việc, nhưng không được nói "Mọi thứ ổn"
    expect(unreadable).toBe(2);
  });

  it("cần xử lý: mọi thứ xanh ⇒ không mục nào; nguồn chưa tải không góp mục nào", () => {
    const quiet = overviewWith((o) => ({
      ...o,
      projects: {
        ...o.projects,
        byStatus: { ...o.projects.byStatus, ERROR: 0 },
      },
      jobs: { ...o.jobs, compensationFailed: 0 },
      orphans: { count: 0, usdPerHour: 0, unpriced: 0 },
    }));
    expect(
      needsAttention(
        { overview: quiet, platform: platformOk(), system: SYSTEM_UP },
        NOW,
      ),
    ).toEqual({ items: [], unreadable: 0 });
    expect(needsAttention({}, NOW)).toEqual({ items: [], unreadable: 0 });
  });

  it("lịch cron UTC ⇒ giờ Việt Nam; dạng lạ thì không đoán", () => {
    expect(dailyAtVietnam("30 19 * * *")).toBe("02:30");
    expect(dailyAtVietnam("0 3 * * *")).toBe("10:00");
    expect(dailyAtVietnam("0 17 * * *")).toBe("00:00");
    expect(dailyAtVietnam(" 5 16 * * * ")).toBe("23:05");
    expect(dailyAtVietnam("*/5 * * * *")).toBeNull();
    expect(dailyAtVietnam("0 3 * * 1")).toBeNull();
    expect(dailyAtVietnam("75 3 * * *")).toBeNull();
  });

  it("sắp xếp: null luôn cuối ở cả hai chiều; bấm lại cùng cột thì đảo chiều; mặc định không ghi lên URL", () => {
    const rows = [{ v: 2 }, { v: null }, { v: 5 }, { v: 1 }];
    const value = (r: { v: number | null }) => r.v;
    expect(
      sortRows(rows, { key: "v", dir: "desc" }, value).map((r) => r.v),
    ).toEqual([5, 2, 1, null]);
    expect(
      sortRows(rows, { key: "v", dir: "asc" }, value).map((r) => r.v),
    ).toEqual([1, 2, 5, null]);
    const cost = { key: "cost", dir: "desc" } as const;
    expect(toggleSort(cost, "cost", "desc")).toEqual({
      key: "cost",
      dir: "asc",
    });
    expect(toggleSort(cost, "since", "asc")).toEqual({
      key: "since",
      dir: "asc",
    });
    expect(parseSort("since.asc", ["cost", "since"])).toEqual({
      key: "since",
      dir: "asc",
    });
    expect(parseSort("since.up", ["cost", "since"])).toBeUndefined();
    expect(parseSort("x.asc", ["cost", "since"])).toBeUndefined();
    expect(sortParam(cost, cost)).toBeUndefined();
    expect(adminOrphansSearch({ sort: "cost.desc" })).toEqual({});
    expect(adminOrphansSearch({ sort: "since.asc", project: SHOP })).toEqual({
      sort: "since.asc",
      project: SHOP,
    });
  });

  it("tab job mặc định: dọn chưa hết khi còn, không thì thất bại; trạng thái lạ trên URL bị bỏ", () => {
    expect(
      defaultJobState({
        COMPENSATION_FAILED: 1,
        FAILED: 4,
        CANCEL_REQUESTED: 0,
      }),
    ).toBe("COMPENSATION_FAILED");
    expect(
      defaultJobState({
        COMPENSATION_FAILED: 0,
        FAILED: 4,
        CANCEL_REQUESTED: 0,
      }),
    ).toBe("FAILED");
    expect(defaultJobState(undefined)).toBe("FAILED");
    expect(adminJobsSearch({ state: "DONE", offset: "0" })).toEqual({});
    expect(adminJobsSearch({ state: "FAILED", offset: "50" })).toEqual({
      state: "FAILED",
      offset: 50,
    });
  });

  it("link console theo cloud: Azure mở đúng tài nguyên, GCP đúng project, AWS đúng region", () => {
    expect(
      cloudConsoleUrl({ provider: "AZURE", region: "x", providerId: AZURE_ID }),
    ).toBe(`https://portal.azure.com/#@/resource${AZURE_ID}`);
    expect(
      cloudConsoleUrl({
        provider: "GCP",
        region: "asia-southeast1",
        providerId: "projects/udp-demo/locations/asia-southeast1/clusters/udp",
      }),
    ).toBe("https://console.cloud.google.com/home/dashboard?project=udp-demo");
    expect(
      cloudConsoleUrl({
        provider: "AWS",
        region: "ap-southeast-1",
        providerId: null,
      }),
    ).toBe("https://console.aws.amazon.com/console/home?region=ap-southeast-1");
  });
});

// ------------------------------------------------------------------ màn hình

describe("Tổng quan: dải Cần xử lý, số đầu trang là link, menu nhóm có huy hiệu", () => {
  it("việc gấp đứng đầu, mỗi dòng dẫn tới chỗ sửa; menu ba nhóm, huy hiệu từ Tổng quan", async () => {
    useConsole();
    renderApp("/admin/overview", { user: ADMIN });
    const strip = await screen.findByRole("list", { name: "Cần xử lý" });
    const rows = within(strip).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(/^1 job dọn chưa hết tài nguyên/);
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute(
      "href",
      "/admin/jobs?state=COMPENSATION_FAILED",
    );
    expect(rows[1]).toHaveTextContent(
      /3 tài nguyên mồ côi đang tốn .*1 chưa rõ giá/,
    );
    expect(within(rows[2]!).getByRole("link")).toHaveAttribute(
      "href",
      "/admin/projects?status=ERROR",
    );
    // Ba số đầu trang là link; số job lỗi mở đúng tab đang tốn tiền
    expect(screen.getByRole("link", { name: "2 job lỗi" })).toHaveAttribute(
      "href",
      "/admin/jobs?state=COMPENSATION_FAILED",
    );

    const nav = screen.getByRole("navigation", { name: "Bảng điều khiển" });
    expect([...nav.querySelectorAll(".grp")].map((g) => g.textContent)).toEqual(
      ["Vận hành", "Khách hàng", "Tham chiếu"],
    );
    expect(
      within(nav).getByRole("link", { name: "Job lỗi 2" }),
    ).toBeInTheDocument();
    expect(
      within(nav).getByRole("link", { name: "Tài nguyên mồ côi 3" }),
    ).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /Hệ thống/ })).toBeNull();
  });

  it("không còn việc gì ⇒ 'Mọi thứ ổn'; tín hiệu xanh gọn thành một dòng", async () => {
    useConsole({
      overview: overviewWith((o) => ({
        ...o,
        projects: {
          ...o.projects,
          byStatus: { ...o.projects.byStatus, ERROR: 0 },
        },
        jobs: { ...o.jobs, compensationFailed: 0 },
        orphans: { count: 0, usdPerHour: 0, unpriced: 0 },
      })),
    });
    renderApp("/admin/overview", { user: ADMIN });
    const strip = await screen.findByRole("region", { name: "Cần xử lý" });
    expect(await within(strip).findByText("Mọi thứ ổn")).toBeInTheDocument();
    const green = screen.getByRole("list", { name: "Máy ảo chạy UDP" });
    expect(within(green).getByText("c519f0c")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Sao lưu" })).toBeNull();
  });

  it("/admin/system (đã gộp) chuyển sang Kiến trúc nền tảng", async () => {
    useConsole();
    const { router } = renderApp("/admin/system", { user: ADMIN });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/admin/architecture"),
    );
  });

  it("tiếng Anh: nhóm menu và tiêu đề tự nhiên", async () => {
    act(() => useLocaleStore.getState().setLocale("en"));
    useConsole();
    renderApp("/admin/overview", { user: ADMIN });
    expect(
      await screen.findByRole("heading", { name: "Needs attention" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Host VM" }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Platform console" });
    expect(nav).toHaveTextContent("Operations");
    expect(nav).toHaveTextContent("Reference");
  });
});

describe("Job lỗi, tài nguyên mồ côi và panel project", () => {
  it("tên project mở panel: trạng thái, chủ, job lỗi gần nhất, tài nguyên mồ côi; Esc đóng và xoá khỏi URL", async () => {
    useConsole();
    const { router } = renderApp("/admin/jobs", { user: ADMIN });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "shop" }));
    expect(router.state.location.search).toMatchObject({ project: SHOP });
    const panel = await screen.findByRole("complementary", {
      name: "Project shop",
    });
    expect(
      within(panel)
        .getByRole("link", { name: "an@shop.vn" })
        .getAttribute("href"),
    ).toMatch(/^\/admin\/users\?q=an/);
    expect(
      await within(panel).findByText(/Không xoá được NAT của shop/),
    ).toHaveTextContent("Còn 1 tài nguyên chưa dọn.");
    const orphans = within(panel).getByRole("region", {
      name: "Tài nguyên mồ côi",
    });
    expect(await within(orphans).findByText("EksCluster")).toBeInTheDocument();
    expect(within(orphans).queryByText("NatGateway")).toBeNull();
    const creds = within(panel).getByRole("region", { name: "Credential" });
    expect(await within(creds).findByText("Đã kiểm")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("project"),
    );
  });

  it("tài nguyên mồ côi: chủ project, đắt nhất trước (chưa rõ giá cuối), sắp theo 'mồ côi từ', sao chép id, link console", async () => {
    useConsole();
    const { router } = renderApp("/admin/orphans", { user: ADMIN });
    const table = await screen.findByRole("table", {
      name: "Tài nguyên mồ côi",
    });
    const kinds = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell")[2]?.textContent);
    expect(kinds()).toEqual(["NatGateway", "ElasticIp", "EksCluster"]);
    expect(
      within(table).getByRole("columnheader", { name: /USD\/giờ/ }),
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      await within(table).findByText("binh@billing.vn"),
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: /Mồ côi từ/ }));
    expect(router.state.location.search).toMatchObject({ sort: "since.asc" });
    expect(kinds()).toEqual(["EksCluster", "ElasticIp", "NatGateway"]);

    await user.click(
      within(table).getByRole("button", {
        name: "Sao chép id NatGateway của billing",
      }),
    );
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(AZURE_ID),
    );
    expect(
      within(table).getAllByRole("link", { name: "Mở console Azure" })[0],
    ).toHaveAttribute(
      "href",
      `https://portal.azure.com/#@/resource${AZURE_ID}`,
    );
  });

  it("credential: tên cloud và chế độ đọc được; chưa kiểm lần nào là nhãn cam", async () => {
    useConsole();
    renderApp("/admin/credentials", { user: ADMIN });
    const table = await screen.findByRole("table", { name: "Credential" });
    const billing = within(table)
      .getByRole("link", { name: "billing" })
      .closest("tr")!;
    expect(billing).toHaveTextContent("Azure");
    expect(billing).toHaveTextContent("Cloud của khách");
    expect(billing).toHaveTextContent("Client secret");
    expect(
      within(billing).getByText("Chưa kiểm lần nào").closest(".sl"),
    ).toHaveClass("warn");
    expect(billing).not.toHaveTextContent("AZURE");
  });
});

describe("Người dùng và Project: lọc, tìm, sắp, đổi vai", () => {
  it("lọc vai quản trị ⇒ platformRole lên request và URL; dòng của mình ghi (bạn); 'Hạ quyền' là nút nguy hiểm", async () => {
    const users = golden<{
      users: { id: string; email: string; platformRole: string }[];
      total: number;
    }>("GET /admin/users");
    const me = users.users.find((u) => u.platformRole === "PLATFORM_ADMIN");
    if (me === undefined) throw new Error("golden thiếu người dùng quản trị");
    const asked = useConsole({ users });
    const { router } = renderApp("/admin/users", {
      user: { ...ADMIN, id: me.id, email: me.email },
    });
    const user = userEvent.setup();
    const roles = await screen.findByRole("group", { name: "Lọc theo vai" });
    await user.click(within(roles).getByRole("button", { name: "Quản trị" }));
    expect(router.state.location.search).toMatchObject({
      role: "PLATFORM_ADMIN",
    });
    await waitFor(() =>
      expect(asked.at(-1)?.get("platformRole")).toBe("PLATFORM_ADMIN"),
    );
    const table = await screen.findByRole("table", { name: "Người dùng" });
    const mine = within(table).getByText(me.email).closest("tr")!;
    expect(mine).toHaveTextContent("(bạn)");
    expect(within(mine).getByRole("button", { name: "Hạ quyền" })).toHaveClass(
      "danger",
    );

    await user.click(within(table).getByRole("button", { name: /Tạo lúc/ }));
    await waitFor(() => expect(asked.at(-1)?.get("order")).toBe("asc"));
    expect(
      within(table).getByRole("columnheader", { name: /Tạo lúc/ }),
    ).toHaveAttribute("aria-sort", "ascending");
  });

  it("nâng quyền ⇒ thông báo nói ai và vai gì", async () => {
    const users = golden<{
      users: {
        id: string;
        email: string;
        name: string;
        platformRole: string;
      }[];
      total: number;
    }>("GET /admin/users");
    const target = users.users.find((u) => u.platformRole === "USER");
    if (target === undefined) throw new Error("golden thiếu người dùng thường");
    useConsole({ users });
    server.use(
      http.patch(`${API}/admin/users/:userId/platform-role`, () =>
        HttpResponse.json({
          user: { ...target, platformRole: "PLATFORM_ADMIN" },
        }),
      ),
    );
    renderApp("/admin/users", { user: ADMIN });
    const table = await screen.findByRole("table", { name: "Người dùng" });
    const row = within(table).getAllByText(target.email)[0]!.closest("tr")!;
    const user = userEvent.setup();
    await user.click(
      within(row).getByRole("button", { name: "Nâng lên quản trị" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/để xác nhận/), target.email);
    await user.click(
      within(dialog).getByRole("button", { name: "Nâng lên quản trị" }),
    );
    expect(
      await screen.findByText(`Đã nâng ${target.name} lên quản trị`),
    ).toBeInTheDocument();
  });

  it("project: tổng nói rõ gồm project đã xoá; tìm theo chủ ⇒ search lên máy chủ; lọc ra rỗng có 'Xoá bộ lọc'", async () => {
    const asked = useConsole();
    const { router } = renderApp("/admin/projects", { user: ADMIN });
    expect(
      await screen.findByText("project, gồm 1 đã xoá"),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("searchbox", { name: "Tìm project" }),
      "binh@",
    );
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ q: "binh@" }),
    );
    await waitFor(() => expect(asked.at(-1)?.get("search")).toBe("binh@"));
    const table = await screen.findByRole("table", { name: "Project" });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(2),
    );

    await user.clear(screen.getByRole("searchbox", { name: "Tìm project" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Tìm project" }),
      "khong-co",
    );
    await user.click(await screen.findByRole("button", { name: "Xoá bộ lọc" }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });
});

describe("Ctrl K của Bảng điều khiển", () => {
  it("tới một trang, mở panel project theo tên, tìm người dùng theo email", async () => {
    useConsole();
    const { router } = renderApp("/admin/overview", { user: ADMIN });
    await screen.findByRole("list", { name: "Cần xử lý" });
    const user = userEvent.setup();

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Tìm nhanh" });
    await user.type(within(palette).getByRole("combobox"), "mo coi");
    expect(
      within(palette).getByRole("option", { name: /Tài nguyên mồ côi/ }),
    ).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/admin/orphans"),
    );

    await user.keyboard("{Control>}k{/Control}");
    const again = await screen.findByRole("dialog", { name: "Tìm nhanh" });
    await user.type(within(again).getByRole("combobox"), "billing");
    await user.click(
      await within(again).findByRole("option", { name: /billing/ }),
    );
    await waitFor(() =>
      expect(router.state.location).toMatchObject({
        pathname: "/admin/projects",
        search: { project: BILLING },
      }),
    );

    await user.keyboard("{Escape}");
    await user.keyboard("{Control>}k{/Control}");
    const third = await screen.findByRole("dialog", { name: "Tìm nhanh" });
    await user.type(within(third).getByRole("combobox"), "admin@udp");
    await user.click(
      await within(third).findByRole("option", { name: /admin@udp\.local/ }),
    );
    await waitFor(() =>
      expect(router.state.location).toMatchObject({
        pathname: "/admin/users",
        search: { q: "admin@udp.local" },
      }),
    );
  });
});
