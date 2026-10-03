/**
 * [Plan #61 61d-3c-2] Cổng cưỡng chế F3 — **đổi ghim chart ⇒ bump `adapter_version` VÀ mang `upgradesFrom`**.
 *
 * §8.6 (sửa ở 61d-3a) nói đúng điều đó bằng chữ, nhưng trước cổng này không có gì cưỡng chế: `upgradesFrom` là
 * trường **tuỳ chọn** của `HelmAdapterSpec`, và `requestReapply` chỉ chặn khi `row.adapterVersion !==
 * adapter.version` (`domain-apply.service.ts`) — nên sửa ghim chart tại chỗ mà giữ nguyên version adapter thì
 * `reapply` áp bình thường: **không** validator capability, **không** đường hạ về. Lối đi sai vừa dễ hơn lối đúng.
 *
 * 61d-3c-1 dựng một vòi báo 29 bản vá chart mỗi tuần, tức tạo đúng áp lực đi theo lối sai đó. Cổng này là cái giá
 * phải trả cùng lúc với cái vòi.
 *
 * Phần THUẦN: nhận nội dung tệp trước/sau của một commit, trả phán quyết. Lớp git ở `chart-bump-gate.ts`.
 */

export const PINS_FILE = "packages/config/src/helm-charts.ts";

/** `"<chart>": { name: …, version: "x", repo: … }` ⇒ map tên chart ⇒ version */
export function chartPinsOf(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(
    /"([^"]+)":\s*\{\s*name:\s*"([^"]+)",\s*version:\s*"([^"]+)"/g,
  )) {
    out.set(m[2] ?? "", m[3] ?? "");
  }
  return out;
}

/** Version của chính adapter (`version: "x.y.z"` ngay sau `toolId`) — `null` khi tệp không khai */
export function adapterVersionOf(source: string): string | null {
  return (
    /toolId:\s*"[^"]+",\s*\n\s*version:\s*"([^"]+)"/.exec(source)?.[1] ?? null
  );
}

/** Mọi version mà `upgradesFrom` của tệp khai cho MỘT chart — chỗ giữ định nghĩa bản cũ */
export function frozenChartVersionsOf(source: string, chart: string): string[] {
  const out: string[] = [];
  const open = /upgradesFrom:\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(source)) !== null) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < source.length; i++) {
      if (source[i] === "[") depth++;
      else if (source[i] === "]") {
        depth--;
        if (depth === 0) {
          const region = source.slice(m.index, i);
          const needle = new RegExp(
            `chart:\\s*\\{\\s*name:\\s*"${chart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*version:\\s*"([^"]+)"`,
            "g",
          );
          for (const f of region.matchAll(needle)) out.push(f[1] ?? "");
          break;
        }
      }
    }
  }
  return out;
}

/** Một tệp adapter dùng chart đã đổi, kèm nội dung hai phía của commit */
export interface AdapterFile {
  path: string;
  before: string;
  after: string;
}

export interface ChartBumpViolation {
  chart: string;
  from: string;
  to: string;
  /** Vì sao commit này chưa đúng F3 */
  reason: string;
}

export interface ChartBumpVerdict {
  /** Chart có version ĐỔI trong commit (không tính thêm mới hay bỏ đi) */
  changed: { chart: string; from: string; to: string }[];
  violations: ChartBumpViolation[];
  /** Chart được miễn vì commit khai `Ghim-hỏng: <chart>` */
  excused: string[];
}

/**
 * Cú pháp miễn trừ: một dòng `Ghim-hỏng: <tên chart>` trong thông điệp commit.
 *
 * Vì sao cần nó: sửa một ghim **chưa bao giờ tải về được** (`broken`, `shape`, `repo-gone` của `chart:check`) KHÔNG
 * phải một lần nâng cấp §8.6 — không cụm nào từng chạy bản cũ, nên không có định nghĩa nào để `upgradesFrom` mang và
 * `adapter_version` không được đổi. Đợt 61d-3c-1 sửa năm ghim như vậy. Miễn trừ nằm trong **thông điệp commit** chứ
 * không trong một danh sách trong mã: nó là lời khai về MỘT commit, nên nó phải sống cùng commit đó và hiện ra trong
 * mọi lần review.
 */
const EXCUSE = /^Ghim-hỏng:\s*(\S+)\s*$/gm;

export function excusedCharts(commitMessage: string): string[] {
  return [...commitMessage.matchAll(EXCUSE)].map((m) => m[1] ?? "");
}

/**
 * Phán quyết F3 cho MỘT commit.
 *
 * Luật: với mỗi chart có version đổi, PHẢI có ít nhất một tệp adapter dùng chart đó mà (a) version của chính
 * adapter cũng đổi, và (b) `upgradesFrom` sau commit khai ĐÚNG version chart CŨ. (b) là phần dễ quên nhất và cũng
 * là phần duy nhất làm `restoreTo` chạy được: thiếu nó, cụm "đã hạ về" sẽ chạy chart cũ với `values` của bản mới.
 */
export function checkChartBump(args: {
  pinsBefore: string;
  pinsAfter: string;
  adapters: readonly AdapterFile[];
  commitMessage: string;
}): ChartBumpVerdict {
  const before = chartPinsOf(args.pinsBefore);
  const after = chartPinsOf(args.pinsAfter);
  const excused = excusedCharts(args.commitMessage);

  const changed: ChartBumpVerdict["changed"] = [];
  for (const [chart, to] of after) {
    const from = before.get(chart);
    if (from !== undefined && from !== to) changed.push({ chart, from, to });
  }

  const violations: ChartBumpViolation[] = [];
  for (const { chart, from, to } of changed) {
    if (excused.includes(chart)) continue;
    const users = args.adapters.filter((f) =>
      f.after.includes(`helmChart("${chart}")`),
    );
    if (users.length === 0) {
      violations.push({
        chart,
        from,
        to,
        reason:
          "không tệp adapter nào trong commit dùng chart này — commit phải mang cả adapter dùng nó",
      });
      continue;
    }
    const bumped = users.filter(
      (f) => adapterVersionOf(f.before) !== adapterVersionOf(f.after),
    );
    if (bumped.length === 0) {
      violations.push({
        chart,
        from,
        to,
        reason: `không adapter nào bump version (${users.map((f) => f.path).join(", ")}) — §8.6 nhánh B đòi một lượt nâng cấp, và reapply KHÔNG chạy validator`,
      });
      continue;
    }
    const carries = bumped.filter((f) =>
      frozenChartVersionsOf(f.after, chart).includes(from),
    );
    if (carries.length === 0) {
      violations.push({
        chart,
        from,
        to,
        reason: `upgradesFrom không mang version chart cũ "${from}" — thiếu nó thì restoreTo áp chart cũ với values của bản MỚI`,
      });
    }
  }
  return { changed, violations, excused };
}
