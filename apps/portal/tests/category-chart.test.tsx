import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CategoryChart,
  categoryCsv,
  logAxis,
} from "../src/components/CategoryChart";
import { toCsv } from "../src/lib/download";

/**
 * [Plan #56] Biểu đồ cột theo nhóm của trang Bằng chứng: thang log đặt vạch ở lũy thừa của 10, bảng số liệu thay
 * thế đọc được, CSV chứa số THÔ (không định dạng theo ngôn ngữ) để vẽ lại.
 */

const categories = [
  { key: "a", short: "1×1", label: "1 flag · 1 rule" },
  { key: "b", short: "100×50", label: "100 flag · 50 rule" },
];

describe("logAxis", () => {
  it("vạch ở lũy thừa của 10 bao trọn dữ liệu; ≤ 0 không có chỗ", () => {
    const axis = logAxis(0.9, 24.9);
    expect(axis.ticks).toEqual([0.1, 1, 10, 100]);
    expect(axis.at(0.1)).toBe(0);
    expect(axis.at(100)).toBe(1);
    expect(axis.at(0)).toBeNull();
  });

  it("dữ liệu trải nhiều bậc ⇒ tối đa năm vạch", () => {
    expect(logAxis(1, 1_000_000).ticks.length).toBeLessThanOrEqual(5);
  });
});

describe("CSV", () => {
  it("số thô, ô rỗng cho không dữ liệu, trích dẫn khi có dấu phẩy", () => {
    expect(
      categoryCsv(
        categories,
        [
          { key: "p50", label: "SDK p50", values: [9.3, null], tone: "accent" },
          { key: "p99", label: "p99, µs", values: [15.6, 24.9], tone: "v3" },
        ],
        "Ô lưới",
      ),
    ).toBe(
      'Ô lưới,SDK p50,"p99, µs"\n1 flag · 1 rule,9.3,15.6\n100 flag · 50 rule,,24.9\n',
    );
    expect(toCsv(["a"], [['nói "x"']])).toBe('a\n"nói ""x"""\n');
  });
});

describe("CategoryChart", () => {
  it("chú giải, ngưỡng, nhãn thang log, bảng thay thế và nút tải CSV", () => {
    render(
      <CategoryChart
        title="Độ trễ"
        level={3}
        scale="log"
        categories={categories}
        series={[
          { key: "s", label: "SDK p50", values: [9.3, 12.3], tone: "accent" },
        ]}
        format={(v) => `${String(v)} µs`}
        threshold={{ value: 1000, label: "1 ms" }}
        groupHeader="Ô lưới"
        csvFileName="E3.csv"
      />,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "Độ trễ" }),
    ).toBeInTheDocument();
    expect(screen.getByText("thang log")).toBeInTheDocument();
    expect(screen.getByText("1 ms")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Độ trễ" });
    expect(
      within(table).getByRole("rowheader", { name: "100 flag · 50 rule" }),
    ).toBeInTheDocument();
    expect(within(table).getByText("12.3 µs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tải CSV" })).toBeVisible();
  });

  it("không có dữ liệu ⇒ nói thẳng, không vẽ cột 0", () => {
    render(
      <CategoryChart
        title="Rỗng"
        level={3}
        categories={categories}
        series={[
          { key: "s", label: "x", values: [null, null], tone: "accent" },
        ]}
        format={String}
        groupHeader="Nhóm"
      />,
    );
    expect(screen.getByText("Chưa có dữ liệu")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tải CSV" })).toBeNull();
  });
});
