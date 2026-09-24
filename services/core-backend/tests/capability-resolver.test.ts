import type { CapabilityId } from "@udp/shared-types";
import { satisfies as semverSatisfies } from "semver";
import { describe, expect, it } from "vitest";
import {
  adapterKey,
  assertDeclarationValid,
  InvalidCapabilityDeclarationError,
  OrphanPreferenceError,
  topoSort,
  validateAndOrder,
  type ResolvableAdapter,
} from "../src/modules/capability/capability.resolver.js";
import {
  oracleSatisfies,
  oracleValidate,
  type OracleAdapter,
  type OraclePreference,
} from "./oracle/capability-oracle.js";

/**
 * [v4.10] Cổng P15 — resolver đối chiếu ORACLE, cộng các bảng ô của SPEC §2.8.
 *
 * Bộ này có bốn tầng, và tầng thứ nhất là tầng mạnh nhất:
 *
 *  1. **Differential** — sinh tổ hợp ngẫu nhiên xác định (seed cố định) rồi so resolver
 *     với oracle từng trường. Nó bắt được những ca không ai nghĩ ra để viết thành ô.
 *  2. **Tính chất** — kết quả BẤT BIẾN theo hoán vị thứ tự adapter. Người dùng bật tool
 *     theo thứ tự nào là chuyện của họ; một validator phụ thuộc thứ tự cho hai thông báo
 *     khác nhau cho cùng một tổ hợp.
 *  3. **Bảng ô** — semver, exclusive, conflicts, anyOf, recommends, theo đúng số ô cổng
 *     P15 đòi.
 *  4. **Biên của oracle** — nơi hai bộ so sánh semver ĐƯỢC PHÉP khác nhau, nói rõ thay
 *     vì để nó thành một lần đỏ bất ngờ.
 */

/**
 * N5 — hằng số kiểm được, và con số được chốt SAU phép đo.
 *
 * Đã đo: 2 000 mẫu cộng 300 hoán vị chạy hết **152 ms**. Với ngân sách đó, giữ 2 000 là
 * bỏ không phần lớn cái mình được phép dùng — nên chốt **20 000**, đo lại còn ~1 s. Ghi
 * cả hai con số ra đây vì một hằng số không kèm phép đo là một hằng số người sau sẽ hạ
 * xuống cho "test nhanh hơn" mà không biết mình đang trả lại cái gì.
 *
 * Trần: ô này phải dưới 30 s (mặc định `testTimeout` của gói), và meta-test cuối tệp
 * khẳng định điều đó thay vì tin.
 */
export const DIFFERENTIAL_SAMPLES = 20_000;

const CAPS: CapabilityId[] = [
  "metrics.query",
  "logs.sink",
  "traces.sink",
  "registry.oci",
  "traffic.control",
];

const VERSIONS = ["1.0.0", "1.2.0", "2.0.0", "2.3.4", "0.2.0", "0.3.0"];
/** CHỈ những dạng oracle phủ — xem tầng 4 về vì sao không lấy dạng ngoài danh sách */
const CONSTRAINTS = [
  undefined,
  "*",
  "^1",
  "^2",
  "^0.2.0",
  "~2.3.4",
  ">=1.0.0",
  ">2.0.0",
  "<=2.0.0",
  "<1.2.0",
  "2.0.0",
];

/**
 * Sinh số giả ngẫu nhiên XÁC ĐỊNH (mulberry32).
 *
 * Seed cố định, nên một lần đỏ tái tạo được: `Math.random()` cho một bộ differential đỏ
 * một lần rồi xanh lần sau, tức một lỗi thật bị nhìn như một lần rung.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

interface Sample {
  adapters: ResolvableAdapter[];
  prefs: OraclePreference[];
}

/**
 * Một tổ hợp ngẫu nhiên.
 *
 * Nó CÓ THỂ sinh ra tổ hợp không hợp lệ, và đó là mục đích: mỗi mã lỗi phải được hai bên
 * phát ra giống nhau. Nó chỉ tránh đúng một thứ — constraint ngoài danh sách oracle phủ —
 * vì ở đó oracle NÉM và sự khác biệt không nói gì về resolver.
 */
