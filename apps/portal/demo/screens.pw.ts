import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { discover, type Ids } from "./ids";
import { DEMO_INVITE_TOKEN } from "./mock/demo-invite";
import { PERSONA_KEY, type PersonaId } from "./mock/persona";

/**
 * [Plan #53 QĐ-11, Plan #54 QĐ-4] Mọi màn của hai khung qua NĂM lượt: máy tính (1440×900) và điện thoại
 * (375×812 — tiêu chí của mục nợ `portal-responsive`) ở giao diện sáng, cả hai ở giao diện TỐI, và máy tính bằng
 * TIẾNG ANH. Mỗi màn phải: không lỗi console, không tràn ngang, có đúng một `main` và một `h1`, không rơi vào
 * trang "Không tìm thấy", không gặp route mà lớp giả lập chưa có, không hiện lỗi tải, không có "..." trong câu chữ, có phần
 * chính của nó, và **đủ tương phản chữ WCAG AA** (axe-core `color-contrast`) — thứ quyết định một giao diện tối
 * "dùng được". Lượt tiếng Anh thêm: `<html lang="en">` và khung (thanh bên, tiêu đề, đầu bảng, nhãn) không còn
 * chữ tiếng Việt. Ảnh chụp cả trang nằm ở `demo/screens/<lượt>/` để người xem; không so pixel.
 *
 * [Plan #58] Mỗi lượt thêm bốn màn LẦN ĐẦU DÙNG, xem bằng vai "Người mới" của dải Bản xem thử (chưa project, chưa
 * nhóm): khoá vai đặt vào `sessionStorage` trước khi trang chạy, lớp giả lập dựng dữ liệu cho đúng người đó.
 * [Plan #59] Và ba màn của khách chưa đăng nhập: trang giới thiệu, đăng nhập, đăng ký.
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
  // [Plan #58 UX-12, UX-17] Thẻ "Bắt đầu" của chủ project, và các trạng thái trống có lối đi tiếp
  ["overview-start", (i) => `/app/projects/${i.voucher}`, ".start-card"],
  [
    "settings-keys-empty",
    (i) =>
      `/app/projects/${i.voucher}/settings?tab=keys&env=${i.voucherStaging}`,
    ".state .empty-why",
  ],
  [
    "rollouts-empty",
    (i) => `/app/projects/${i.shipping}/rollouts`,
    ".state .empty-body",
  ],
  // [Plan #57] Tổng quan hệ thống (mặc định): lớp cạnh vai trò đã đo và vẽ sau layout, nhãn nằm trên thẻ
  [
    "architecture",
    (i) => `/app/projects/${i.checkout}/architecture`,
    ".sys-map .link-labels span",
  ],
  [
    "architecture-infra",
    (i) =>
      `/app/projects/${i.checkout}/architecture?view=infra&tool=monitoring:prometheus-grafana`,
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
  [
    "rollout-breach",
    (i) => `/app/projects/${i.checkout}/rollouts/${i.rolloutBreach}`,
    ".alert.amber",
  ],
  ["deployments", (i) => `/app/projects/${i.checkout}/deployments`],
  ["code", (i) => `/app/projects/${i.checkout}/code`],
  // [Plan #61] Mục Đóng gói còn việc: danh tính build (script, ô dán), cài đặt build
  [
    "code-packaging",
    (i) => `/app/projects/${i.packaging}/code`,
    ".packaging-identity textarea",
  ],
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
  // [Plan #58 UX-27] Dải "Cần xử lý" luôn có, kể cả khi mọi tín hiệu xanh (khi đó nó nói "Mọi thứ ổn")
  ["admin-overview", () => "/admin/overview", "section.attn"],
  ["admin-users", () => "/admin/users"],
  ["admin-projects", () => "/admin/projects"],
  // [Plan #58 UX-28] Tab "Dọn chưa hết": tài nguyên còn trên cloud của khách
  ["admin-jobs", () => "/admin/jobs?state=COMPENSATION_FAILED", ".job-list li"],
  ["admin-orphans", () => "/admin/orphans", ".dtable tbody tr"],
  ["admin-credentials", () => "/admin/credentials"],
  // [Plan #57] Kiến trúc nền tảng: khối trong máy ảo và cạnh ghi giao thức, sức khoẻ sống từ ba route
  [
    "admin-architecture",
    () => "/admin/architecture",
    ".plat-map .link-labels span",
  ],
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
 * Chỗ NGUYÊN VĂN của trang: chữ ở đây là thứ UDP TRÍCH từ nơi khác và phải in lại đúng từng ký tự — lệnh shell,
 * tên tệp, đoạn script người dùng dán vào cloud.
 */
