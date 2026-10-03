import {
  applyKnownBroken,
  chartFinding,
  chartVersionsOf,
  isActionable,
  newerTags,
  unwatchableReason,
  type ChartPin,
  type Finding,
} from "../src/toolchain-check.js";
import { describe, expect, it } from "vitest";

/**
 * [Plan #61 61d-3c] Ba luật của cổng canh ghim chart, và ngưỡng đỏ của nó.
 *
 * Mỗi luật ở đây có một ca THẬT trong sản phẩm trước đợt này — không luật nào là giả thuyết:
 *
 *  - `shape`: `raw 0.3.2` trong khi repo phát hành `v0.3.2` ⇒ `helm` không tìm thấy gì, mà `newerTags` trả
 *    `{null, null}` và `versionFinding` gộp nó thành `ok`.
 *  - `broken`: `spinnaker 2.2.24`, `zipkin 0.3.6`, `mysql-operator 2.2.2`, `tekton-pipeline 1.1.4` — bốn version
 *    không tồn tại.
 *  - `repo-gone`: `bitnami-labs.github.io/sealed-secrets` và repo provider GCP, cả hai 404 toàn site.
 */

/** `index.yaml` thu nhỏ nhưng ĐÚNG hình dạng của Helm: `entries:` ⇒ `  <chart>:` ⇒ các mục có `version:` */
const INDEX = [
  "apiVersion: v1",
  "entries:",
  "  kyverno:",
  "  - apiVersion: v2",
  "    name: kyverno",
  "    created: '2026-01-01T00:00:00Z'",
  "    version: 3.9.1",
  "  - apiVersion: v2",
  "    name: kyverno",
  "    version: 3.9.0",
  "  - apiVersion: v2",
  "    name: kyverno",
  "    version: 3.9.0-rc.4",
  "  - apiVersion: v2",
  "    name: kyverno",
  "    version: 3.2.7",
  "  kyverno-policies:",
  "  - apiVersion: v2",
  "    name: kyverno-policies",
  "    version: 3.9.1",
  "generated: '2026-10-03T00:00:00Z'",
].join("\n");

const pinOf = (over: Partial<ChartPin> = {}): ChartPin => ({
  name: "kyverno",
  version: "3.9.1",
  repo: "https://kyverno.github.io/kyverno/",
  usedBy: ["policy-adapter/kyverno"],
  ...over,
});

describe("chartVersionsOf", () => {
  it("lấy đúng version của ĐÚNG chart, không lẫn chart kế tiếp", () => {
    expect(chartVersionsOf(INDEX, "kyverno")).toEqual([
      "3.9.1",
      "3.9.0",
      "3.9.0-rc.4",
      "3.2.7",
    ]);
    expect(chartVersionsOf(INDEX, "kyverno-policies")).toEqual(["3.9.1"]);
  });

  it("chart không có trong index ⇒ null (khác với 'có nhưng rỗng')", () => {
    expect(chartVersionsOf(INDEX, "khong-ton-tai")).toBeNull();
  });

  it("tên chart có ký tự đặc biệt không thành regex", () => {
    const idx = [
      "entries:",
      "  a.b+c:",
      "  - name: a.b+c",
      "    version: 1.0.0",
    ].join("\n");
    expect(chartVersionsOf(idx, "a.b+c")).toEqual(["1.0.0"]);
    expect(chartVersionsOf(idx, "axbxc")).toBeNull();
  });

  it("KHÔNG lẫn version của dependency (cấp 6) vào danh sách của chart", () => {
    /**
     * Index thật của opsmx/spinnaker có `      version: 10.5.3` cho dependency `redis`, và mục đầu của mỗi bản là
     * `  - annotations:`. Một phép đọc lỏng ở một trong hai chỗ đó cho kết quả sai theo hai chiều: trộn version
     * của chart phụ thuộc (ghim không tồn tại thành "tồn tại"), hay cắt khối ngay dòng đầu (mọi ghim thành `shape`
     * oan).
     */
    const idx = [
      "entries:",
      "  spinnaker:",
      "  - annotations:",
      "      artifacthub.io/changes: |",
      "        - kind: fixed",
      "    dependencies:",
      "    - condition: redis.enabled",
      "      name: redis",
      "      version: 10.5.3",
      "    name: spinnaker",
      "    version: 2.2.7",
      "generated: '2026-10-03T00:00:00Z'",
    ].join("\n");
    expect(chartVersionsOf(idx, "spinnaker")).toEqual(["2.2.7"]);
  });
});

