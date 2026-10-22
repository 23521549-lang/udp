import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_FEED, CICD_WEBHOOK } from "@udp/config/constants";
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

const definerOf = (fn: string) =>
  new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${fn}\\b`);

/** Thân của migration MỚI NHẤT định nghĩa hàm — lần sửa sau là một CREATE OR REPLACE ở migration khác */
function latestDefinition(fn: string): string | undefined {
  const defines = definerOf(fn);
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) =>
      readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"),
    )
    .filter((sql) => defines.test(sql))
    .at(-1);
}

function hardcodedDays(fn: string): number {
  const latest = latestDefinition(fn);
  expect(latest, `không migration nào định nghĩa ${fn}`).toBeDefined();
  const days = /interval\s+'(\d+)\s+days'/.exec(latest ?? "")?.[1];
  expect(
    days,
    `${fn} không nêu retention dạng interval 'N days'`,
  ).toBeDefined();
  return Number(days);
}

describe("retention của ConfigChangeLog", () => {
  it("số ngày viết cứng trong hàm prune bằng CHANGE_FEED.retentionDays", () => {
    expect(hardcodedDays("udp_prune_config_change_log")).toBe(
      CHANGE_FEED.retentionDays,
    );
  });
});

/**
 * [Plan #61 61d-2a] Cùng hình dạng hai-nơi-một-sự-thật, cho bảng chống replay của Trusted Deploy.
 *
 * Con số này không phải chuyện gọn gàng: hàng `webhook_token_uses` là thứ chặn một token đã dùng được
 * dùng lại, nên dọn SỚM hơn `exp` của token là mở lại cửa sổ replay. Retention viết cứng trong thân hàm
 * để `udp_s1` không truyền được "0 ngày"; `CICD_WEBHOOK.tokenUseRetentionDays` là con số mà mã và tài
 * liệu nói tới. Đổi một bên mà quên bên kia thì hàm lặng lẽ dọn theo con số khác với con số mọi người tin.
 */
describe("retention của WebhookTokenUse", () => {
  it("số ngày viết cứng trong hàm prune bằng CICD_WEBHOOK.tokenUseRetentionDays", () => {
    expect(hardcodedDays("udp_prune_webhook_token_uses")).toBe(
      CICD_WEBHOOK.tokenUseRetentionDays,
    );
  });
});
