import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { discover, type Ids } from "./ids";
import { PERSONA_KEY } from "./mock/persona";

/**
 * [Plan #59] Ảnh của trang giới thiệu là ảnh chụp THẬT của Portal (không vẽ lại giao diện bằng div, không khung trình
 * duyệt giả), chụp lại được bất cứ lúc nào từ bản xem thử: mỗi ảnh bốn bản (sáng, tối × tiếng Việt, tiếng Anh), WebP
 * ở mật độ điểm 2. Kèm `shots.json`: kích thước thật để trang giữ chỗ trước khi ảnh tải (không nhảy bố cục) và vị trí
 * các chú thích đánh số, đo từ chính phần tử được chú thích. Giao diện đổi thì chạy lại, không sửa tay.
 *
 *   pnpm --filter @udp/portal demo:build && pnpm --filter @udp/portal demo:shots
 */

type Theme = "light" | "dark";
type Locale = "vi" | "en";

interface Shot {
  name: string;
  path: (ids: Ids) => string;
  /** Phần tử phải hiện (dữ liệu đã tải, sơ đồ đã vẽ) trước khi chụp */
  ready: string;
  /** Vùng chụp bắt đầu ở góc trên trái của phần tử này, cắt theo bề rộng và chiều cao tối đa (px CSS) */
  clip: string;
  width?: number;
  height: number;
  /** Phần tử được chú thích, theo thứ tự số: chấm số đặt ở góc trên trái của mỗi phần tử */
  marks?: readonly string[];
}

const SHOTS: readonly Shot[] = [
  // Hero: cả ứng dụng, sơ đồ tổng quan hệ thống của một project đang chạy
  {
    name: "hero",
    path: (i) => `/app/projects/${i.checkout}/architecture`,
    ready: ".sys-map .link-labels span",
    clip: "#root",
    height: 900,
  },
  {
    name: "domains",
    path: (i) => `/app/projects/new?project=${i.draft}&step=domains`,
    ready: ".wizard-nav",
    clip: "main",
    width: 760,
    height: 700,
  },
  {
    name: "rollout",
    path: (i) => `/app/projects/${i.checkout}/rollouts/${i.rollout}`,
    ready: ".steps",
    clip: "main",
    height: 720,
    marks: [".hero .acts", ".stat", ".grid2 > :first-child"],
  },
  {
    name: "cloud",
    path: (i) => `/app/projects/new?project=${i.draft}&step=cloud`,
    ready: ".wizard-nav",
    clip: "main",
    width: 760,
    height: 700,
  },
];

const VARIANTS: readonly { theme: Theme; locale: Locale }[] = [
  { theme: "light", locale: "vi" },
  { theme: "dark", locale: "vi" },
  { theme: "light", locale: "en" },
  { theme: "dark", locale: "en" },
];

const OUT = new URL("../src/features/landing/shots/", import.meta.url);

interface Measured {
  width: number;
  height: number;
  /** Phần trăm theo bề rộng và chiều cao của ảnh */
  marks: [x: number, y: number][];
}

/** Chụp một vùng; trả ảnh PNG cùng kích thước và chú thích đo được */
async function capture(
  page: Page,
  shot: Shot,
  ids: Ids,
): Promise<{ png: Buffer; measured: Measured }> {
  await page.goto(`./#${shot.path(ids)}`);
  await expect(page.locator(shot.ready).first()).toBeVisible({
    timeout: 15_000,
  });
  // Dải "Bản xem thử" không thuộc sản phẩm; biểu đồ và lớp cạnh vẽ sau layout
  await page.addStyleTag({ content: "#demo-badge { display: none; }" });
  await page.waitForTimeout(400);
  const box = await page.locator(shot.clip).first().boundingBox();
  if (box === null) throw new Error(`${shot.name}: không thấy ${shot.clip}`);
  const clip = {
    x: box.x,
    y: box.y,
    width: Math.min(box.width, shot.width ?? box.width),
    height: Math.min(box.height, shot.height),
  };
  const marks: [number, number][] = [];
  for (const selector of shot.marks ?? []) {
    const at = await page.locator(selector).first().boundingBox();
    if (at === null) throw new Error(`${shot.name}: không thấy ${selector}`);
    const pct = (v: number, of: number) => Math.round((v / of) * 1000) / 10;
    marks.push([
      pct(at.x - clip.x, clip.width),
      pct(at.y - clip.y, clip.height),
    ]);
  }
  const png = await page.screenshot({ clip });
  return {
    png,
    measured: { width: clip.width, height: clip.height, marks },
  };
}

/** PNG ⇒ WebP bằng canvas của chính trình duyệt: không thêm thư viện xử lý ảnh nào */
async function toWebp(page: Page, png: Buffer): Promise<Buffer> {
  const b64 = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    return canvas.toDataURL("image/webp", 0.86).split(",")[1] ?? "";
  }, png.toString("base64"));
  return Buffer.from(b64, "base64");
}

test.setTimeout(300_000);

test("chụp ảnh trang giới thiệu", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const meta: Record<string, Record<string, Measured>> = {};
  const converter = await browser.newPage();
  const { baseURL } = test.info().project.use;
  for (const { theme, locale } of VARIANTS) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
    const page = await context.newPage();
    await page.addInitScript(
      ([l, t, key]) => {
        localStorage.setItem("udp_locale", l);
        localStorage.setItem("udp_theme", t);
        sessionStorage.setItem(key, "admin");
      },
      [locale, theme, PERSONA_KEY] as const,
    );
    const ids = await discover(page);
    for (const shot of SHOTS) {
      const { png, measured } = await capture(page, shot, ids);
      const variant = `${theme}-${locale}`;
      writeFileSync(
        fileURLToPath(new URL(`${shot.name}-${variant}.webp`, OUT)),
        await toWebp(converter, png),
      );
      meta[shot.name] = { ...meta[shot.name], [variant]: measured };
    }
    await context.close();
  }
  // Cặp toạ độ của dấu đánh số viết trên một dòng, đúng như Prettier: chụp lại không sinh diff định dạng
  const json = JSON.stringify(meta, null, 2).replace(
    /\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g,
    "[$1, $2]",
  );
  writeFileSync(fileURLToPath(new URL("shots.json", OUT)), `${json}\n`);
});
