import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { createAppRouter } from "../app/router";
import {
  domainInfoMessages,
  DOMAIN_GROUPS,
} from "../features/domain/domain-info.messages";
import { changelogMessages } from "../features/landing/changelog.messages";
import {
  DOMAIN_COUNT,
  LANDING_TOOLS,
  SAFETY_QUOTA,
  TOOL_COUNT,
} from "../features/landing/landing-facts";
import { landingMessages } from "../features/landing/landing.messages";
import { type Locale, useLocaleStore } from "../i18n";

/**
 * [Plan #60 QĐ-9] Entry của lượt build SSR (`vite build --ssr`): `scripts/prerender.mjs` gọi các hàm dưới để
 * `dist/index.html` là trang giới thiệu ĐÃ VẼ (tìm kiếm và người dùng mạng chậm thấy nội dung trước khi JS chạy), và để
 * sinh `llms.txt` + `index.md` cho agent đọc — từ CHÍNH chữ của trang, không chép tay một bản thứ hai.
 *
 * Chạy trong Node, không có `window`: component nào cần trình duyệt đã có nhánh máy chủ (địa chỉ mẫu trong đoạn mã,
 * ảnh `<picture>` theo giao diện hệ thống). Dựng tiếng Việt — ngôn ngữ mặc định của sản phẩm; trình duyệt đổi ngay
 * sang ngôn ngữ người xem đã chọn khi JS chạy.
 */

export interface RenderedLanding {
  html: string;
  title: string;
  description: string;
}

export async function renderLanding(): Promise<RenderedLanding> {
  // Hook đọc ảnh chụp KHỞI TẠO của store khi vẽ ở máy chủ: `initialLocale()` không có `window` đã là "vi"
  if (useLocaleStore.getState().locale !== "vi") {
    // Lỗi của lượt build, không phải chữ giao diện: viết không dấu để luật hai ngôn ngữ không bắt nhầm
    throw new Error(
      "prerender: locale khoi tao phai la vi (initialLocale() da doi?)",
    );
  }
  const queryClient = new QueryClient();
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ["/"] }),
  );
  await router.load();
  const html = renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const m = landingMessages.vi;
  return { html, title: m.docTitle, description: m.hero.lead };
}

/** Trang giới thiệu dạng Markdown, một ngôn ngữ */
function markdownOf(locale: Locale): string {
  const m = landingMessages[locale];
  const groups = domainInfoMessages[locale].group;
  const names = domainInfoMessages[locale].name;
  const log = changelogMessages[locale];
  const list = (items: readonly string[]) => items.map((i) => `- ${i}`);
  return [
    `# ${m.hero.title}`,
    "",
    m.hero.lead,
    "",
    m.hero.note,
    "",
    `## ${m.domains.title}`,
    "",
    m.domains.body,
    "",
    ...list(m.domains.points),
    "",
    `## ${m.rollout.title}`,
    "",
    m.rollout.body,
    "",
    `## ${m.flags.title}`,
    "",
    m.flags.body,
    "",
    ...list(m.flags.points),
    "",
    `## ${m.byoc.title}`,
    "",
    m.byoc.body,
    "",
    `### ${m.byoc.yours}`,
    ...list(m.byoc.yoursItems),
    "",
    `### ${m.byoc.udp}`,
    ...list(m.byoc.udpItems),
    "",
    m.byoc.quota(SAFETY_QUOTA),
    "",
    `## ${m.tools.title(DOMAIN_COUNT, TOOL_COUNT)}`,
    "",
    m.tools.body,
    "",
    ...(Object.keys(DOMAIN_GROUPS) as (keyof typeof DOMAIN_GROUPS)[]).flatMap(
      (g) => [
        `### ${groups[g]}`,
        ...DOMAIN_GROUPS[g].map(
          (d) => `- ${names[d]}: ${LANDING_TOOLS[d].join(", ")}`,
        ),
        "",
      ],
    ),
    `## ${m.how.title}`,
    "",
    ...m.how.steps.map((s, i) => `${String(i + 1)}. **${s.title}**: ${s.body}`),
    "",
    `## ${m.free.title}`,
    "",
    m.free.body,
    "",
    `### ${m.free.included}`,
    ...list(m.free.includedItems(DOMAIN_COUNT, TOOL_COUNT)),
    "",
    `### ${m.free.notFit}`,
    ...list(m.free.notFitItems),
    "",
    `## ${log.title}`,
    "",
    ...log.entries.map((e) => `- ${e.date}: **${e.title}**. ${e.body}`),
    "",
    `## ${m.faq.title}`,
    "",
    ...m.faq.items(SAFETY_QUOTA).flatMap((q) => [`### ${q.q}`, "", q.a, ""]),
  ].join("\n");
}

/** `/index.md`: bản tiếng Việt rồi bản tiếng Anh */
export function landingMarkdown(): string {
  return `${markdownOf("vi")}\n---\n\n${markdownOf("en")}`;
}

/**
 * `/llms.txt` theo đề xuất llmstxt.org: tên, một câu tóm tắt, rồi các đường dẫn đáng đọc. Đường dẫn tương đối — tên
 * miền chưa biết lúc build.
 */
export function llmsTxt(): string {
  const vi = landingMessages.vi;
  const en = landingMessages.en;
  return [
    "# UDP",
    "",
    `> ${en.hero.lead}`,
    "",
    `${en.footer.tagline} ${en.hero.note} ${vi.footer.tagline}`,
    "",
    "## Docs",
    "",
    `- [Home page as Markdown (Vietnamese, then English)](/index.md): ${en.domains.title} ${en.rollout.title} ${en.flags.title}`,
    `- [${en.footer.terms}](/terms): ${legalLine(en.footer.terms)}`,
    `- [${en.footer.privacy}](/privacy): ${legalLine(en.footer.privacy)}`,
    "",
    "## Optional",
    "",
    `- [Create an account](/register): ${en.free.title}`,
    `- [Sign in](/login)`,
    "",
  ].join("\n");
}

const legalLine = (what: string) =>
  `${what} of UDP, in Vietnamese and English.`;