function sampleOf(r: () => number): Sample {
  const n = 1 + Math.floor(r() * 4);
  const adapters: ResolvableAdapter[] = [];

  for (let i = 0; i < n; i += 1) {
    const provides = [];
    const pcount = Math.floor(r() * 3);
    for (let k = 0; k < pcount; k += 1) {
      const id = pick(r, CAPS);
      provides.push({
        id,
        version: pick(r, VERSIONS),
        /** `traffic.control` là capability exclusive của §5.3; các cái khác hiếm khi */
        ...(id === "traffic.control" || r() < 0.15 ? { exclusive: true } : {}),
      });
    }

    const requires = [];
    const rcount = Math.floor(r() * 3);
    for (let k = 0; k < rcount; k += 1) {
      if (r() < 0.2) {
        /**
         * Nhanh anyOf dung mot helper vi `exactOptionalPropertyTypes` cam
         * `{ constraint: undefined }`: `pick` co the tra `undefined`, nen phai dung
         * object co dieu kien chu khong spread mot gia tri co the undefined.
         */
        const branch = (): { id: CapabilityId; constraint?: string } => {
          const id = pick(r, CAPS);
          const c = r() < 0.5 ? pick(r, CONSTRAINTS) : undefined;
          return c === undefined ? { id } : { id, constraint: c };
        };
        requires.push({ anyOf: [branch(), branch()] });
      } else {
        const c = pick(r, CONSTRAINTS);
        requires.push({
          id: pick(r, CAPS),
          ...(c === undefined ? {} : { constraint: c }),
        });
      }
    }

    const recommends = r() < 0.25 ? [pick(r, CAPS)] : undefined;

    adapters.push({
      domainType: "d",
      toolId: `t${String(i)}`,
      capabilities: {
        provides,
        requires,
        ...(recommends === undefined ? {} : { recommends }),
      },
    });
  }

  /** Preference chỉ trỏ tới provider CÓ THẬT — hàng mồ côi là ca riêng, có ô riêng */
  const prefs: OraclePreference[] = [];
  if (r() < 0.3) {
    const cap = pick(r, CAPS);
    const providers = adapters
      .filter((a) => a.capabilities.provides.some((p) => p.id === cap))
      .map(adapterKey);
    if (providers.length > 0) {
      prefs.push({ capabilityId: cap, providerToolId: pick(r, providers) });
    }
  }
  return { adapters, prefs };
}

