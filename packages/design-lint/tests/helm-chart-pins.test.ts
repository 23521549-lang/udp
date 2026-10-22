import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertChartPins,
  HELM_CHART_PINS,
  helmChart,
  type HelmChartRef,
} from "@udp/config/helm-charts";
import { describe, expect, it } from "vitest";

/**
 * [Plan #61 61d-3c] Cổng FAIL-CLOSED của bảng ghim chart.
 *
 * Bảng `HELM_CHART_PINS` chỉ có giá trị nếu nó là nguồn DUY NHẤT: một ghim còn viết literal trong tệp adapter là một
 * ghim mà cổng `chart:check` **không thấy**, và nó không thấy một cách im lặng. Ô ở đây biến điều đó thành một phép
 * grep: không tệp adapter nào còn một khối `chart: { … }` ngoài vùng `upgradesFrom`.
 *
 * Vì sao `upgradesFrom` được miễn: ghim ở đó là **lịch sử version của chính adapter** — `restoreTo` của §8.6 áp lại
 * đúng toạ độ cũ, nên nó phải đóng băng trong mã của adapter, không theo bảng (bảng chỉ có một version mỗi chart).
 * Ghim đóng băng vẫn được canh, nhưng chỉ bằng luật TỒN TẠI — xem `chart:check`.
 */

const REPO = resolve(import.meta.dirname, "../../..");
const MODULES = join(REPO, "services/core-backend/src/modules");

function tsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Vùng `upgradesFrom: [ … ]` của một tệp — cặp [đầu, cuối] theo chỉ số ký tự */
function frozenSpans(source: string): [number, number][] {
  const spans: [number, number][] = [];
  const open = /upgradesFrom:\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(source)) !== null) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < source.length; i++) {
      if (source[i] === "[") depth++;
      else if (source[i] === "]") {
        depth--;
        if (depth === 0) {
          spans.push([m.index, i]);
          break;
        }
      }
    }
  }
  return spans;
}

