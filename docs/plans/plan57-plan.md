# Plan #57 — Tổng quan hệ thống và Kiến trúc nền tảng — kế hoạch thực hiện

> **Cho người/agent thực hiện:** dùng superpowers:executing-plans (hoặc subagent-driven-development) để làm từng
> task; mỗi bước có ô `- [ ]` để đánh dấu. Mỗi đợt (57a–57d) là MỘT commit, cổng của đợt xanh trước khi sang đợt sau.

**Goal:** Trang Kiến trúc của project có góc nhìn "Tổng quan hệ thống" kiểu C4 (mặc định), và Bảng điều khiển có trang
"Kiến trúc nền tảng" của chính UDP — đúng hai góc người dùng đã duyệt trên bản mẫu.

**Architecture:** Bố cục CỐ ĐỊNH bằng CSS grid (vị trí thành phần do Portal quyết định theo vai trò của domain), một lớp
cạnh chung `LinkLayer` đo vị trí sau layout (`ResizeObserver`) và vẽ đường cong có nhãn. Dữ liệu từ route sẵn có; một
trường mới `architecture.deploys` (kết cục deploy 14 ngày) tính bằng CÙNG hàm `dailyOutcomes` của Plan #56.

**Tech Stack:** React 18 + TanStack Router/Query, zod (`@udp/shared-types/wire`), Express + Prisma (Service 1), vitest +
msw + golden, Playwright (`portal-demo`).

**Spec:** `docs/plans/plan57-spec.md`

## Global Constraints

- Không thêm phụ thuộc npm nào (QĐ-8 của spec).
- Chi phí hạ tầng 0; không route mới ở Service 1 ngoài trường `deploys` của `GET /projects/:id/architecture`.
- Mọi chữ giao diện ở `*.messages.ts(x)` hai bản `vi`/`en`; không em-dash trong chữ giao diện; `<svg>` tự vẽ chỉ ở tệp đã
  khai trong `apps/portal/tests/design-lint.test.ts`.
- Màu: trạng thái bằng `StatusLabel` (biểu tượng + chữ), không chỉ màu; màu dữ liệu từ token (`--accent`, `--v3`,
  `--v4`, `--env-*`).
- Chữ do Portal đặt cho nhãn cạnh (I37); cạnh là VAI TRÒ, không phải lưu lượng đo được — chú giải nói vậy.
- Góc nhìn trên URL: `?view=infra` (mặc định `system` không ghi ra).
- Commit cục bộ, không push; trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File Structure

| Tệp                                                                      | Trách nhiệm                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `packages/shared-types/src/wire.ts`                                      | `deployDayWire` dùng chung; `architecture.deploys`                              |
| `services/core-backend/src/modules/deployment/deployment.dora.ts`        | `utcDayWindow(days, now)` — cửa sổ ngày UTC dùng chung                          |
| `services/core-backend/src/modules/deployment/deployment.repository.ts`  | `eventsOfProject(projectId, from, to)`                                          |
| `services/core-backend/src/modules/architecture/architecture.service.ts` | thêm `deploys`                                                                  |
| `apps/portal/src/components/LinkLayer.tsx`                               | lớp cạnh có nhãn, đo sau layout (dùng cho cả hai sơ đồ)                         |
| `apps/portal/src/features/architecture/system-model.ts`                  | THUẦN: thành phần theo vai trò, cạnh vai trò (nối qua domain vắng), tóm tắt RED |
| `apps/portal/src/features/architecture/SystemOverview.tsx`               | góc "Tổng quan hệ thống": số liệu, chú giải, sơ đồ, bảng                        |
| `apps/portal/src/features/architecture/system.messages.tsx`              | chữ hai ngôn ngữ của góc mới                                                    |
| `apps/portal/src/features/architecture/ArchitecturePage.tsx`             | bộ chọn góc nhìn                                                                |
| `apps/portal/src/features/admin/platform-architecture.ts`                | THUẦN: thành phần và cạnh của UDP, sức khoẻ từ ba route                         |
| `apps/portal/src/features/admin/pages/AdminArchitecturePage.tsx`         | trang `/admin/architecture`                                                     |
| `apps/portal/demo/mock/handlers/dashboards.ts`                           | `deploys` trong kiến trúc giả                                                   |

---

### Task 1 (đợt 57a): `architecture.deploys` ở Service 1