/** Hai bên phải cho cùng kết luận; `null` nếu khớp, hay chuỗi mô tả chỗ lệch */
function compare(sample: Sample): string | null {
  const asOracle = sample.adapters as unknown as OracleAdapter[];

  let mine;
  let theirs;
  try {
    mine = validateAndOrder(sample.adapters, sample.prefs);
  } catch (err) {
    mine = { thrown: (err as { code?: string }).code ?? "NEM" };
  }
  try {
    theirs = oracleValidate(asOracle, sample.prefs);
  } catch (err) {
    theirs = { thrown: (err as { code?: string }).code ?? "NEM" };
  }

  if ("thrown" in mine || "thrown" in theirs) {
    const a = "thrown" in mine ? mine.thrown : "KHONG NEM";
    const b = "thrown" in theirs ? theirs.thrown : "KHONG NEM";
    return a === b ? null : `ném: resolver=${a} oracle=${b}`;
  }

  if (mine.valid !== theirs.valid) {
    return `valid: ${String(mine.valid)} vs ${String(theirs.valid)}`;
  }
  const mineCodes = mine.errors.map((e) => `${e.code}@${e.subject}`);
  const theirCodes = theirs.errors.map((e) => `${e.code}@${e.subject}`);
  if (JSON.stringify(mineCodes) !== JSON.stringify(theirCodes)) {
    return `lỗi: ${JSON.stringify(mineCodes)} vs ${JSON.stringify(theirCodes)}`;
  }
  const mineDetail = mine.errors.map((e) => [...e.detail].sort());
  const theirDetail = theirs.errors.map((e) => [...e.detail].sort());
  if (JSON.stringify(mineDetail) !== JSON.stringify(theirDetail)) {
    return `detail: ${JSON.stringify(mineDetail)} vs ${JSON.stringify(theirDetail)}`;
  }
  if (JSON.stringify(mine.chosen) !== JSON.stringify(theirs.chosen)) {
    return `chosen: ${JSON.stringify(mine.chosen)} vs ${JSON.stringify(theirs.chosen)}`;
  }
  const mineWarn = mine.warnings.map((w) => `${w.code}@${w.subject}:${w.detail.join(",")}`).sort();
  const theirWarn = theirs.warnings.map((w) => `${w.code}@${w.subject}:${w.detail.join(",")}`).sort();
  if (JSON.stringify(mineWarn) !== JSON.stringify(theirWarn)) {
    return `warning: ${JSON.stringify(mineWarn)} vs ${JSON.stringify(theirWarn)}`;
  }
  if (JSON.stringify(mine.order) !== JSON.stringify(theirs.order)) {
    return `order: ${JSON.stringify(mine.order)} vs ${JSON.stringify(theirs.order)}`;
  }
  return null;
}

describe("differential — resolver đối chiếu oracle", () => {
  it(`${String(DIFFERENTIAL_SAMPLES)} tổ hợp: hai hiện thực cho cùng kết luận`, () => {
    const r = rng(0x5eed_24_10);
    const mismatches: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < DIFFERENTIAL_SAMPLES; i += 1) {
      const sample = sampleOf(r);
      const diff = compare(sample);
      if (diff !== null && mismatches.length < 5) {
        mismatches.push(`#${String(i)} ${diff}\n${JSON.stringify(sample)}`);
      }
      /** Ghi lại mã đã gặp để phép dưới khẳng định bộ sinh có CHẠM tới mọi nhánh */
      try {
        const res = validateAndOrder(sample.adapters, sample.prefs);
        for (const e of res.errors) seen.add(e.code);
        for (const w of res.warnings) seen.add(w.code);
        if (res.valid) seen.add("OK");
      } catch {
        seen.add("ORPHAN_PREFERENCE");
      }
    }
    expect(mismatches).toEqual([]);

    /**
     * Bộ sinh phải CHẠM tới từng nhánh, không chỉ chạy nhiều lần.
     *
     * Không có khẳng định này, một bộ sinh chỉ tạo ra tổ hợp một-adapter-không-requires
     * vẫn "2000 mẫu xanh" — và nó kiểm đúng một nhánh.
     */
    for (const code of [
      "OK",
      "CONFLICT",
      "MISSING_CAPABILITY",
      "VERSION_MISMATCH",
      "AMBIGUOUS_PROVIDER",
      "RECOMMENDED_MISSING",
    ]) {
      expect([...seen], `bộ sinh chưa bao giờ tạo ra ${code}`).toContain(code);
    }
  }, 60_000);
});

