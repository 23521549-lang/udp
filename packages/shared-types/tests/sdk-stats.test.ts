import { SDK_STATS } from "@udp/config/constants";
import { describe, expect, it } from "vitest";
import type { Evaluation } from "../src/evaluation.js";
import {
  sdkStatsReportSchema,
  STATS_VARIANT,
  statsVariantOf,
} from "../src/sdk-stats.js";

describe("statsVariantOf — một nhãn cho provider và OFREP (INV-23.9)", () => {
  it.each<[string, Evaluation, string | undefined]>([
    [
      "TARGETING_MATCH ⇒ variant",
      { reason: "TARGETING_MATCH", value: true, variant: "on" },
      "on",
    ],
    ["SPLIT ⇒ variant", { reason: "SPLIT", value: "b", variant: "b" }, "b"],
    [
      "DEFAULT ⇒ variant",
      { reason: "DEFAULT", value: false, variant: "off" },
      "off",
    ],
    ["DISABLED ⇒ __disabled__", { reason: "DISABLED" }, STATS_VARIANT.disabled],
    [
      "bia mộ ARCHIVED ⇒ __disabled__",
      { reason: "DISABLED", archived: true },
      STATS_VARIANT.disabled,
    ],
    [
      "TYPE_MISMATCH ⇒ __error__",
      { reason: "ERROR", errorCode: "TYPE_MISMATCH" },
      STATS_VARIANT.error,
    ],
    [
      "GENERAL ⇒ __error__",
      { reason: "ERROR", errorCode: "GENERAL" },
      STATS_VARIANT.error,
    ],
    [
      "FLAG_NOT_FOUND ⇒ không đếm",
      { reason: "ERROR", errorCode: "FLAG_NOT_FOUND" },
      undefined,
    ],
    [
      "PROVIDER_NOT_READY ⇒ không đếm",
      { reason: "ERROR", errorCode: "PROVIDER_NOT_READY" },
      undefined,
    ],
  ])("%s", (_label, evaluation, expected) => {
    expect(statsVariantOf(evaluation)).toBe(expected);
  });
});

describe("sdkStatsReportSchema", () => {
  const entry = { flagKey: "checkout-v2", variant: "on", count: 3 };
  const parse = (body: unknown) => sdkStatsReportSchema.safeParse(body);

  it("báo cáo tối thiểu hợp lệ", () => {
    expect(parse({ counts: [entry] }).success).toBe(true);
  });

  it("trường lạ ở cả ba cấp bị BỎ, không bị từ chối (tương thích tiến)", () => {
    const result = parse({
      counts: [{ ...entry, window: "1m" }],
      sdk: { name: "udp-node", version: "1.0.0", runtime: "node22" },
      reportedAt: "2026-09-22T00:00:00Z",
    });
    expect(result.success && result.data).toEqual({
      counts: [entry],
      sdk: { name: "udp-node", version: "1.0.0" },
    });
  });

  it("count biên: 1 và maxCountPerEntry nhận; 0, âm, lẻ, vượt trần bị từ chối", () => {
    const withCount = (count: number) =>
      parse({ counts: [{ ...entry, count }] }).success;
    expect(withCount(1)).toBe(true);
    expect(withCount(SDK_STATS.report.maxCountPerEntry)).toBe(true);
    expect(withCount(0)).toBe(false);
    expect(withCount(-1)).toBe(false);
    expect(withCount(1.5)).toBe(false);
    expect(withCount(SDK_STATS.report.maxCountPerEntry + 1)).toBe(false);
  });

  it("số mục: 0 và quá maxEntriesPerReport bị từ chối", () => {
    const withEntries = (n: number) =>
      parse({ counts: Array.from({ length: n }, () => entry) }).success;
    expect(withEntries(0)).toBe(false);
    expect(withEntries(SDK_STATS.report.maxEntriesPerReport)).toBe(true);
    expect(withEntries(SDK_STATS.report.maxEntriesPerReport + 1)).toBe(false);
  });

  it("giá trị của trường đã biết vẫn kiểm chặt", () => {
    expect(
      parse({ counts: [{ ...entry, flagKey: "Checkout V2" }] }).success,
    ).toBe(false);
    expect(parse({ counts: [{ ...entry, variant: "" }] }).success).toBe(false);
    expect(
      parse({ counts: [{ ...entry, variant: "v".repeat(101) }] }).success,
    ).toBe(false);
    expect(
      parse({
        counts: [entry],
        sdk: { name: "x".repeat(SDK_STATS.report.sdkLabelMaxLength + 1) },
      }).success,
    ).toBe(false);
  });
});