**Files:**

- Modify: `packages/shared-types/src/wire.ts` (khối `platformDoraWire`, khối `architectureResponseWire`)
- Modify: `services/core-backend/src/modules/deployment/deployment.dora.ts` (sau `dailyOutcomes`)
- Modify: `services/core-backend/src/modules/deployment/deployment.service.ts` (`platformDora` dùng `utcDayWindow`)
- Modify: `services/core-backend/src/modules/deployment/deployment.repository.ts`
- Modify: `services/core-backend/src/modules/architecture/architecture.service.ts`
- Modify: `apps/portal/demo/mock/handlers/dashboards.ts` (`architectureOf`)
- Test: `services/core-backend/tests/dora.test.ts`, `services/core-backend/tests/dashboards.integration.test.ts`

**Interfaces:**

- Produces: `deployDayWire` = `{ date: "YYYY-MM-DD", success: int, failure: int }`; `architecture.deploys:
DeployDayWire[]` (đúng 14 phần tử, cũ → mới); `utcDayWindow(days: number, now: Date): { from: Date; to: Date }`;
  `ARCHITECTURE_DEPLOY_DAYS = 14` (export từ `@udp/shared-types/wire`).

- [ ] **Step 1: test thuần của cửa sổ ngày UTC** — thêm vào `tests/dora.test.ts`:

```ts
describe("utcDayWindow (Plan #57)", () => {
  it("từ đầu ngày cách hôm nay days−1 ngày tới hết hôm nay (UTC)", () => {
    const w = utcDayWindow(14, new Date("2026-09-30T11:05:00.000Z"));
    expect(w.from.toISOString()).toBe("2026-09-17T00:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(dailyOutcomes([], w)).toHaveLength(14);
  });
});
```

- [ ] **Step 2: chạy — đỏ** (`utcDayWindow` chưa có): `npx vitest run tests/dora.test.ts`

- [ ] **Step 3: hiện thực** trong `deployment.dora.ts`, ngay sau `dailyOutcomes`:

```ts
/**
 * [v4.11, Plan #57] Cửa sổ `days` NGÀY LỊCH UTC tới hết hôm nay — một định nghĩa cho E10 của trang Bằng chứng và
 * biểu đồ deploy của trang Kiến trúc. Cửa sổ cuộn (`now − days`) chạm `days + 1` ngày lịch.
 */
export function utcDayWindow(
  days: number,
  now: Date,
): { from: Date; to: Date } {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  return {
    from: new Date(today - (days - 1) * DAY_MS),
    to: new Date(today + DAY_MS),
  };
}
```

và `platformDora` thay ba dòng tự tính cửa sổ bằng `const window = utcDayWindow(days, now);` (xoá hằng `DAY_MS` riêng
của service nếu không còn dùng).

- [ ] **Step 4: wire** — trong `wire.ts`, tách hình ngày của `platformDoraWire.daily` thành hằng dùng chung:

```ts
/** [v4.11, Plan #56/#57] Kết cục deploy của MỘT ngày UTC */
export const deployDayWire = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    success: z.number().int().nonnegative(),
    failure: z.number().int().nonnegative(),
  })
  .strict();
export const ARCHITECTURE_DEPLOY_DAYS = 14;
```

`platformDoraWire.daily: z.array(deployDayWire)`; `architectureResponseWire.architecture` thêm
`deploys: z.array(deployDayWire)` (sau `edges`); type `DeployDayWire`.

- [ ] **Step 5: repository + service** — `deployment.repository.ts`:

```ts
/** [v4.11, Plan #57] Sự kiện deploy của MỌI environment của một project trong cửa sổ */
export async function eventsOfProject(
  projectId: string,
  from: Date,
  to: Date,
): Promise<DeploymentEventRow[]> {
  return prisma.deploymentEvent.findMany({
    where: { projectId, occurredAt: { gte: from, lt: to } },
    orderBy: { occurredAt: "asc" },
    select: EVENT_FIELDS,
  });
}
```

`architecture.service.ts`: thêm vào `Promise.all` phần tử `eventsOfProject(projectId, window.from, window.to)` với
`const window = utcDayWindow(ARCHITECTURE_DEPLOY_DAYS, now)`, và trả `deploys: dailyOutcomes(events, window)`.

