import { describe, expect, it } from "vitest";
import {
  keyOf,
  oracleSatisfies,
  oracleTopoSort,
  oracleValidate,
  ORACLE_CODES,
  OrphanPreferenceError,
  type OracleAdapter,
} from "./oracle/capability-oracle.js";

/**
 * [v4.10] Cổng P14 — oracle sinh đủ **7/7** mã kết quả của §5.3.
 *
 * Vì sao con số đầy đủ là một cổng: một oracle chỉ sinh được 5 trong 7 mã thì
 * differential test ở P15 **không so được** hai nhánh còn lại, và nó sẽ xanh vì cả hai
 * bên đều không bao giờ đi tới đó. Đó là hình dạng "xanh mà không kiểm gì" ở mức bộ test,
 * và nó khó thấy hơn nhiều so với một phép kiểm rỗng.
 *
 * Mọi tổ hợp ở đây dựng TAY, không lấy từ registry thật: 16 adapter thật là một tập hợp
 * hợp lệ, nên chúng không sinh được sáu mã lỗi nào cả.
 */

function adapterOf(
  toolId: string,
  capabilities: OracleAdapter["capabilities"],
  domainType = "monitoring",
): OracleAdapter {
  return { domainType, toolId, capabilities };
}

describe("oracle sinh đủ bảy mã kết quả", () => {
  it("danh sách mã là dữ liệu, và có đúng bảy", () => {
    expect(ORACLE_CODES).toHaveLength(7);
    expect(new Set(ORACLE_CODES).size).toBe(7);
  });

  it("CONFLICT — hai provider của một capability exclusive", () => {
    const res = oracleValidate([
      adapterOf("flagger", {
        provides: [
          { id: "traffic.control", version: "1.0.0", exclusive: true },
        ],
        requires: [],
      }),
      adapterOf("argo-rollouts", {
        provides: [
          { id: "traffic.control", version: "1.0.0", exclusive: true },
        ],
        requires: [],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("CONFLICT");
    expect(res.errors[0]?.subject).toBe("traffic.control");
  });

  it("CONFLICT — ngoại lệ tool-level, kiểm cả hai chiều", () => {
    const res = oracleValidate([
      adapterOf("a", {
        provides: [],
        requires: [],
        conflicts: ["monitoring:b"],
      }),
      adapterOf("b", { provides: [], requires: [] }),
    ]);
    expect(res.errors[0]?.code).toBe("CONFLICT");
  });

  it("MISSING_CAPABILITY — không ai provide", () => {
    const res = oracleValidate([
      adapterOf("argo-rollouts", {
        provides: [],
        requires: [{ id: "metrics.query" }],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("MISSING_CAPABILITY");
    expect(res.errors[0]?.detail).toEqual(["metrics.query"]);
  });

  it("MISSING_ANY_OF — không nhánh nào được thoả", () => {
    const res = oracleValidate([
      adapterOf("tool", {
        provides: [],
        requires: [{ anyOf: [{ id: "logs.sink" }, { id: "traces.sink" }] }],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("MISSING_ANY_OF");
    expect(res.errors[0]?.detail).toEqual(["logs.sink", "traces.sink"]);
  });

  it("VERSION_MISMATCH — provider có capability nhưng sai semver", () => {
    const res = oracleValidate([
      adapterOf("datadog", {
        provides: [{ id: "metrics.query", version: "1.0.0" }],
        requires: [],
      }),
      adapterOf("flagger", {
        provides: [],
        requires: [{ id: "metrics.query", constraint: "^2" }],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("VERSION_MISMATCH");
  });

  it("AMBIGUOUS_PROVIDER — hai provider thoả, không preference", () => {
    const res = oracleValidate([
      adapterOf("prometheus", {
        provides: [{ id: "metrics.query", version: "2.0.0" }],
        requires: [],
      }),
      adapterOf("victoriametrics", {
        provides: [{ id: "metrics.query", version: "2.1.0" }],
        requires: [],
      }),
      adapterOf("flagger", {
        provides: [],
        requires: [{ id: "metrics.query", constraint: "^2" }],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("AMBIGUOUS_PROVIDER");
    expect(res.errors[0]?.detail).toEqual([
      "monitoring:prometheus",
      "monitoring:victoriametrics",
    ]);
  });

  it("CYCLIC_DEPENDENCY — hai adapter cần capability của nhau", () => {
    const res = oracleValidate([
      adapterOf("a", {
        provides: [{ id: "metrics.query", version: "1.0.0" }],
        requires: [{ id: "logs.sink" }],
      }),
      adapterOf("b", {
        provides: [{ id: "logs.sink", version: "1.0.0" }],
        requires: [{ id: "metrics.query" }],
      }),
    ]);
    expect(res.errors[0]?.code).toBe("CYCLIC_DEPENDENCY");
  });

  it("RECOMMENDED_MISSING — cảnh báo, và KHÔNG làm tổ hợp thành không hợp lệ", () => {
    const res = oracleValidate([
      adapterOf("tool", {
        provides: [],
        requires: [],
        recommends: ["traces.sink"],
      }),
    ]);
    expect(res.valid).toBe(true);
    expect(res.warnings[0]?.code).toBe("RECOMMENDED_MISSING");
    expect(res.warnings[0]?.detail).toEqual(["traces.sink"]);
  });

  /** Meta: bảy mã, và mỗi mã có ít nhất một ô ở trên sinh ra nó */
  it("mọi mã trong ORACLE_CODES đều được ít nhất một ô sinh ra", () => {
    const produced = new Set<string>();

    const record = (r: ReturnType<typeof oracleValidate>): void => {
      for (const e of r.errors) produced.add(e.code);
      for (const w of r.warnings) produced.add(w.code);
    };

    record(
      oracleValidate([
        adapterOf("flagger", {
          provides: [
            { id: "traffic.control", version: "1.0.0", exclusive: true },
          ],
          requires: [],
        }),
        adapterOf("argo", {
          provides: [
            { id: "traffic.control", version: "1.0.0", exclusive: true },
          ],
          requires: [],
        }),
      ]),
    );
    record(
      oracleValidate([
        adapterOf("x", { provides: [], requires: [{ id: "metrics.query" }] }),
      ]),
    );
    record(
      oracleValidate([
        adapterOf("x", {
          provides: [],
          requires: [{ anyOf: [{ id: "logs.sink" }, { id: "traces.sink" }] }],
        }),
      ]),
    );
    record(
      oracleValidate([
        adapterOf("dd", {
          provides: [{ id: "metrics.query", version: "1.0.0" }],
          requires: [],
        }),
        adapterOf("fl", {
          provides: [],
          requires: [{ id: "metrics.query", constraint: "^2" }],
        }),
      ]),
    );
    record(
      oracleValidate([
        adapterOf("p", {
          provides: [{ id: "metrics.query", version: "2.0.0" }],
          requires: [],
        }),
        adapterOf("v", {
          provides: [{ id: "metrics.query", version: "2.1.0" }],
          requires: [],
        }),
        adapterOf("f", {
          provides: [],
          requires: [{ id: "metrics.query", constraint: "^2" }],
        }),
      ]),
    );
    record(
      oracleValidate([
        adapterOf("a", {
          provides: [{ id: "metrics.query", version: "1.0.0" }],
          requires: [{ id: "logs.sink" }],
        }),
        adapterOf("b", {
          provides: [{ id: "logs.sink", version: "1.0.0" }],
          requires: [{ id: "metrics.query" }],
        }),
      ]),
    );
    record(
      oracleValidate([
        adapterOf("r", {
          provides: [],
          requires: [],
          recommends: ["traces.sink"],
        }),
      ]),
    );

    expect([...produced].sort()).toEqual([...ORACLE_CODES].sort());
  });
});

describe("oracle — ba nhánh của §2.8 mà pseudo-code cũ làm sai", () => {
  /** D-10 — capability không ai tiêu thụ: không chọn, không nhập nhằng, topo vẫn chạy */
  it("hai provider cho capability KHÔNG ai tiêu thụ ⇒ ok, chosen thiếu khoá", () => {
    const res = oracleValidate([
      adapterOf("prometheus", {
        provides: [{ id: "metrics.query", version: "2.0.0" }],
        requires: [],
      }),
      adapterOf("victoriametrics", {
        provides: [{ id: "metrics.query", version: "2.1.0" }],
        requires: [],
      }),
    ]);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    expect(Object.keys(res.chosen)).not.toContain("metrics.query");
    expect(res.order).not.toBeNull();
  });

  /** D-4' — preference không thoả ⇒ VERSION_MISMATCH nêu TÊN nó, không im lặng chọn khác */
  it("preference không thoả consumer ⇒ VERSION_MISMATCH nêu tên preference", () => {
    const res = oracleValidate(
      [
        adapterOf("datadog", {
          provides: [{ id: "metrics.query", version: "1.0.0" }],
          requires: [],
        }),
        adapterOf("prometheus", {
          provides: [{ id: "metrics.query", version: "2.0.0" }],
          requires: [],
        }),
        adapterOf("flagger", {
          provides: [],
          requires: [{ id: "metrics.query", constraint: "^2" }],
        }),
      ],
      [{ capabilityId: "metrics.query", providerToolId: "monitoring:datadog" }],
    );
    expect(res.errors[0]?.code).toBe("VERSION_MISMATCH");
    expect(res.errors[0]?.subject).toBe("monitoring:datadog");
  });

  /**
   * §2.8 — `exclusive` thắng preference.
   *
   * Hai provider của một capability `exclusive` là `CONFLICT` **dù** người dùng đã chọn
   * một trong hai: `exclusive` là ràng buộc về trạng thái cluster, còn preference là lựa
   * chọn giữa nhiều cái hợp lệ. Cho preference thắng nghĩa là một dropdown gỡ được một
   * ràng buộc an toàn.
   */
  it("exclusive + preference ⇒ VẪN CONFLICT", () => {
    const res = oracleValidate(
      [
        adapterOf("flagger", {
          provides: [
            { id: "traffic.control", version: "1.0.0", exclusive: true },
          ],
          requires: [],
        }),
        adapterOf("argo-rollouts", {
          provides: [
            { id: "traffic.control", version: "1.0.0", exclusive: true },
          ],
          requires: [],
        }),
      ],
      [
        {
          capabilityId: "traffic.control",
          providerToolId: "monitoring:flagger",
        },
      ],
    );
    expect(res.errors[0]?.code).toBe("CONFLICT");
  });

  it("preference mồ côi ⇒ NÉM, không phải một mã lỗi mới", () => {
    expect(() =>
      oracleValidate(
        [
          adapterOf("prometheus", {
            provides: [{ id: "metrics.query", version: "2.0.0" }],
            requires: [],
          }),
          adapterOf("flagger", {
            provides: [],
            requires: [{ id: "metrics.query", constraint: "^2" }],
          }),
        ],
        [
          {
            capabilityId: "metrics.query",
            providerToolId: "monitoring:da-tat-roi",
          },
        ],
      ),
    ).toThrow(OrphanPreferenceError);
  });
});

describe("oracle — semver tự viết, và nói rõ nó phủ tới đâu", () => {
  it("các dạng được phủ cho đúng kết quả", () => {
    expect(oracleSatisfies("2.3.4", "*")).toBe(true);
    expect(oracleSatisfies("2.3.4", "2.3.4")).toBe(true);
    expect(oracleSatisfies("2.3.4", "2.3.5")).toBe(false);
    expect(oracleSatisfies("2.3.4", "^2.0.0")).toBe(true);
    expect(oracleSatisfies("3.0.0", "^2.0.0")).toBe(false);
    expect(oracleSatisfies("2.3.4", "~2.3.0")).toBe(true);
    expect(oracleSatisfies("2.4.0", "~2.3.0")).toBe(false);
    expect(oracleSatisfies("2.3.4", ">=2.0.0")).toBe(true);
    expect(oracleSatisfies("1.9.9", ">=2.0.0")).toBe(false);
    expect(oracleSatisfies("2.0.0", ">2.0.0")).toBe(false);
    expect(oracleSatisfies("1.0.0", "<2.0.0")).toBe(true);
    expect(oracleSatisfies("2.0.0", "<=2.0.0")).toBe(true);
  });

  /** `^0.y.z` khoá cả minor — quy ước semver, và là chỗ dễ sai nhất */
  it("^0.y.z khoá cả minor", () => {
    expect(oracleSatisfies("0.2.5", "^0.2.0")).toBe(true);
    expect(oracleSatisfies("0.3.0", "^0.2.0")).toBe(false);
  });

  /**
   * Dạng NGOÀI danh sách phủ thì NÉM, không đoán.
   *
   * Đoán ở đây là cách oracle âm thầm đồng ý với một resolver sai: nếu nó trả `true` cho
   * một dạng nó không hiểu, differential test sẽ xanh cho đúng những trường hợp khó nhất.
   */
  it("dạng không phủ thì NÉM", () => {
    expect(() => oracleSatisfies("1.0.0", ">=1 <2")).toThrow("không phủ");
    expect(() => oracleSatisfies("1.0.0", "1 || 2")).toThrow("không phủ");
    expect(() => oracleSatisfies("1.0.0-rc1", "^1")).toThrow();
  });
});

describe("oracleTopoSort — thuật toán, trên đồ thị dựng TAY (D-11)", () => {
  const node = (
    toolId: string,
    provides: string[],
    requires: string[],
  ): OracleAdapter =>
    ({
      domainType: "d",
      toolId,
      capabilities: {
        provides: provides.map((id) => ({ id, version: "1.0.0" })),
        requires: requires.map((id) => ({ id })),
      },
    }) as unknown as OracleAdapter;

  it("chuỗi phụ thuộc thẳng ⇒ provider trước, consumer sau", () => {
    const a = node("a", ["metrics.query"], []);
    const b = node("b", [], ["metrics.query"]);
    const order = oracleTopoSort([b, a], { "metrics.query": "d:a" });
    expect(order).toEqual([["d:a"], ["d:b"]]);
  });

  it("hai adapter độc lập ⇒ CÙNG một bậc, deploy song song được", () => {
    const order = oracleTopoSort([node("a", [], []), node("b", [], [])], {});
    expect(order).toEqual([["d:a", "d:b"]]);
  });

  it("chu trình hai đỉnh ⇒ null", () => {
    const a = node("a", ["metrics.query"], ["logs.sink"]);
    const b = node("b", ["logs.sink"], ["metrics.query"]);
    expect(
      oracleTopoSort([a, b], {
        "metrics.query": "d:a",
        "logs.sink": "d:b",
      }),
    ).toBeNull();
  });

  it("chu trình ba đỉnh ⇒ null", () => {
    const a = node("a", ["metrics.query"], ["logs.sink"]);
    const b = node("b", ["logs.sink"], ["traces.sink"]);
    const c = node("c", ["traces.sink"], ["metrics.query"]);
    expect(
      oracleTopoSort([a, b, c], {
        "metrics.query": "d:a",
        "logs.sink": "d:b",
        "traces.sink": "d:c",
      }),
    ).toBeNull();
  });

  /**
   * Tự-vòng KHÔNG phải chu trình.
   *
   * Một adapter provide và tiêu thụ cùng một capability là hợp lệ: nó tự thoả, không chờ
   * ai. Coi đó là chu trình sẽ chặn một tổ hợp hợp lệ, và đó là lỗi khó chẩn đoán vì
   * thông điệp `CYCLIC_DEPENDENCY` không nói đỉnh nào.
   */
  it("tự-vòng ⇒ KHÔNG phải chu trình", () => {
    const a = node("a", ["metrics.query"], ["metrics.query"]);
    expect(oracleTopoSort([a], { "metrics.query": "d:a" })).toEqual([["d:a"]]);
  });

  /** D-10 — `chosen` thiếu khoá là hợp lệ, không được làm topo vỡ */
  it("chosen THIẾU KHOÁ ⇒ vẫn sắp được, không cạnh nào", () => {
    const a = node("a", ["metrics.query"], []);
    const b = node("b", [], ["metrics.query"]);
    expect(oracleTopoSort([a, b], {})).toEqual([["d:a", "d:b"]]);
  });

  it("keyOf là `<domainType>:<toolId>`", () => {
    expect(keyOf(node("prometheus-grafana", [], []))).toBe(
      "d:prometheus-grafana",
    );
  });
});