describe("HELM_CHART_PINS là nguồn DUY NHẤT của toạ độ chart", () => {
  it("không tệp adapter nào còn khối `chart: { … }` ngoài upgradesFrom", () => {
    const literal = /chart:\s*\{\s*name:/g;
    const offenders: string[] = [];
    for (const file of tsFiles(MODULES)) {
      const source = readFileSync(file, "utf8");
      const spans = frozenSpans(source);
      let m: RegExpExecArray | null;
      literal.lastIndex = 0;
      while ((m = literal.exec(source)) !== null) {
        const frozen = spans.some(([a, b]) => a <= m!.index && m!.index <= b);
        if (frozen) continue;
        const line = source.slice(0, m.index).split("\n").length;
        offenders.push(`${file.slice(REPO.length + 1)}:${String(line)}`);
      }
    }
    expect(offenders, "ghim chart phải đi qua helmChart(…)").toEqual([]);
  });

  it("mọi lời gọi helmChart trong mã sản phẩm trỏ tới một khoá CÓ trong bảng", () => {
    const call = /helmChart\("([^"]+)"\)/g;
    const missing: string[] = [];
    for (const file of tsFiles(MODULES)) {
      const source = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      call.lastIndex = 0;
      while ((m = call.exec(source)) !== null) {
        const name = m[1] ?? "";
        if (!Object.hasOwn(HELM_CHART_PINS, name)) {
          missing.push(`${file.slice(REPO.length + 1)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("mỗi chart trong bảng được DÙNG ít nhất một chỗ — bảng không giữ ghim mồ côi", () => {
    const used = new Set<string>();
    for (const file of tsFiles(MODULES)) {
      for (const m of readFileSync(file, "utf8").matchAll(
        /helmChart\("([^"]+)"\)/g,
      )) {
        used.add(m[1] ?? "");
      }
    }
    const orphans = Object.keys(HELM_CHART_PINS).filter((n) => !used.has(n));
    expect(orphans, "ghim không ai dùng là ghim không ai bảo trì").toEqual([]);
  });

  it("hai bất biến của bảng: khoá bằng tên chart, và version KHÔNG có hậu tố", () => {
    expect(() => {
      assertChartPins();
    }).not.toThrow();

    // Khoá lệch tên ⇒ `helmChart("x")` trả về một chart tên khác, và `detectDrift` so sai chart
    expect(() => {
      assertChartPins({ a: { name: "b", version: "1.0.0", repo: "r" } });
    }).toThrow("khoá");

    /**
     * Ghim có hậu tố là một cái bẫy đã đo: `newerTags` coi hậu tố là phần của danh tính, nên một ghim `0.13.0-rc`
     * nhận `0.13.2-rc` làm "bản vá" — tự nâng giữa hai bản thử nghiệm. Quét 52 `index.yaml` thật tìm được 138 cặp
     * như vậy, nên đây không phải một ca giả thuyết.
     */
    expect(() => {
      assertChartPins({ a: { name: "a", version: "0.13.0-rc", repo: "r" } });
    }).toThrow("hậu tố");
    expect(() => {
      assertChartPins({
        a: { name: "a", version: "v1.11.0-beta.0", repo: "r" },
      });
    }).toThrow("hậu tố");
  });

  it("tên chart lạ ⇒ NÉM, không trả undefined vào HelmRelease", () => {
    expect(() => helmChart("chart-khong-ton-tai")).toThrow("HELM_CHART_PINS");
  });

  it("bảy ghim mà vòng QA của 61d-3c tìm ra đã được sửa", () => {
    /**
     * Bốn ghim này KHÔNG tải về được trước đợt 61d-3c (đo bằng `index.yaml` thật 03/10/2026), nên bảy adapter
     * không cài được chart của mình. Ô này giữ cho một lần "dọn dẹp" sau không lặng lẽ trả chúng về bản cũ.
     */
    const pin = (name: string): HelmChartRef => helmChart(name);
    expect(pin("mysql-operator").version).toBe("2.3.0");
    expect(pin("zipkin").version).toBe("0.7.0");
    // Repo phát hành `v0.3.2`; ghim `0.3.2` lệch tiền tố nên helm không tìm thấy
    expect(pin("raw").version).toBe("v0.3.2");
    // Repo cũ `bitnami-labs.github.io` trả 404 toàn site
    expect(pin("sealed-secrets").repo).toBe(
      "https://bitnami.github.io/sealed-secrets",
    );
  });
});

/**
 * [Plan #61 61d-3c] `FROZEN_PINS` của `chart:check` là một danh sách VIẾT TAY, nên nó mục được.
 *
 * Ghim đóng băng phải nằm trong adapter (nó là lịch sử version của chính adapter đó, và `restoreTo` của §8.6 áp
 * lại đúng toạ độ ấy), nên nó không vào bảng — bảng chỉ giữ một version mỗi chart. Hệ quả: script phải tự khai lại
 * chúng, và ô dưới đây là thứ giữ hai bên bằng nhau. Thiếu nó, một `upgradesFrom` mới thêm sẽ không được canh và
 * một project ở bản adapter cũ có thể mất đường hạ về mà không ai biết.
 */
describe("FROZEN_PINS của chart:check khớp upgradesFrom trong mã", () => {
  /** `chart: { name: "x", version: "y", repo: … }` nằm TRONG một khối `upgradesFrom` */
  function frozenInCode(): { name: string; version: string }[] {
    const out: { name: string; version: string }[] = [];
    for (const file of tsFiles(MODULES)) {
      const source = readFileSync(file, "utf8");
      for (const [a, b] of frozenSpans(source)) {
        const region = source.slice(a, b);
        for (const m of region.matchAll(
          /chart:\s*\{\s*name:\s*"([^"]+)",\s*version:\s*"([^"]+)"/g,
        )) {
          out.push({ name: m[1] ?? "", version: m[2] ?? "" });
        }
      }
    }
    return out.sort((x, y) => x.name.localeCompare(y.name));
  }

  it("mọi ghim trong upgradesFrom được chart:check khai và canh", () => {
    const script = readFileSync(
      join(REPO, "packages/config/scripts/chart-check.ts"),
      "utf8",
    );
    const declared = [
      ...script.matchAll(/name:\s*"([^"]+)",\s*\n\s*version:\s*"([^"]+)"/g),
    ]
      .map((m) => ({ name: m[1] ?? "", version: m[2] ?? "" }))
      .sort((x, y) => x.name.localeCompare(y.name));

    expect(declared, "FROZEN_PINS phải khớp upgradesFrom trong mã").toEqual(
      frozenInCode(),
    );
  });
});
