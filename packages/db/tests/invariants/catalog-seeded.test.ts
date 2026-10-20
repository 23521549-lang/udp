import { DOMAIN_CATALOG_SEED } from "@udp/config/domains";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openClient } from "../helpers/db.js";

/**
 * [Plan #64 64e] Seed để lại một catalog domain đầy đủ.
 *
 * `domain_catalog.domain_type` là khoá ngoại của `domain_configs`, nên một database vừa
 * seed mà thiếu catalog thì mọi lần bật domain đều vỡ FK. Đó là lỗi của lượt CI ở
 * `340b316`: phần nạp catalog bị bỏ khỏi seed, còn `scripts/sync-catalog.ts` chỉ chạy
 * trong job migrate của cụm - `test:scratch` và `verify-chain` thì không, và khoảng 40
 * test tích hợp chết ở `domain_configs_domain_type_fkey`.
 *
 * Cổng này chỉ ĐỎ được trên database mới dựng (`verify-chain`, `test:scratch`): database
 * dev còn catalog từ lần seed cũ. Không khẳng định "tập hàng đang dùng được bằng bản
 * khai" - database dev có thể còn hàng tạm của test core-backend.
 */

let client: Client;

beforeAll(async () => {
  client = await openClient();
});

afterAll(async () => {
  await client.end();
});

describe("catalog domain sau seed (Plan #64 64e)", () => {
  it("mỗi domain của bản khai có đúng một hàng, cùng thuộc tính, đang dùng được", async () => {
    const { rows } = await client.query<{
      domain_type: string;
      tier: string;
      display_name: string;
      default_order: number;
      is_available: boolean;
    }>(
      "SELECT domain_type, tier, display_name, default_order, is_available FROM domain_catalog",
    );
    const byType = new Map(rows.map((r) => [r.domain_type, r]));

    for (const entry of DOMAIN_CATALOG_SEED) {
      expect(byType.get(entry.domainType), entry.domainType).toEqual({
        domain_type: entry.domainType,
        tier: entry.tier,
        display_name: entry.displayName,
        default_order: entry.defaultOrder,
        is_available: true,
      });
    }
  });
});
