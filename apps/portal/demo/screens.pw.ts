import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DEMO_INVITE_TOKEN } from "./mock/demo-invite";

/**
 * [Plan #53 QĐ-11, Plan #54 QĐ-4] Mọi màn của hai khung qua NĂM lượt: máy tính (1440×900) và điện thoại
 * (375×812 — tiêu chí của mục nợ `portal-responsive`) ở giao diện sáng, cả hai ở giao diện TỐI, và máy tính bằng
 * TIẾNG ANH. Mỗi màn phải: không lỗi console, không tràn ngang, có đúng một `main` và một `h1`, không rơi vào
 * trang "Không tìm thấy", không gặp route mà lớp giả lập chưa có, không hiện lỗi tải, không có "...", có phần
 * chính của nó, và **đủ tương phản chữ WCAG AA** (axe-core `color-contrast`) — thứ quyết định một giao diện tối
 * "dùng được". Lượt tiếng Anh thêm: `<html lang="en">` và khung (thanh bên, tiêu đề, đầu bảng, nhãn) không còn
 * chữ tiếng Việt. Ảnh chụp cả trang nằm ở `demo/screens/<lượt>/` để người xem; không so pixel.
 */

type Locale = "vi" | "en";
type Theme = "light" | "dark";

interface Pass {
  name: string;
  width: number;
  height: number;
  locale: Locale;
  theme: Theme;
}

const PASSES: readonly Pass[] = [
  { name: "desktop", width: 1440, height: 900, locale: "vi", theme: "light" },
  { name: "mobile", width: 375, height: 812, locale: "vi", theme: "light" },
  {
    name: "desktop-dark",
    width: 1440,
    height: 900,
    locale: "vi",
    theme: "dark",
  },
  { name: "mobile-dark", width: 375, height: 812, locale: "vi", theme: "dark" },
  {
    name: "desktop-en",
    width: 1440,
    height: 900,
    locale: "en",
    theme: "light",
  },
];

/** Chữ mà cổng tự đọc để biết trang đã tải xong hay rơi vào 404 — theo ngôn ngữ của lượt */
const TEXT: Record<Locale, { loading: string; notFound: string }> = {
  vi: { loading: "Đang tải…", notFound: "Không tìm thấy trang" },
  en: { loading: "Loading…", notFound: "Page not found" },
};

interface Ids {
  checkout: string;
  marketing: string;
  rollout: string;
  /** Project nháp: các bước của wizard mở lại được từ URL (`?project=&step=`) */
  draft: string;
  /** [Plan #55] Nhóm mà người xem là chủ nhóm — đủ form mời, lời mời đang chờ, cài đặt nhóm */
  team: string;
}

/** Tên, đường dẫn, và (tuỳ màn) một locator PHẢI có — bằng chứng màn đã vẽ phần chính của nó */
type Screen = [name: string, path: (ids: Ids) => string, must?: string];

const SCREENS: Screen[] = [
  ["home", () => "/app/home", ".bc-col"],
  ["projects", () => "/app/projects"],
  // [Plan #55] Nhóm, chi tiết nhóm, và trang nhận lời mời (token ở fragment, ngoài hai khung)
  ["teams", () => "/app/teams", "[role=list]"],
  ["team", (i) => `/app/teams/${i.team}`, "[role=list]"],
  ["invite", () => `/invite#${DEMO_INVITE_TOKEN}`, ".auth-card .btn.pri"],
  ["new-project", () => "/app/projects/new"],
  ...(["cloud", "domains", "preview"] as const).map((step): Screen => [
    `new-project-${step}`,
    (i) => `/app/projects/new?project=${i.draft}&step=${step}`,
    // Chân trang của bước tách khỏi nút của panel phía trên
    ".wizard-nav",
  ]),
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
    // Trạng thái "chưa có nguồn metrics" dẫn sang trang Domain — không phụ thuộc ngôn ngữ
    '.state a[href$="/domains"]',
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
  // [Plan #56] Bằng chứng thực nghiệm: biểu đồ đọc từ tệp thô, E10 từ lớp giả lập
  ["admin-evidence", () => "/admin/evidence", "figure.cc"],
];

/** Font từ Google không tải được (máy không mạng) không phải lỗi của Portal */
const IGNORED_CONSOLE = /fonts\.(googleapis|gstatic)\.com/;

const VI =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