describe("tính chất — kết quả BẤT BIẾN theo hoán vị thứ tự adapter", () => {
  /**
   * Vì sao tính chất này quan trọng hơn nó trông: người dùng bật tool theo thứ tự nào là
   * chuyện của họ. Một validator phụ thuộc thứ tự cho hai thông báo khác nhau cho cùng
   * một tổ hợp, và người dùng thấy điều đó dưới dạng "bật lại theo thứ tự khác thì lỗi
   * đổi" — một hành vi không ai báo lỗi được vì không ai tái tạo được.
   */
  it("mọi hoán vị của cùng một tổ hợp cho cùng một kết quả", () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < 300; i += 1) {
      const { adapters, prefs } = sampleOf(r);
      const run = (list: ResolvableAdapter[]): string => {
        try {
          return JSON.stringify(validateAndOrder(list, prefs));
        } catch (err) {
          return `NEM:${(err as { code?: string }).code ?? "?"}`;
        }
      };
      const base = run(adapters);
      /** Hoán vị đảo và một hoán vị xoay — đủ để bắt phụ thuộc thứ tự chèn của Map */
      const reversed = run([...adapters].reverse());
      const rotated = run([...adapters.slice(1), ...adapters.slice(0, 1)]);
      expect(reversed, `hoán vị đảo #${String(i)}`).toBe(base);
      expect(rotated, `hoán vị xoay #${String(i)}`).toBe(base);
    }
  }, 30_000);
});

const A = (
  toolId: string,
  capabilities: ResolvableAdapter["capabilities"],
): ResolvableAdapter => ({ domainType: "d", toolId, capabilities });