const VERBATIM = "code, pre, kbd, samp, textarea, input";

/**
 * Chữ CÂU CHỮ của trang: mọi chữ TRỪ phần nguyên văn.
 *
 * [Plan #61] Luật "không có `...`" là luật về CÂU CHỮ: quy ước của Portal là dấu `…`, nên ba dấu chấm trong một câu
 * là chữ bị cắt giữa đường hay một bản nháp còn sót. Trong phần nguyên văn thì ba dấu chấm là DỮ LIỆU: lệnh test mặc
 * định của một repo Go là `go test ./...` (`build-plan.ts`), và đổi nó thành `go test ./…` là đưa cho người dùng một
 * lệnh chạy không được. Cổng này đã đỏ ở màn Đóng gói của Plan #61 đúng vì chỗ đó — luật sai, không phải dữ liệu sai.
 *
 * Dùng `textContent` của một bản sao đã bỏ các nút nguyên văn, chứ không `innerText`: `textContent` thấy cả chữ đang
 * ẩn (thẻ chưa mở, nhãn cho trình đọc màn hình), và chữ của Portal thì vẫn là chữ của Portal dù mắt chưa thấy.
 */
async function proseText(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    for (const node of copy.querySelectorAll(selector)) node.remove();
    return copy.textContent;
  }, VERBATIM);
}

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

/** Mỗi vi phạm trợ năng một dòng: luật và phần tử; riêng tương phản kèm tỉ lệ đo được và tỉ lệ cần */
async function a11yProblems(page: Page): Promise<string[]> {
  // [Plan #58 UX-41] Đủ bộ luật WCAG 2.0/2.1/2.2 A và AA của axe, không chỉ tương phản: nhãn, ARIA, thứ bậc
  // tiêu đề, vùng cuộn dùng được bằng bàn phím, phần tử tương tác lồng nhau…
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => {
      if (v.id !== "color-contrast") return `${v.id} ở ${n.target.join(" ")}`;
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

/**
 * Mở MỘT màn và kiểm mọi luật của cổng; chụp ảnh cả trang. Trả các vấn đề tìm thấy (rỗng là đạt). `errors` là lỗi
 * console gom từ lúc mở màn này.
 */
async function checkScreen(
  page: Page,
  pass: Pass,
  errors: string[],
  name: string,
  url: string,
  must: string | undefined,
): Promise<string[]> {
  errors.length = 0;
  await page.goto(`./#${url}`);
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
  if (text.includes("Bản xem thử chưa có")) problems.push("route giả chưa có");
  if ((await proseText(page)).includes("...")) problems.push('chữ có "..."');
  if (must !== undefined && (await page.locator(must).count()) === 0)
    problems.push(`thiếu ${must}`);

  const root = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    theme: document.documentElement.dataset.theme,
  }));
  if (root.lang !== pass.locale) problems.push(`lang="${root.lang}"`);
  if (root.theme !== pass.theme) problems.push(`theme="${String(root.theme)}"`);
  if (pass.locale === "en") {
    const chrome = await chromeTexts(page);
    const vi = chrome.filter((t) => VI.test(t));
    if (vi.length > 0)
      problems.push(`khung còn tiếng Việt: ${vi.slice(0, 3).join(" | ")}`);
  }
  problems.push(...(await a11yProblems(page)));
  if (errors.length > 0) problems.push(`console: ${errors.join(" | ")}`);

  await page.screenshot({
    path: fileURLToPath(
      new URL(`./screens/${pass.name}/${name}.png`, import.meta.url),
    ),
    fullPage: true,
  });
  return problems;
}

/**
 * Chuẩn bị trang cho một lượt: lựa chọn tay của người dùng (và vai người xem của bản xem thử) đặt TRƯỚC khi trang
 * chạy — theme-boot.js, store ngôn ngữ và lớp giả lập đọc lúc khởi động. Trả mảng gom lỗi console.
 */
