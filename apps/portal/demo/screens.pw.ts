import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * [Plan #53 QĐ-11] Mọi màn của hai khung, ở máy tính (1440×900) và điện thoại (375×812 — tiêu chí của mục nợ
 * `portal-responsive`). Mỗi màn phải: không lỗi console, không tràn ngang, có đúng một `main` và một `h1`, không
 * rơi vào trang "Không tìm thấy", không gặp route mà lớp giả lập chưa có, không hiện lỗi tải, không có "...".
 * Ảnh chụp cả trang nằm ở `demo/screens/<khung>/` để người xem.
 */

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 375, height: 812 },
] as const;

interface Ids {
  checkout: string;
  marketing: string;
  rollout: string;
}

/** Tên, đường dẫn, và (tuỳ màn) một locator PHẢI có — bằng chứng màn đã vẽ phần chính của nó */
type Screen = [name: string, path: (ids: Ids) => string, must?: string];

const SCREENS: Screen[] = [
  ["home", () => "/app/home", ".bc-col"],
  ["projects", () => "/app/projects"],
  ["new-project", () => "/app/projects/new"],
  ["overview", (i) => `/app/projects/${i.checkout}`, ".health-cell"],
  [
    "architecture",
    (i) =>
      `/app/projects/${i.checkout}/architecture?tool=monitoring:prometheus-grafana`,
    // Cạnh của công cụ đang chọn nổi lên: lớp cạnh đã đo và vẽ sau layout
    ".arch-edges path.on",
  ],
  [
    "monitoring",
    (i) => `/app/projects/${i.checkout}/monitoring`,
    ".red-row svg",
  ],
  [
    "monitoring-off",
    (i) => `/app/projects/${i.marketing}/monitoring`,
    "text=Chưa có nguồn metrics",
  ],
  ["flags", (i) => `/app/projects/${i.checkout}/flags`],
  ["flags-cleanup", (i) => `/app/projects/${i.checkout}/flags/cleanup`],
  ["segments", (i) => `/app/projects/${i.checkout}/segments`],
  ["rollouts", (i) => `/app/projects/${i.checkout}/rollouts`],
  ["rollout", (i) => `/app/projects/${i.checkout}/rollouts/${i.rollout}`],
  ["deployments", (i) => `/app/projects/${i.checkout}/deployments`],
  ["code", (i) => `/app/projects/${i.checkout}/code`],
  ["domains", (i) => `/app/projects/${i.checkout}/domains`],
  ["domain", (i) => `/app/projects/${i.checkout}/domains/MONITORING`],
  ["infra", (i) => `/app/projects/${i.checkout}/infra`],
  ["settings", (i) => `/app/projects/${i.checkout}/settings`],
  ...(["environments", "members", "audit", "cloud", "project"] as const).map(
    (tab): Screen => [
      `settings-${tab}`,
      (i) => `/app/projects/${i.checkout}/settings?tab=${tab}`,
    ],
  ),
  ["login", () => "/login"],
  ["register", () => "/register"],
  ["admin-overview", () => "/admin/overview", "[role=meter]"],
  ["admin-users", () => "/admin/users"],
  ["admin-projects", () => "/admin/projects"],
  ["admin-jobs", () => "/admin/jobs"],
  ["admin-orphans", () => "/admin/orphans"],
  ["admin-credentials", () => "/admin/credentials"],
  ["admin-system", () => "/admin/system"],
  ["admin-catalog", () => "/admin/catalog"],
];

/** Font từ Google không tải được (máy không mạng) không phải lỗi của Portal */
const IGNORED_CONSOLE = /fonts\.(googleapis|gstatic)\.com/;

/** Id của dữ liệu mẫu, hỏi thẳng lớp giả lập trong trang (id tất định nhưng sinh ra, không viết tay) */
async function discover(page: Page): Promise<Ids> {
  await page.goto("./#/app/home");
  await expect(page.locator("h1")).toHaveCount(1);
  return page.evaluate(async () => {
    const get = async <T>(path: string): Promise<T> =>
      (await (await fetch(`/api/v1${path}`)).json()) as T;
    const { projects } = await get<{
      projects: { id: string; name: string }[];
    }>("/projects?limit=50");
    const id = (name: string): string => {
      const found = projects.find((p) => p.name === name);
      if (found === undefined) throw new Error(`thiếu project ${name}`);
      return found.id;
    };
    const checkout = id("checkout-service");
    const { rollouts } = await get<{
      rollouts: { id: string; status: string }[];
    }>(`/projects/${checkout}/rollouts`);
    const live = rollouts.find((r) => r.status === "IN_PROGRESS");
    if (live === undefined) throw new Error("thiếu rollout đang chạy");
    return { checkout, marketing: id("marketing-site"), rollout: live.id };
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${String(viewport.width)}×${String(viewport.height)}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("mọi màn đạt", async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error" && !IGNORED_CONSOLE.test(msg.text())) {
          errors.push(msg.text());
        }
      });
      page.on("pageerror", (e) => errors.push(e.message));

      const ids = await discover(page);
      const failures: string[] = [];

      for (const [name, path, must] of SCREENS) {
        errors.length = 0;
        await page.goto(`./#${path(ids)}`);
        await expect(page.locator("h1").first()).toBeVisible();
        await expect(page.getByText("Đang tải…")).toHaveCount(0, {
          timeout: 15_000,
        });
        // Biểu đồ đo khung bằng ResizeObserver; lớp cạnh của sơ đồ vẽ sau layout
        await page.waitForTimeout(250);

        const problems: string[] = [];
        const h1 = await page.locator("h1").count();
        if (h1 !== 1) problems.push(`${String(h1)} thẻ h1`);
        const mains = await page.locator("main").count();
        if (mains !== 1) problems.push(`${String(mains)} thẻ main`);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        if (overflow > 1) problems.push(`tràn ngang ${String(overflow)}px`);
        const loadErrors = await page.locator(".state[role='alert']").count();
        if (loadErrors > 0) problems.push(`${String(loadErrors)} lỗi tải`);
        const text = await page.locator("body").innerText();
        if (text.includes("Không tìm thấy trang"))
          problems.push("trang Không tìm thấy");
        if (text.includes("Bản xem thử chưa có"))
          problems.push("route giả chưa có");
        if (text.includes("...")) problems.push('chữ có "..."');
        if (must !== undefined && (await page.locator(must).count()) === 0)
          problems.push(`thiếu ${must}`);
        if (errors.length > 0) problems.push(`console: ${errors.join(" | ")}`);

        await page.screenshot({
          path: fileURLToPath(
            new URL(`./screens/${viewport.name}/${name}.png`, import.meta.url),
          ),
          fullPage: true,
        });
        if (problems.length > 0)
          failures.push(`${name}: ${problems.join("; ")}`);
      }

      expect(failures).toEqual([]);
    });
  });
}