- [ ] **Step 6: test tích hợp** — trong `dashboards.integration.test.ts`, ô "ghép cloud, cluster…" thêm:

```ts
expect(a.deploys).toHaveLength(14);
const total = a.deploys.reduce((s, d) => s + d.success + d.failure, 0);
expect(total).toBeGreaterThan(0);
expect(a.deploys.at(-1)?.date).toBe(new Date().toISOString().slice(0, 10));
```

(dữ liệu mẫu của tệp đã chèn DEPLOY_SUCCESS 2 giờ trước và DEPLOY_FAILURE ở dev).

- [ ] **Step 7: bản xem thử** — `architectureOf` trả thêm `deploys` dựng từ `p.deployments` của mọi env: 14 ngày UTC,
      đếm `DEPLOY_SUCCESS`/`DEPLOY_FAILURE` theo `lastEventAt` (cùng cách `platformDoraOf`).

- [ ] **Step 8: cổng 57a** — `npx vitest run tests/dora.test.ts tests/dashboards.integration.test.ts
tests/admin.integration.test.ts tests/wire-golden.test.ts` (S1), ghi lại golden
      `UDP_CAPTURE_WIRE=1 npx vitest run tests/dashboards.integration.test.ts` (hoàn nguyên mẫu khác bị đổi),
      `npx vitest run --config demo/vitest.config.ts` (Portal), typecheck, lint, prettier.

- [ ] **Step 9: commit** `P57a: architecture.deploys — deploy 14 ngày cho trang Kiến trúc; utcDayWindow dùng chung`

---

### Task 2 (đợt 57b): góc "Tổng quan hệ thống"

**Files:**

- Create: `apps/portal/src/components/LinkLayer.tsx`
- Create: `apps/portal/src/features/architecture/system-model.ts`
- Create: `apps/portal/src/features/architecture/system.messages.tsx`
- Create: `apps/portal/src/features/architecture/SystemOverview.tsx`
- Modify: `apps/portal/src/features/architecture/ArchitecturePage.tsx`, `apps/portal/src/app/router.tsx`
  (`architectureRoute.validateSearch` thêm `view`), `apps/portal/src/styles/portal.css`,
  `apps/portal/tests/design-lint.test.ts` (khai `LinkLayer.tsx` có `<svg>`)
- Test: `apps/portal/tests/system-overview.test.tsx`

**Interfaces:**

- Consumes: `architecture.deploys` (Task 1); `toolHealth` (architecture-model.ts); `monitoringApi.red`.
- Produces:
  - `LinkLayer({ container, links, active?, version })`; `LayerLink = { from: string; to: string; label?: string;
dashed?: boolean; axis?: "x" | "y" }` — nút là phần tử có `data-node="<id>"`.
  - `SystemRole` = `"users" | "git" | "envs" | DomainType`; `systemLinks(present: ReadonlySet<string>):
SystemLink[]` với `SystemLink = { from; to; kind: LinkKind; dashed; axis? }`,
    `LinkKind = "https" | "route" | "mtls" | "sql" | "secrets" | "telemetry" | "webhook" | "push" | "tag" | "sync" |
"canary" | "metricsQuery"`.
  - `redSummary(workloads: WorkloadRedWire[]): { requestRate: number | null; errorRatio: number | null;
latencyP99Ms: number | null }` (điểm cuối có dữ liệu của mỗi chuỗi; rate cộng, lỗi theo trọng số rate, p99 lấy max).

- [ ] **Step 1: test thuần** `tests/system-overview.test.tsx` (phần model):