describe("bảng semver — mười hai ô, và hai bộ so sánh phải đồng ý", () => {
  const rows: [string, string, boolean][] = [
    ["2.3.4", "*", true],
    ["2.3.4", "2.3.4", true],
    ["2.3.4", "2.3.5", false],
    ["2.3.4", "^2", true],
    ["3.0.0", "^2", false],
    ["2.3.4", "~2.3.4", true],
    ["2.4.0", "~2.3.4", false],
    ["2.3.4", ">=1.0.0", true],
    ["0.9.0", ">=1.0.0", false],
    ["2.0.0", ">2.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
  ];

  it("có ít nhất mười ô", () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it("oracle và semver đồng ý trên MỌI ô", () => {
    const disagree = rows.filter(
      ([v, c]) => oracleSatisfies(v, c) !== semverSatisfies(v, c),
    );
    expect(disagree).toEqual([]);
  });

  it("kết quả mong đợi viết TAY khớp cả hai bộ", () => {
    for (const [v, c, want] of rows) {
      expect(oracleSatisfies(v, c), `oracle ${v} ${c}`).toBe(want);
      expect(semverSatisfies(v, c), `semver ${v} ${c}`).toBe(want);
    }
  });

  /**
   * Biên của oracle, nói rõ thay vì để nó thành một lần đỏ bất ngờ.
   *
   * Oracle NÉM cho dạng nó không phủ, còn `semver` hiểu chúng. Đó là chủ ý: một oracle
   * đoán ở chỗ nó không hiểu là một oracle âm thầm đồng ý với một resolver sai. Bộ sinh
   * differential vì thế chỉ dùng dạng trong danh sách phủ.
   */
  it("dạng ngoài danh sách phủ: oracle NÉM, semver thì hiểu", () => {
    for (const c of [">=1.0.0 <2.0.0", "1.0.0 || 2.0.0", "~2"]) {
      expect(() => oracleSatisfies("1.5.0", c), c).toThrow();
      expect(() => semverSatisfies("1.5.0", c), c).not.toThrow();
    }
  });
});

describe("exclusive — ba ô", () => {
  it("hai provider exclusive ⇒ CONFLICT", () => {
    const res = validateAndOrder([
      A("flagger", {
        provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
        requires: [],
      }),
      A("argo", {
        provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
        requires: [],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("CONFLICT");
  });

  it("MỘT provider exclusive ⇒ hợp lệ", () => {
    const res = validateAndOrder([
      A("flagger", {
        provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
        requires: [],
      }),
    ]);
    expect(res.valid).toBe(true);
  });

  /**
   * `exclusive` + preference ⇒ VẪN CONFLICT (SPEC §2.8).
   *
   * Đây là ô mà thứ tự ưu tiên tường minh sinh ra để giải: nếu preference được đọc trước,
   * người dùng "chọn Flagger" sẽ gỡ được ràng buộc exclusive, và hệ quả là hai controller
   * cùng chia traffic trên một cluster.
   */
  it("exclusive + preference ⇒ VẪN CONFLICT", () => {
    const res = validateAndOrder(
      [
        A("flagger", {
          provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
          requires: [],
        }),
        A("argo", {
          provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
          requires: [],
        }),
      ],
      [{ capabilityId: "traffic.control", providerToolId: "d:flagger" }],
    );
    expect(res.errors[0]?.code).toBe("CONFLICT");
  });
});

describe("conflicts tool-level — bốn ô", () => {
  it("khai một chiều vẫn bị bắt (chiều xuôi)", () => {
    const res = validateAndOrder([
      A("a", { provides: [], requires: [], conflicts: ["d:b"] }),
      A("b", { provides: [], requires: [] }),
    ]);
    expect(res.errors[0]?.code).toBe("CONFLICT");
  });

  it("khai một chiều vẫn bị bắt (chiều ngược)", () => {
    const res = validateAndOrder([
      A("a", { provides: [], requires: [] }),
      A("b", { provides: [], requires: [], conflicts: ["d:a"] }),
    ]);
    expect(res.errors[0]?.code).toBe("CONFLICT");
  });

  it("đối tượng conflict KHÔNG có trong tổ hợp ⇒ hợp lệ", () => {
    const res = validateAndOrder([
      A("a", { provides: [], requires: [], conflicts: ["d:khong-bat"] }),
    ]);
    expect(res.valid).toBe(true);
  });

  it("conflicts trỏ tới CHÍNH NÓ ⇒ CONFLICT, không im lặng bỏ qua", () => {
    const res = validateAndOrder([
      A("a", { provides: [], requires: [], conflicts: ["d:a"] }),
    ]);
    expect(res.errors[0]?.code).toBe("CONFLICT");
  });
});

describe("anyOf — bốn ô", () => {
  it("một nhánh thoả ⇒ hợp lệ", () => {
    const res = validateAndOrder([
      A("p", { provides: [{ id: "logs.sink", version: "1.0.0" }], requires: [] }),
      A("c", {
        provides: [],
        requires: [{ anyOf: [{ id: "logs.sink" }, { id: "traces.sink" }] }],
      }),
    ]);
    expect(res.valid).toBe(true);
  });

  it("không nhánh nào thoả ⇒ MISSING_ANY_OF liệt kê đủ nhánh", () => {
    const res = validateAndOrder([
      A("c", {
        provides: [],
        requires: [{ anyOf: [{ id: "logs.sink" }, { id: "traces.sink" }] }],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("MISSING_ANY_OF");
    expect(res.errors[0]?.detail).toEqual(["logs.sink", "traces.sink"]);
  });

  it("nhánh có mặt nhưng SAI VERSION ⇒ vẫn MISSING_ANY_OF, không VERSION_MISMATCH", () => {
    /**
     * Đây là ngữ nghĩa của §5.3, và nó đáng nói ra: với `anyOf`, "có mà sai version" và
     * "không có" dẫn tới cùng một kết luận — không nhánh nào dùng được. Tách hai mã ở đây
     * sẽ buộc UI hiện hai thông báo cho cùng một hành động sửa.
     */
    const res = validateAndOrder([
      A("p", { provides: [{ id: "logs.sink", version: "1.0.0" }], requires: [] }),
      A("c", {
        provides: [],
        requires: [{ anyOf: [{ id: "logs.sink", constraint: "^2" }, { id: "traces.sink" }] }],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("MISSING_ANY_OF");
  });

  it("anyOf một nhánh ⇒ LỖI KHAI BÁO, không phải một tổ hợp không hợp lệ", () => {
    expect(() =>
      validateAndOrder([
        A("c", { provides: [], requires: [{ anyOf: [{ id: "logs.sink" }] }] }),
      ]),
    ).toThrow(InvalidCapabilityDeclarationError);
  });
});

describe("recommends — ba ô", () => {
  it("thiếu ⇒ cảnh báo, tổ hợp VẪN hợp lệ", () => {
    const res = validateAndOrder([
      A("a", { provides: [], requires: [], recommends: ["traces.sink"] }),
    ]);
    expect(res.valid).toBe(true);
    expect(res.warnings[0]?.code).toBe("RECOMMENDED_MISSING");
  });

  it("có ⇒ không cảnh báo", () => {
    const res = validateAndOrder([
      A("p", { provides: [{ id: "traces.sink", version: "1.0.0" }], requires: [] }),
      A("a", { provides: [], requires: [], recommends: ["traces.sink"] }),
    ]);
    expect(res.warnings).toEqual([]);
  });

  it("recommends KHÔNG đổi thứ tự deploy", () => {
    const res = validateAndOrder([
      A("p", { provides: [{ id: "traces.sink", version: "1.0.0" }], requires: [] }),
      A("a", { provides: [], requires: [], recommends: ["traces.sink"] }),
    ]);
    /** Không cạnh nào ⇒ cùng một bậc, deploy song song */
    expect(res.order).toEqual([["d:a", "d:p"]]);
  });
});

describe("ba nhánh của §2.8 mà pseudo-code cũ làm sai", () => {
  it("capability KHÔNG consumer, 2 provider ⇒ ok, chosen thiếu khoá, topoSort vẫn chạy", () => {
    const res = validateAndOrder([
      A("prometheus", {
        provides: [{ id: "metrics.query", version: "2.0.0" }],
        requires: [],
      }),
      A("victoria", {
        provides: [{ id: "metrics.query", version: "2.1.0" }],
        requires: [],
      }),
    ]);
    expect(res.valid).toBe(true);
    expect(Object.keys(res.chosen)).not.toContain("metrics.query");
    expect(res.order).toEqual([["d:prometheus", "d:victoria"]]);
  });

  it("preference không thoả ⇒ VERSION_MISMATCH nêu TÊN preference", () => {
    const res = validateAndOrder(
      [
        A("datadog", {
          provides: [{ id: "metrics.query", version: "1.0.0" }],
          requires: [],
        }),
        A("prometheus", {
          provides: [{ id: "metrics.query", version: "2.0.0" }],
          requires: [],
        }),
        A("flagger", {
          provides: [],
          requires: [{ id: "metrics.query", constraint: "^2" }],
        }),
      ],
      [{ capabilityId: "metrics.query", providerToolId: "d:datadog" }],
    );
    expect(res.errors[0]?.code).toBe("VERSION_MISMATCH");
    expect(res.errors[0]?.subject).toBe("d:datadog");
  });

  it("preference mồ côi ⇒ NÉM lỗi khởi động", () => {
    expect(() =>
      validateAndOrder(
        [
          A("prometheus", {
            provides: [{ id: "metrics.query", version: "2.0.0" }],
            requires: [{ id: "metrics.query" }],
          }),
        ],
        [{ capabilityId: "metrics.query", providerToolId: "d:da-tat" }],
      ),
    ).toThrow(OrphanPreferenceError);
  });
});

describe("khai báo sai ⇒ lỗi khởi động, không phải VERSION_MISMATCH", () => {
  it("version thiếu thành phần ⇒ NÉM", () => {
    expect(() =>
      assertDeclarationValid(
        A("a", { provides: [{ id: "metrics.query", version: "2" }], requires: [] }),
      ),
    ).toThrow(InvalidCapabilityDeclarationError);
  });

  it("constraint không phải khoảng semver ⇒ NÉM", () => {
    expect(() =>
      assertDeclarationValid(
        A("a", {
          provides: [],
          requires: [{ id: "metrics.query", constraint: "moi-nhat" }],
        }),
      ),
    ).toThrow(InvalidCapabilityDeclarationError);
  });

  /**
   * Vì sao đây là lỗi KHỞI ĐỘNG chứ không phải một mã lỗi của validator: `VERSION_MISMATCH`
   * nói với NGƯỜI DÙNG rằng tổ hợp của họ sai, còn một `version` khai thiếu thành phần là
   * lỗi của adapter. Gửi người dùng đi sửa cấu hình vì một lỗi khai báo là gửi họ đi sai
   * hướng, và họ không có cách nào sửa được.
   */
  it("resolver gọi assertDeclarationValid TRƯỚC mọi bước", () => {
    expect(() =>
      validateAndOrder([
        A("a", { provides: [{ id: "metrics.query", version: "2" }], requires: [] }),
      ]),
    ).toThrow(InvalidCapabilityDeclarationError);
  });
});

describe("topoSort — bậc, chu trình, tự-vòng", () => {
  it("provider trước consumer", () => {
    const p = A("p", { provides: [{ id: "metrics.query", version: "1.0.0" }], requires: [] });
    const c = A("c", { provides: [], requires: [{ id: "metrics.query" }] });
    expect(topoSort([c, p], { "metrics.query": "d:p" })).toEqual([["d:p"], ["d:c"]]);
  });

  it("chu trình hai đỉnh ⇒ null", () => {
    const a = A("a", {
      provides: [{ id: "metrics.query", version: "1.0.0" }],
      requires: [{ id: "logs.sink" }],
    });
    const b = A("b", {
      provides: [{ id: "logs.sink", version: "1.0.0" }],
      requires: [{ id: "metrics.query" }],
    });
    expect(topoSort([a, b], { "metrics.query": "d:a", "logs.sink": "d:b" })).toBeNull();
  });

  it("tự-vòng KHÔNG phải chu trình", () => {
    const a = A("a", {
      provides: [{ id: "metrics.query", version: "1.0.0" }],
      requires: [{ id: "metrics.query" }],
    });
    expect(topoSort([a], { "metrics.query": "d:a" })).toEqual([["d:a"]]);
  });

  it("chosen trỏ tới adapter KHÔNG trong tổ hợp ⇒ bỏ qua cạnh đó", () => {
    /**
     * Ca này xảy ra khi `chosen` đến từ một lần chạy trước (persist ở
     * `capability_bindings`) mà tổ hợp đã đổi. Coi cạnh đó là thật sẽ làm topo báo chu
     * trình cho một tổ hợp không có chu trình nào.
     */
    const a = A("a", { provides: [], requires: [{ id: "metrics.query" }] });
    expect(topoSort([a], { "metrics.query": "d:da-bi-tat" })).toEqual([["d:a"]]);
  });
});

/**
 * Meta — hằng số của N5, và trần thời gian đã đo.
 *
 * Con số ở đây không phải để trang trí: `DIFFERENTIAL_SAMPLES` là một trong danh sách
 * hằng số kiểm được của N5, và hạ nó xuống là làm yếu bộ test theo cách không để lại dấu
 * trong diff ngoài một chữ số.
 */
describe("meta — hằng số và trần thời gian", () => {
  it("DIFFERENTIAL_SAMPLES là 20 000, chốt sau phép đo", () => {
    expect(DIFFERENTIAL_SAMPLES).toBe(20_000);
  });

  it("chạy đủ số mẫu trong dưới 10 giây", () => {
    const started = Date.now();
    const r = rng(0xbeef);
    for (let i = 0; i < DIFFERENTIAL_SAMPLES; i += 1) {
      const diff = compare(sampleOf(r));
      expect(diff).toBeNull();
    }
    const ms = Date.now() - started;
    console.log(`[do] differential ${String(DIFFERENTIAL_SAMPLES)} mẫu: ${String(ms)} ms`);
    /**
     * Trần 10 s với số đo ~650 ms là 15 lần biên. Rộng có chủ đích: máy CI chậm hơn máy
     * phát triển, và một trần sát số đo là một trần sẽ rung ở CI rồi bị ai đó nâng lên
     * mà không đọc lý do.
     */
    expect(ms).toBeLessThan(10_000);
  }, 30_000);
});
