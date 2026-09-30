import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isChartedMeasurement,
  MEASUREMENT_DATA_SCHEMAS,
  measurementEnvelopeSchema,
  measurementFileName,
} from "../src/measurements.js";

/**
 * [Plan #56] MỌI tệp thô của `docs/measurements/raw/` qua schema mà trang "Bằng chứng" dùng để đọc chúng. Harness
 * đổi hình kết quả mà quên schema thì đỏ ở đây — không phải một thẻ lỗi trên trang lúc bảo vệ.
 */

const RAW_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "measurements",
  "raw",
);

const files = readdirSync(RAW_DIR).filter((f) => f.endsWith(".json"));

describe("tệp kết quả đo (§14)", () => {
  it("thư mục có tệp — một phép kiểm duyệt 0 tệp thì xanh vĩnh viễn", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)("%s: tên đúng quy ước, vỏ và `data` parse được", (file) => {
    const name = measurementFileName(file);
    expect(name, "tên phải là <EXP>-<YYYYMMDD-HHmm>.json").not.toBeNull();
    const body: unknown = JSON.parse(readFileSync(join(RAW_DIR, file), "utf8"));
    const envelope = measurementEnvelopeSchema.parse(body);
    expect(envelope.experiment).toBe(name?.experiment);

    // Phép đo chưa có biểu đồ riêng (E5, E9 khi CI commit kết quả) chỉ cần vỏ đúng
    if (!isChartedMeasurement(envelope.experiment)) return;
    const parsed = MEASUREMENT_DATA_SCHEMAS[envelope.experiment].safeParse(
      envelope.data,
    );
    expect(
      parsed.success
        ? []
        : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ).toEqual([]);
  });

  it("mọi phép đo có schema đều có ít nhất một tệp thô", () => {
    const measured = new Set(
      files.map((f) => measurementFileName(f)?.experiment),
    );
    expect(
      Object.keys(MEASUREMENT_DATA_SCHEMAS).filter((e) => !measured.has(e)),
    ).toEqual([]);
  });
});

describe("measurementFileName", () => {
  it("tách mã và mốc; tên sai quy ước ⇒ null", () => {
    expect(measurementFileName("E3-20260922-1906.json")).toEqual({
      experiment: "E3",
      stamp: "20260922-1906",
    });
    expect(measurementFileName("portal-pagination-20260926-2345.json")).toEqual(
      { experiment: "portal-pagination", stamp: "20260926-2345" },
    );
    expect(measurementFileName("E3.json")).toBeNull();
    expect(measurementFileName("E3-2026-09-22.json")).toBeNull();
  });
});