```ts
describe("systemLinks", () => {
  const all = new Set([
    "users",
    "git",
    "envs",
    "INGRESS",
    "SERVICE_MESH",
    "CICD",
    "CONTAINER_REGISTRY",
    "GITOPS",
    "PROGRESSIVE_DELIVERY",
    "DATABASE",
    "SECRETS",
    "MONITORING",
    "COST",
  ]);
  it("đủ domain ⇒ chuỗi lưu lượng users → INGRESS → SERVICE_MESH → envs", () => {
    const l = systemLinks(all);
    expect(l).toContainEqual(
      expect.objectContaining({ from: "users", to: "INGRESS", kind: "https" }),
    );
    expect(l).toContainEqual(
      expect.objectContaining({
        from: "SERVICE_MESH",
        to: "envs",
        kind: "mtls",
      }),
    );
  });
  it("vắng Service Mesh ⇒ Ingress nối thẳng environment; vắng cả hai ⇒ users → envs", () => {
    const noMesh = new Set([...all].filter((x) => x !== "SERVICE_MESH"));
    expect(systemLinks(noMesh)).toContainEqual(
      expect.objectContaining({ from: "INGRESS", to: "envs" }),
    );
    const bare = new Set(["users", "git", "envs"]);
    expect(systemLinks(bare)).toContainEqual(
      expect.objectContaining({ from: "users", to: "envs", kind: "https" }),
    );
  });
  it("giao hàng nối qua domain vắng: git → CI → Registry → (GitOps vắng) → Progressive → envs", () => {
    const s = new Set([
      "users",
      "git",
      "envs",
      "CICD",
      "CONTAINER_REGISTRY",
      "PROGRESSIVE_DELIVERY",
    ]);
    const l = systemLinks(s);
    expect(l).toContainEqual(
      expect.objectContaining({
        from: "CONTAINER_REGISTRY",
        to: "PROGRESSIVE_DELIVERY",
      }),
    );
    expect(l.every((x) => s.has(x.from) && s.has(x.to))).toBe(true);
  });
});

describe("redSummary", () => {
  it("điểm cuối có dữ liệu; rate cộng, lỗi theo trọng số, p99 lấy max; không dữ liệu ⇒ null", () => {
    expect(
      redSummary([
        {
          workload: "a",
          requestRate: [1, 10, null],
          errorRatio: [0, 0.1, null],
          latencyP99Ms: [5, 100, null],
        },
        {
          workload: "b",
          requestRate: [30],
          errorRatio: [0],
          latencyP99Ms: [40],
        },
      ]),
    ).toEqual({ requestRate: 40, errorRatio: 0.025, latencyP99Ms: 100 });
    expect(redSummary([])).toEqual({
      requestRate: null,
      errorRatio: null,
      latencyP99Ms: null,
    });
  });
});
```

- [ ] **Step 2: chạy — đỏ.**

- [ ] **Step 3: `system-model.ts`** — hiện thực (thuần, không chữ giao diện: `kind` là mã, chữ ở messages):

```ts
/** Chuỗi theo vai trò: phần tử đầu tiên CÓ MẶT sau `from` là đích của cạnh (nối qua domain vắng) */
const CHAINS: { path: string[]; kinds: LinkKind[]; dashed: boolean }[] = [
  {
    path: ["users", "INGRESS", "SERVICE_MESH", "envs"],
    kinds: ["https", "route", "mtls"],
    dashed: false,
  },
  {
    path: [
      "git",
      "CICD",
      "CONTAINER_REGISTRY",
      "ARTIFACT_REGISTRY",
      "GITOPS",
      "PROGRESSIVE_DELIVERY",
      "envs",
    ],
    kinds: ["webhook", "push", "tag", "tag", "sync", "canary"],
    dashed: true,
  },
];
// + cạnh đơn: envs → DATABASE (sql), envs → SECRETS (secrets, dashed), envs → MONITORING/LOGGING/TRACING
//   (telemetry, dashed, axis "y" tới thành phần đầu tiên có mặt của dải Quan sát), COST → MONITORING (metricsQuery)
```

Cạnh của chuỗi: với mỗi phần tử có mặt `a` (trừ đích cuối), đích là phần tử có mặt kế tiếp; `kind` là kind của cạnh
đứng ngay trước đích trong chuỗi (ví dụ users → envs khi thiếu cả Ingress lẫn Mesh vẫn là `https`: kind của cạnh ĐẦU
TIÊN rời `users`).

- [ ] **Step 4: `LinkLayer.tsx`** — tổng quát hoá `EdgeLayer`: đo `[data-node]` trong `container` bằng
      `ResizeObserver` (không đo trong render), vẽ hai `<svg aria-hidden>`: đường (dưới thẻ) và nhãn (trên thẻ); đường cong
      bezier theo `axis` (tự chọn: dọc khi chênh dọc lớn hơn 1,4 lần chênh ngang), `dashed` ⇒ `stroke-dasharray`, cạnh của
      `active` dùng `--accent`, cạnh khác mờ khi có `active`. Khai `LinkLayer.tsx` trong danh sách `<svg>` của design-lint.