async function prepare(
  page: Page,
  pass: Pass,
  persona: PersonaId,
): Promise<string[]> {
  await page.addInitScript(
    ([locale, theme, key, who]) => {
      localStorage.setItem("udp_locale", locale);
      localStorage.setItem("udp_theme", theme);
      sessionStorage.setItem(key, who);
    },
    [pass.locale, pass.theme, PERSONA_KEY, persona] as const,
  );
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !IGNORED_CONSOLE.test(msg.text())) {
      errors.push(msg.text());
    }
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** [Plan #58 UX-11] Lần đầu dùng: người mới, chưa project, chưa nhóm (vai "Người mới" của dải Bản xem thử) */
const NEWCOMER_SCREENS: [name: string, path: string, must: string][] = [
  // Ba bước và MỘT nút chính thay cho "Bạn chưa tham gia project nào" (`FirstRun.tsx`)
  ["home-newcomer", "/app/home", ".first-run .first-run-steps"],
  ["projects-newcomer", "/app/projects", ".first-run .btn.pri"],
  // Trạng thái trống của danh sách nhóm (không phải lỗi tải)
  ["teams-newcomer", "/app/teams", ".state:not([role])"],
  // Thanh bước của wizard (UX-15)
  ["new-project-newcomer", "/app/projects/new", ".wz-steps"],
];

/**
 * [Plan #59] Khách chưa đăng nhập (vai "Khách" của dải Bản xem thử, `/auth/me` trả 401): trang giới thiệu ở địa chỉ
 * gốc, đăng nhập và đăng ký. Trước đây hai trang sau được chụp khi ĐÃ đăng nhập, không phải cảnh người thật gặp.
 */
const VISITOR_SCREENS: [name: string, path: string, must: string][] = [
  // Bốn con số và ảnh chụp thật của Portal ở hero
  ["landing", "/", ".lp-facts .lp-fact-v"],
  ["login", "/login", ".auth-card .pw-eye"],
  // Panel bên của trang đăng ký (màn hẹp: xuống dưới form)
  ["register", "/register", ".auth-aside li"],
  // [Plan #60] Quên và đặt lại mật khẩu, hai trang pháp lý (ô đồng ý nằm trong màn "register")
  ["forgot-password", "/forgot-password", ".auth-form .btn.pri"],
  [
    "reset-password",
    "/reset-password#ma-dat-lai-mau-cua-ban-xem-thu",
    ".auth-form .pw",
  ],
  ["terms", "/terms", ".legal-toc li"],
  ["privacy", "/privacy", ".legal-toc li"],
];

for (const pass of PASSES) {
  test.describe(`${pass.name} ${String(pass.width)}×${String(pass.height)}`, () => {
    test.use({
      viewport: { width: pass.width, height: pass.height },
      colorScheme: pass.theme,
    });
    test.setTimeout(600_000);

    test("mọi màn đạt", async ({ page }) => {
      const errors = await prepare(page, pass, "admin");
      const ids = await discover(page);
      const failures: string[] = [];
      for (const [name, path, must] of SCREENS) {
        const problems = await checkScreen(
          page,
          pass,
          errors,
          name,
          path(ids),
          must,
        );
        if (problems.length > 0)
          failures.push(`${name}: ${problems.join("; ")}`);
      }
      expect(failures).toEqual([]);
    });

    test("khách chưa đăng nhập: trang giới thiệu, đăng nhập, đăng ký đạt", async ({
      page,
    }) => {
      const errors = await prepare(page, pass, "visitor");
      const failures: string[] = [];
      for (const [name, path, must] of VISITOR_SCREENS) {
        const problems = await checkScreen(
          page,
          pass,
          errors,
          name,
          path,
          must,
        );
        if (problems.length > 0)
          failures.push(`${name}: ${problems.join("; ")}`);
      }
      expect(failures).toEqual([]);
    });

    test("người mới: mọi màn lần đầu dùng đạt", async ({ page }) => {
      const errors = await prepare(page, pass, "newcomer");
      const failures: string[] = [];
      for (const [name, path, must] of NEWCOMER_SCREENS) {
        const problems = await checkScreen(
          page,
          pass,
          errors,
          name,
          path,
          must,
        );
        if (problems.length > 0)
          failures.push(`${name}: ${problems.join("; ")}`);
      }
      expect(failures).toEqual([]);
    });
  });
}