/** Danh sách version của chart `kyverno` trong `INDEX` — dùng ở cả hai khối dưới */
const versions = chartVersionsOf(INDEX, "kyverno");

describe("chartFinding — ba luật trước newerTags", () => {
  it("ghim đúng và là bản mới nhất ⇒ ok", () => {
    const f = chartFinding(pinOf(), { versions });
    expect(f.status).toBe("ok");
    expect(f.kind).toBe("chart");
    expect(isActionable(f)).toBe(false);
  });

  it("ghim KHÔNG tồn tại ⇒ broken, và nó ĐỎ", () => {
    const f = chartFinding(pinOf({ version: "3.9.99" }), { versions });
    expect(f.status).toBe("broken");
    expect(isActionable(f)).toBe(true);
    expect(f.detail).toContain("không còn trong index.yaml");
  });

  it("lệch tiền tố `v` ⇒ shape, KHÔNG phải ok — đây là ca `raw` thật", () => {
    /**
     * `newerTags("0.3.2", ["v0.3.2", …])` trả `{null, null}` vì không bản nào cùng tiền tố, và `versionFinding`
     * đọc nó thành `ok`. Luật `shape` là chỗ duy nhất phân biệt "đã mới nhất" với "không có bản nào cùng hình
     * dạng".
     */
    expect(newerTags("0.3.2", ["v0.3.2", "v0.3.1"])).toEqual({
      patch: null,
      newerLine: null,
    });
    const f = chartFinding(
      { ...pinOf({ name: "raw", version: "0.3.2" }) },
      { versions: ["v0.3.2", "v0.3.1", "v0.3.0"] },
    );
    expect(f.status).toBe("shape");
    expect(isActionable(f)).toBe(true);
  });

  it("số thành phần khác cũng là shape", () => {
    expect(chartFinding(pinOf({ version: "3.9" }), { versions }).status).toBe(
      "shape",
    );
  });

  it("repo không đọc được, hay repo không có chart ⇒ repo-gone, và nó ĐỎ", () => {
    const err = chartFinding(pinOf(), { versions: null, error: "HTTP 404" });
    expect(err.status).toBe("repo-gone");
    expect(isActionable(err)).toBe(true);
    expect(err.detail).toContain("HTTP 404");

    const absent = chartFinding(pinOf({ name: "khong-co" }), {
      versions: null,
    });
    expect(absent.status).toBe("repo-gone");
    expect(absent.detail).toContain("không có chart");
  });
});