- [ ] **Step 5: `SystemOverview.tsx` + messages** — bố cục CSS grid đúng bản mẫu đã duyệt (dải Giao hàng, cột Người
      dùng, Lưu lượng, khung environment theo `rank`, Dữ liệu, dải Quan sát, Quản trị); thẻ công cụ là `button` gọi
      `onSelect(tool.key)` (mở `ToolPanel` hiện có); workload là link tới trang Deploy (`?env=`); bốn thẻ số liệu (công cụ
      theo sức khoẻ, workload/env, deploy 14 ngày dùng `BarChart` nhỏ, RED production từ `monitoringApi.red(prodEnvId,
"6h")` qua `redSummary`, lỗi `metrics-not-enabled` ⇒ câu + link trang Domain); chú giải; nút **Xem dạng bảng** hiện
      hai `table.dtable` (thành phần; kết nối).

- [ ] **Step 6: bộ chọn góc nhìn** — `architectureRoute.validateSearch` thêm `view?: "infra"`; `ArchitecturePage` hiện
      `role="tablist"` hai tab (`Tổng quan hệ thống`, `Hạ tầng & công cụ`), nội dung cũ nguyên vẹn khi `view === "infra"`.

- [ ] **Step 7: test trang** (msw + golden `GET /projects/{id}/architecture` đã có `deploys`):
      mặc định là tổng quan (thấy "Người dùng cuối", khung env, nút "Xem dạng bảng"); `?view=infra` thấy sơ đồ cũ (bậc);
      bấm thẻ Monitoring ⇒ panel "Monitoring"; bảng kết nối có dòng "Ingress → Service Mesh"; thẻ RED hiện p99 và tỉ lệ
      lỗi từ golden `GET /projects/{id}/metrics/red`, còn khi msw trả problem `metrics-not-enabled` thì thẻ nói "chưa có
      nguồn metrics" và có link trang Domain (AC-4); tiếng Anh: khung không còn tiếng Việt.

- [ ] **Step 8: cổng 57b** — Portal: `npx vitest run`, `npx tsc --noEmit -p .`, `npx eslint src tests`, prettier.

- [ ] **Step 9: commit** `P57b: Portal — góc "Tổng quan hệ thống" (C4) cho trang Kiến trúc; LinkLayer`

---

### Task 3 (đợt 57c): trang "Kiến trúc nền tảng" của Bảng điều khiển

**Files:**

- Create: `apps/portal/src/features/admin/platform-architecture.ts`
- Create: `apps/portal/src/features/admin/pages/AdminArchitecturePage.tsx`
- Modify: `apps/portal/src/features/admin/admin.messages.tsx` (khối `architecture` vi/en),
  `apps/portal/src/features/admin/AdminLayout.tsx` (mục nav, icon `Network`), `apps/portal/src/app/app.messages.tsx`
  (`consoleNav.architecture`), `apps/portal/src/app/router.tsx` (route `architecture`), `portal.css`
- Test: `apps/portal/tests/admin-architecture.test.tsx`

**Interfaces:**

- Consumes: `adminApi.system`, `adminApi.platform`, `adminApi.overview` (có sẵn); `platformReason`, `serviceStatus`
  (platform-model.ts); `LinkLayer` (Task 2).
- Produces: `PLATFORM_NODES` (id, vùng: `inside` | `left` | `right`, loại: `svc` | `ext` | `actor`),
  `PLATFORM_LINKS` (from, to, `protocol` mã: `https` | `restSse` | `sseOfrep` | `webhook` | `sqlQueue` | `listenNotify`
  | `sqlLease` | `cloudApi` | `token` | `metricsQuery` | `pgDump`, dashed), `serviceHealth(system, name)`.

- [ ] **Step 1: test** `admin-architecture.test.tsx`: với golden `/admin/system/health`, `/admin/platform`,
      `/admin/overview` ⇒ thấy bảy khối trong máy và tám hệ ngoài, ba thanh ngân sách; đổi golden system thành
      `udp-pd-controller: down` ⇒ thẻ pd-controller "Không phản hồi"; `platform.node.state = "unavailable"` ⇒ "Không rõ"
      kèm lý do; "Xem dạng bảng" có dòng "SDK trong ứng dụng → flag-service · SSE · OFREP"; người không phải admin về
      `/app/home`.
