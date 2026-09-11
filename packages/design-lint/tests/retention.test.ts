import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_FEED } from "@udp/config/constants";
import { describe, expect, it } from "vitest";

/**
 * Retention của `ConfigChangeLog` sống ở HAI nơi — có chủ đích, nên phải có chốt.
 *
 * Hàm `udp_prune_config_change_log` viết cứng số ngày trong thân hàm để bên gọi
 * (`udp_s2`) không thể truyền "0 ngày" mà xoá sạch sổ (§2.2). Còn
 * `CHANGE_FEED.retentionDays` là con số mà code và tài liệu nói tới — chú thích,
 * §16, phép tính biên trong test. Hai nơi, một sự thật: đổi một bên mà quên bên
 * kia thì hàm lặng lẽ dọn theo con số khác với con số mọi người tin.
 *
 * Đọc migration MỚI NHẤT định nghĩa hàm, vì lần sửa sau sẽ là một
 * `CREATE OR REPLACE FUNCTION` ở migration khác chứ không sửa migration cũ.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "../../db/prisma/migrations");
const DEFINES =
  /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+udp_prune_config_change_log\b/;

describe("retention của ConfigChangeLog", () => {
  it("số ngày viết cứng trong hàm prune bằng CHANGE_FEED.retentionDays", () => {
    const defining = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .map((name) =>
        readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"),
      )
      .filter((sql) => DEFINES.test(sql));

    const latest = defining.at(-1);
    expect(latest, "không migration nào định nghĩa hàm prune").toBeDefined();

    const days = /interval\s+'(\d+)\s+days'/.exec(latest ?? "")?.[1];
    expect(
      days,
      "hàm prune không nêu retention dạng interval 'N days'",
    ).toBeDefined();
    expect(Number(days)).toBe(CHANGE_FEED.retentionDays);
  });
});
