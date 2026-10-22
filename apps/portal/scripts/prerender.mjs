// [Plan #60 QĐ-9] Dựng sẵn trang giới thiệu sau hai lượt build của Vite (client vào `dist/`, SSR vào `dist-ssr/`):
//
//   dist/app.html   vỏ SPA như cũ — nginx trả cho MỌI đường trừ `/` (deploy/docker/nginx.conf)
//   dist/index.html trang giới thiệu ĐÃ VẼ, kèm title, meta description, Open Graph và CSS của trang
//   dist/llms.txt   và dist/index.md — bản cho agent đọc, sinh từ CHÍNH chữ của trang
//
// Chạy: `pnpm --filter @udp/portal build` (hay `build:static` trong Docker). Không tham số, không mạng.
import { readFile, rm, writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
const ssrDir = new URL("../dist-ssr/", import.meta.url);

const esc = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const template = await readFile(new URL("index.html", dist), "utf8");
if (!template.includes('<div id="root"></div>')) {
  throw new Error(
    'dist/index.html không có <div id="root"></div> — khuôn đổi?',
  );
}
await writeFile(new URL("app.html", dist), template);

const manifest = JSON.parse(
  await readFile(new URL(".vite/manifest.json", dist), "utf8"),
);
const landing = manifest["src/features/landing/LandingPage.tsx"];
if (landing === undefined) {
  throw new Error("manifest không có chunk LandingPage — route lười đã đổi?");
}

const ssr = await import(new URL("entry.js", ssrDir).href);
const { html, title, description } = await ssr.renderLanding();

const head = [
  `<title>${esc(title)}</title>`,
  `<meta name="description" content="${esc(description)}" />`,
  `<meta property="og:type" content="website" />`,
  `<meta property="og:title" content="${esc(title)}" />`,
  `<meta property="og:description" content="${esc(description)}" />`,
  `<meta property="og:locale" content="vi_VN" />`,
  `<link rel="alternate" type="text/markdown" href="/index.md" />`,
  ...(landing.css ?? []).map((f) => `<link rel="stylesheet" href="/${f}" />`),
  `<link rel="modulepreload" href="/${landing.file}" />`,
].join("\n    ");

const page = template
  .replace(/<title>[^<]*<\/title>/, head)
  .replace(
    '<div id="root"></div>',
    `<div id="root" data-prerendered>${html}</div>`,
  );
await writeFile(new URL("index.html", dist), page);
await writeFile(new URL("llms.txt", dist), ssr.llmsTxt());
await writeFile(new URL("index.md", dist), ssr.landingMarkdown());
await rm(ssrDir, { recursive: true, force: true });

console.log(
  `prerender: index.html ${String(Math.round(page.length / 1024))} KB, app.html, llms.txt, index.md`,
);