describe("chartFinding — ngưỡng đỏ, ghim đóng băng, và repo không canh được", () => {
  it("bản vá chart ⇒ chart-update, và nó KHÔNG đỏ", () => {
    /**
     * Quyết định đo được: toàn bộ ghim chart của sản phẩm cho 27–29 mục `update` ngay lượt chạy đầu, mỗi mục đòi
     * một lượt nâng cấp §8.6 đầy đủ. Để `chart-update` làm job đỏ là dựng đúng cái mà chú thích của
     * `versionFinding` đã cấm — một cổng đỏ vĩnh viễn không ai nhìn.
     */
    const f = chartFinding(pinOf({ version: "3.9.0" }), { versions });
    expect(f.status).toBe("chart-update");
    expect(f.detail).toContain("bản vá: 3.9.1");
    expect(isActionable(f)).toBe(false);
  });

  it("chỉ có dòng mới hơn ⇒ newer-line, cũng không đỏ", () => {
    const f = chartFinding(pinOf({ version: "3.2.7" }), { versions });
    expect(f.status).toBe("newer-line");
    expect(isActionable(f)).toBe(false);
  });

  it("bản thử nghiệm KHÔNG bao giờ thành bản vá của một ghim ổn định", () => {
    expect(newerTags("3.9.1", ["3.9.2-rc.1", "3.9.0"]).patch).toBeNull();
    /**
     * Nhưng tính chất thật của `newerTags` là "suffix phải TRÙNG", không phải "loại pre-release" — một ghim có
     * hậu tố sẽ tự nâng sang hậu tố cùng loại. Đó là lý do `assertChartPins` cấm ghim có hậu tố, và ô dưới đây
     * ghim lại hành vi để nó là một quyết định chứ không phải một tai nạn.
     */
    expect(newerTags("v1.11.0-beta.0", ["v1.11.1-beta.0"]).patch).toBe(
      "v1.11.1-beta.0",
    );
  });

  it("ghim ĐÓNG BĂNG: chỉ kiểm tồn tại, không bao giờ ra chart-update", () => {
    const frozen = pinOf({ version: "3.2.7", frozen: true });
    const ok = chartFinding(frozen, { versions });
    // index CÓ 3.9.1 mới hơn, nhưng ghim đóng băng không được báo bản vá
    expect(ok.status).toBe("ok");
    expect(ok.subject).toContain("đóng băng");

    // Mất khỏi index ⇒ `restoreTo` của §8.6 không còn đường áp lại ⇒ ĐỎ
    const gone = chartFinding(pinOf({ version: "3.2.6", frozen: true }), {
      versions,
    });
    expect(gone.status).toBe("broken");
    expect(isActionable(gone)).toBe(true);
  });

  it("oci://, gs:// và manifest-bundle ⇒ unwatched kèm lý do, KHÔNG broken giả", () => {
    for (const [over, needle] of [
      [{ repo: "oci://public.ecr.aws/aws-controllers-k8s" }, "OCI"],
      [{ repo: "gs://configconnector-operator" }, "gs"],
      [{ installer: "manifest-bundle" as const }, "bundle manifest"],
    ] as const) {
      const pin = pinOf(over);
      expect(unwatchableReason(pin)).not.toBeNull();
      const f = chartFinding(pin, { versions: null });
      expect(f.status, JSON.stringify(over)).toBe("unwatched");
      expect(f.detail).toContain(needle);
      expect(isActionable(f)).toBe(false);
    }
  });

  it("chart dùng chung ra MỘT dòng, cột nguồn liệt kê mọi adapter", () => {
    const f = chartFinding(
      pinOf({
        name: "raw",
        version: "v0.3.2",
        usedBy: ["database-adapter/mysql", "database-adapter/redis"],
      }),
      { versions: ["v0.3.2"] },
    );
    expect(f.source).toBe("database-adapter/mysql, database-adapter/redis");
  });
});

describe("đường cơ sở KNOWN_BROKEN_CHARTS", () => {
  const brokenFinding = (name: string): Finding =>
    chartFinding(pinOf({ name, version: "9.9.9" }), {
      versions: ["1.0.0", "1.0.1"],
    });

  it("ghim đã biết hỏng ⇒ không làm job đỏ, nhưng VẪN hiện kèm lý do", () => {
    const [f] = applyKnownBroken([brokenFinding("spinnaker")], {
      spinnaker: "chart không có khoá kayenta",
    });
    expect(f?.status).toBe("known-broken");
    expect(f?.detail).toContain("ĐÃ BIẾT: chart không có khoá kayenta");
    expect(isActionable(f as Finding)).toBe(false);
  });

  it("ghim MỚI hỏng, không có trong danh sách ⇒ vẫn ĐỎ", () => {
    const [f] = applyKnownBroken([brokenFinding("chart-khac")], {
      spinnaker: "lý do",
    });
    expect(f?.status).toBe("broken");
    expect(isActionable(f as Finding)).toBe(true);
  });

  it("ghim trong danh sách mà đã HẾT hỏng ⇒ ĐỎ, để ai đó xoá lời miễn trừ", () => {
    /** Một đường cơ sở không tự dọn là một đường cơ sở sẽ mục. Chiều này là thứ giữ nó sống. */
    const ok = chartFinding(pinOf({ name: "spinnaker", version: "1.0.0" }), {
      versions: ["1.0.0"],
    });
    expect(ok.status).toBe("ok");
    const [f] = applyKnownBroken([ok], { spinnaker: "lý do cũ" });
    expect(f?.status).toBe("broken");
    expect(f?.detail).toContain("xoá nó khỏi KNOWN_BROKEN_CHARTS");
    expect(isActionable(f as Finding)).toBe(true);
  });

  it("không chạm finding của ghim image", () => {
    const image: Finding = {
      kind: "image",
      source: "TEST_IMAGES.nodejs",
      subject: "spinnaker@9.9.9",
      status: "broken",
      detail: "x",
    };
    expect(applyKnownBroken([image], { spinnaker: "lý do" })).toEqual([image]);
  });
});