/**
 * Chỗ của KHUNG — chữ ở đây do Portal viết, không phải dữ liệu người dùng (tên người, mô tả flag vẫn là tiếng Việt
 * của dữ liệu mẫu): điều hướng, tiêu đề trang, đầu bảng, nhãn ô nhập.
 */
const CHROME = "nav, h1, thead, label";

/**
 * Chữ của khung, BỎ phần đánh dấu `translate="no"` — quy ước của Portal cho dữ liệu người dùng không bao giờ dịch
 * (tên project, tên nhóm, khoá flag). [Plan #55] Trang chi tiết nhóm có `h1` là tên nhóm "Nhóm thanh toán": chữ
 * đó đúng là tiếng Việt ở mọi ngôn ngữ, và không phải lỗi dịch.
 */
async function chromeTexts(page: Page): Promise<string[]> {
  return page.locator(CHROME).evaluateAll((nodes) =>
    nodes.map((node) => {
      if (node.getAttribute("translate") === "no") return "";
      const copy = node.cloneNode(true) as Element;
      for (const data of copy.querySelectorAll('[translate="no"]')) {
        data.remove();
      }
      return copy.textContent;
    }),
  );
}

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
    const { teams } = await get<{ teams: { id: string; name: string }[] }>(
      "/teams",
    );
    const team = teams.find((t) => t.name === "Nhóm thanh toán");
    if (team === undefined) throw new Error("thiếu nhóm Nhóm thanh toán");
    return {
      checkout,
      marketing: id("marketing-site"),
      rollout: live.id,
      draft: id("analytics-api"),
      team: team.id,
    };
  });
}

/** Mỗi chỗ thiếu tương phản một dòng: phần tử, tỉ lệ đo được, tỉ lệ cần */
async function contrastProblems(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => {
      const data = (n.any[0]?.data ?? {}) as {
        contrastRatio?: number;
        expectedContrastRatio?: string;
        fgColor?: string;
        bgColor?: string;
      };
      return `tương phản ${String(data.contrastRatio ?? "?")}:1 < ${data.expectedContrastRatio ?? "4.5:1"} (${data.fgColor ?? "?"} trên ${data.bgColor ?? "?"}) ở ${n.target.join(" ")}`;
    }),
  );
}

for (const pass of PASSES) {
  test.describe(`${pass.name} ${String(pass.width)}×${String(pass.height)}`, () => {
    test.use({
      viewport: { width: pass.width, height: pass.height },
      colorScheme: pass.theme,
    });
    test.setTimeout(600_000);

    test("mọi màn đạt", async ({ page }) => {
      // Lựa chọn tay của người dùng, đặt TRƯỚC khi trang chạy: theme-boot.js và store ngôn ngữ đọc lúc khởi động
      await page.addInitScript(
        ([locale, theme]) => {
          localStorage.setItem("udp_locale", locale);
          localStorage.setItem("udp_theme", theme);
        },
        [pass.locale, pass.theme] as const,
      );
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
        await expect(page.getByText(TEXT[pass.locale].loading)).toHaveCount(0, {
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
        if (text.includes(TEXT[pass.locale].notFound))
          problems.push("trang Không tìm thấy");
        if (text.includes("Bản xem thử chưa có"))
          problems.push("route giả chưa có");
        if (text.includes("...")) problems.push('chữ có "..."');
        if (must !== undefined && (await page.locator(must).count()) === 0)
          problems.push(`thiếu ${must}`);

        const root = await page.evaluate(() => ({
          lang: document.documentElement.lang,
          theme: document.documentElement.dataset.theme,
        }));
        if (root.lang !== pass.locale) problems.push(`lang="${root.lang}"`);
        if (root.theme !== pass.theme)
          problems.push(`theme="${String(root.theme)}"`);
        if (pass.locale === "en") {
          const chrome = await chromeTexts(page);
          const vi = chrome.filter((t) => VI.test(t));
          if (vi.length > 0)
            problems.push(
              `khung còn tiếng Việt: ${vi.slice(0, 3).join(" | ")}`,
            );
        }
        problems.push(...(await contrastProblems(page)));
        if (errors.length > 0) problems.push(`console: ${errors.join(" | ")}`);

        await page.screenshot({
          path: fileURLToPath(
            new URL(`./screens/${pass.name}/${name}.png`, import.meta.url),
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
