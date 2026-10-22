import type { DomainCatalogEntryWire } from "@udp/shared-types/wire";
import { describe, expect, it } from "vitest";
import { CONFIG_LABELS } from "../src/features/domain/config-labels";
import { golden } from "./msw";

/**
 * Mọi khoá cấu hình của MỌI tool trong catalog thật (mẫu golden của Service 1) có nhãn tiếng Việt
 * (Plan #53 QĐ-9). Adapter mới thêm một khoá mà quên nhãn thì đỏ ở đây — không phải một khoá tiếng
 * Anh lặng lẽ lọt lên form.
 */
describe("nhãn cấu hình domain", () => {
  const catalog = golden<{ domains: DomainCatalogEntryWire[] }>(
    "GET /domains/catalog",
  );
  const keys = new Set(
    catalog.domains.flatMap((d) =>
      d.tools.flatMap((t) =>
        t.config.kind === "object" ? t.config.fields.map((f) => f.key) : [],
      ),
    ),
  );

  it("quét được catalog thật — không phải 0 khoá", () => {
    expect(keys.size).toBeGreaterThan(100);
  });

  it("mọi khoá có nhãn", () => {
    expect([...keys].filter((k) => CONFIG_LABELS[k] === undefined)).toEqual([]);
  });

  it("bảng không giữ nhãn của khoá không còn tồn tại", () => {
    expect(Object.keys(CONFIG_LABELS).filter((k) => !keys.has(k))).toEqual([]);
  });
});