- [ ] **Step 2: chạy — đỏ.**
- [ ] **Step 3: hiện thực** `platform-architecture.ts` (thuần) và `AdminArchitecturePage` (khung VM với grid-area
      `". portal ." "s2 s1 s3" ". pg backup"`, cột trái/phải, `LinkLayer`, bốn thẻ số liệu, ba thanh `Meter`, chú giải,
      bảng thay thế), route + nav.
- [ ] **Step 4: chạy — xanh.**
- [ ] **Step 5: cổng 57c** như 57b.
- [ ] **Step 6: commit** `P57c: Bảng điều khiển — trang "Kiến trúc nền tảng" (C4 container + deployment, sức khoẻ sống)`

---

### Task 4 (đợt 57d): bản xem thử, cổng, tài liệu

**Files:**

- Modify: `apps/portal/demo/screens.pw.ts` — màn `architecture` (mặc định tổng quan, phải có `.sys-map [data-node]`),
  `architecture-infra` (`?view=infra&tool=monitoring:prometheus-grafana`, phải có `.arch-edges path.on`),
  `admin-architecture` (phải có `.plat-map [data-node]`)
- Modify: `apps/portal/demo/contract.check.ts` — `architecture.deploys` có 14 phần tử ở mọi project
- Modify: `docs/UDP_design.md` (§10.6 góc nhìn, §10.11 trang mới, §10.14, D-P50), `docs/design/DESIGN.md` (sơ đồ tổng
  quan: nhãn trên lớp trên cùng, không chỉ màu, bản bảng), `docs/ban-giao/trang-thai-2026-09-30.md` (1e),
  `docs/plans/plan57-plan.md` (kết quả)

- [ ] **Step 1:** cập nhật màn + contract; `npx vitest run --config demo/vitest.config.ts` xanh.
- [ ] **Step 2:** build bản xem thử, cổng Playwright năm lượt (`npx playwright test --config demo/playwright.config.ts`).
- [ ] **Step 3:** tài liệu; design-lint repo; prettier.
- [ ] **Step 4: commit** `P57d: bản xem thử và cổng cho hai sơ đồ; tài liệu Plan #57`

---

## Kết quả (30/09/2026)

| Đợt | Commit     | Cổng                                                                                                                                                                                                   |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 57a | `08e3c3c`  | S1: dora, dashboards, admin, wire-golden, wire-routes (162 test) xanh; golden `GET /projects/{id}/architecture` ghi lại; contract                                                                      |
| 57b | `52d3188`  | Portal 256 test, typecheck (cả demo), eslint, prettier xanh                                                                                                                                            |
| 57c | `1623be0`  | Portal 263 test, typecheck, eslint, prettier xanh                                                                                                                                                      |
| 57d | commit này | Cổng `portal-demo`: lượt desktop và mobile ĐẠT với ba màn mới; ba lượt còn lại (tối, tối di động, tiếng Anh) chưa chạy xong lúc người dùng tắt máy — chạy lại `pnpm --filter @udp/portal demo:screens` |

Lệch so với kế hoạch, có lý do:

- `deployDayWire` dùng lại hình sẵn có của trang chủ thay vì thêm `dailyDeployWire`; trang chủ cũng chuyển sang
  `utcDayWindow` (một định nghĩa cửa sổ ngày).
- `dailyOutcomes` gom theo cặp (env, `deployment_id`) khi gộp nhiều env — đúng Deployment Frequency của §2.2
  (provisioning ghi cùng `deployment_id` cho mỗi env).
- Bỏ cạnh Cost → Monitoring khỏi Tổng quan hệ thống: nó chạy ngang qua thẻ Logging/Tracing cùng hàng; quan hệ đó
  vẫn ở góc "Hạ tầng & công cụ" (cạnh capability `metrics.query`).
- Sơ đồ nền tảng đối chiếu với mã: S1 (không phải S3) đọc Prometheus của khách; thêm S1 → S2, S3 → S1, S3 → S2.
  PostgreSQL đặt giữa để bốn khối nối nhau đôi một mà không cạnh nào xuyên thẻ; `LinkLayer` thêm kiểu `under`.
- Thêm `DiagramBar`, `StackedBar`, `deployBars` dùng chung; sửa một lỗi lint có sẵn ở `demo/screens.pw.ts`.
