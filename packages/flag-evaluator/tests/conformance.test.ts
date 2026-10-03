import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildConformanceVectors,
  VECTORS_PATH,
} from "../scripts/conformance.js";

/**
 * [Plan #47] `conformance/vectors.json` là hợp đồng giữa các bản hiện thực của lõi (bản Python đọc
 * nó). Tệp phải là đầu ra của CHÍNH lõi hiện tại: sửa lõi mà quên sinh lại là đỏ ở đây, trước khi
 * bản Python kịp so với một vector cũ.
 */
describe("vector tương đương (§6.8 bản Python)", () => {
  const vectors = buildConformanceVectors();

  it("tệp vector khớp đúng lõi hiện tại — sinh lại: pnpm --filter @udp/flag-evaluator conformance", () => {
    expect(JSON.parse(readFileSync(VECTORS_PATH, "utf8"))).toEqual(
      JSON.parse(JSON.stringify(vectors)),
    );
  });

  it("phủ đủ các kết cục: năm reason, ba mã lỗi, bia mộ, và cả ba kết cục áp delta", () => {
    const reasons = new Set(vectors.evaluate.map((c) => c.evaluation.reason));
    expect([...reasons].sort()).toEqual(
      ["DEFAULT", "DISABLED", "ERROR", "SPLIT", "TARGETING_MATCH"].sort(),
    );
    const codes = new Set(
      vectors.evaluate.flatMap((c) =>
        c.evaluation.errorCode === undefined ? [] : [c.evaluation.errorCode],
      ),
    );
    expect([...codes].sort()).toEqual(
      ["FLAG_NOT_FOUND", "GENERAL", "TYPE_MISMATCH"].sort(),
    );
    expect(vectors.evaluate.some((c) => c.evaluation.archived === true)).toBe(
      true,
    );
    expect(new Set(vectors.delta.map((d) => d.outcome.kind))).toEqual(
      new Set(["applied", "ignored", "resync"]),
    );
  });
});
