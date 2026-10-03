/**
 * [Plan #61 61d-3c] `pnpm chart:check` — canh ghim chart Helm của nền tảng.
 *
 * Chỉ ĐỌC `index.yaml` của từng repo, không sửa gì. Thoát 1 khi có ghim **không cài được**: `repo-gone`, `shape`,
 * `broken`. Bản vá chart (`chart-update`) và dòng mới hơn (`newer-line`) chỉ vào bảng — xem `FindingStatus` để biết
 * vì sao ngưỡng đỏ hẹp như vậy.
 *
 * **Vì sao script này đọc `HELM_CHART_PINS` chứ không nạp registry adapter:** `adapter-base/helm.ts` import từ gốc
 * `@udp/config`, gốc đó re-export `env`, và `env.ts` ném khi thiếu `.env` — runner CI không có. 54 tệp dưới
 * `modules/` import từ gốc đó và 9 tệp dùng chính `env`, nên không có bản sửa rẻ. Ghim là dữ liệu, và script đọc
 * dữ liệu.
 *
 * Ghim ĐÓNG BĂNG của `upgradesFrom` không nằm trong bảng (nó là lịch sử version của adapter) nên được khai ở
 * `FROZEN_PINS` dưới đây — với chúng chỉ chạy luật TỒN TẠI.
 */
import { appendFileSync } from "node:fs";
import { HELM_CHART_PINS, type HelmChartRef } from "../src/helm-charts.js";
import {
  applyKnownBroken,
  chartFinding,
  chartVersionsOf,
  isActionable,
  renderReport,
  unwatchableReason,
  type ChartPin,
  type Finding,
} from "../src/toolchain-check.js";

/**
 * Ghim đóng băng trong `upgradesFrom` của adapter — khai TAY, và một ô của design-lint giữ danh sách này khớp mã.
 *
 * Vì sao vẫn canh: `restoreTo` của §8.6 là đường duy nhất áp lại chart cũ, và nó chỉ chạy được nếu chart đó còn
 * tải về được. Repo **có** xoá bản (đo 03/10/2026: `mysql-operator` giữ đúng một bản; `zipkin` đã bỏ `0.3.6`;
 * `tekton-pipeline` đã bỏ `1.1.4`), nên một project còn ở bản adapter cũ có thể đã mất đường hạ về mà không ai biết.
 */
const FROZEN_PINS: readonly (HelmChartRef & { usedBy: string })[] = [
  {
    name: "kyverno",
    version: "3.2.7",
    repo: "https://kyverno.github.io/kyverno/",
    usedBy: "policy-adapter/kyverno upgradesFrom 1.0.0",
  },
  {
    name: "kyverno-policies",
    version: "3.2.6",
    repo: "https://kyverno.github.io/kyverno/",
    usedBy: "policy-adapter/kyverno upgradesFrom 1.0.0",
  },
];

/** Lỗi mạng thoáng qua và 429/5xx: thử lại ba lần — một lần chập chờn không được thành "REPO CHẾT" */
async function fetchRetry(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "accept-encoding": "gzip, deflate" },
      });
      if ((res.status !== 429 && res.status < 500) || attempt === 3) return res;
    } catch (e) {
      if (attempt === 3) throw e;
    }
    await new Promise((done) => setTimeout(done, attempt * 1000));
  }
}

const indexUrl = (repo: string): string =>
  `${repo.replace(/\/+$/, "")}/index.yaml`;

/**
 * `index.yaml` của một repo, tải ĐÚNG MỘT LẦN cho mọi chart của repo đó.
 *
 * Tuần tự, không `Promise.all`: tổng 52 index của sản phẩm là 33,1 MB sau giải nén và cái lớn nhất là 6,17 MB
 * (`prometheus-community`, đo 03/10/2026) — đây là lệnh người ta chạy tay trên máy 7,7 GB RAM. Chỉ giữ lại danh
 * sách version rồi bỏ chuỗi index đi.
 */
async function versionsByRepo(
  pins: readonly ChartPin[],
): Promise<
  Map<string, { versions: Map<string, string[] | null>; error?: string }>
> {
  const byRepo = new Map<string, ChartPin[]>();
  for (const pin of pins) {
    if (unwatchableReason(pin) !== null) continue;
    const list = byRepo.get(pin.repo) ?? [];
    list.push(pin);
    byRepo.set(pin.repo, list);
  }

  const out = new Map<
    string,
    { versions: Map<string, string[] | null>; error?: string }
  >();
  for (const [repo, list] of byRepo) {
    const url = indexUrl(repo);
    try {
      const res = await fetchRetry(url);
      if (!res.ok) {
        out.set(repo, {
          versions: new Map(),
          error: `HTTP ${String(res.status)} tại ${url}`,
        });
        continue;
      }
      const text = await res.text();
      const versions = new Map<string, string[] | null>();
      for (const pin of list) {
        versions.set(pin.name, chartVersionsOf(text, pin.name));
      }
      /** Một `index.yaml` thật LUÔN có khoá `entries:`; thiếu nó là trang HTML 404 trả về mã 200 */
      out.set(
        repo,
        text.includes("entries:")
          ? { versions }
          : { versions: new Map(), error: `${url} không phải index.yaml` },
      );
    } catch (e) {
      out.set(repo, {
        versions: new Map(),
        error: `${url}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}

/** Ghim hiện tại của bảng + ghim đóng băng; chart dùng chung gộp thành MỘT mục */
function allPins(): ChartPin[] {
  const current = Object.values(HELM_CHART_PINS).map((pin): ChartPin => ({
    name: pin.name,
    version: pin.version,
    repo: pin.repo,
    ...(pin.installer === undefined ? {} : { installer: pin.installer }),
    usedBy: [`HELM_CHART_PINS.${pin.name}`],
  }));
  const frozen = FROZEN_PINS.map((pin): ChartPin => ({
    name: pin.name,
    version: pin.version,
    repo: pin.repo,
    frozen: true,
    usedBy: [pin.usedBy],
  }));
  return [...current, ...frozen];
}

async function main(): Promise<void> {
  const pins = allPins();
  const indexes = await versionsByRepo(pins);

  const raw: Finding[] = pins.map((pin) => {
    const repo = indexes.get(pin.repo);
    if (repo === undefined) return chartFinding(pin, { versions: null });
    if (repo.error !== undefined) {
      return chartFinding(pin, { versions: null, error: repo.error });
    }
    return chartFinding(pin, { versions: repo.versions.get(pin.name) ?? null });
  });
  /** Đường cơ sở có tên: lỗi có TRƯỚC cổng này không làm nó đỏ, nhưng lỗi MỚI thì đỏ — xem `KNOWN_BROKEN_CHARTS` */
  const findings = applyKnownBroken(raw);

  const report = renderReport(findings, {
    title: "Kiểm ghim chart Helm (chart:check)",
    hint: "Sửa ở `packages/config/src/helm-charts.ts`. Bản vá chart KHÔNG làm job đỏ: nó cần một lượt nâng cấp §8.6 (bump `adapter_version` + `upgradesFrom`), không phải một phép sửa trong tuần.",
  });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
  process.exitCode = findings.some(isActionable) ? 1 : 0;
}

await main();
