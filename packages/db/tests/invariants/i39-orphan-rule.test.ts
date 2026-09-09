import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inRollback, openClient } from "../helpers/db.js";

/**
 * I39 — ORPHAN_RULE được cưỡng chế ở tầng database, cả hai chiều.
 *
 * Chạy SQL thẳng chứ không qua Prisma, vì đó mới là điều đang được kiểm: §1.2
 * cho Service 3 quyền UPDATE trực tiếp cột `serve` trong nhánh DEPENDENCY_DOWN,
 * và đường ghi đó KHÔNG đi qua Zod. Test qua ORM chỉ chứng minh Zod hoạt động,
 * trong khi database mới là hàng rào duy nhất ở đường ghi kia.
 *
 * Nhóm (d) là nhóm đắt nhất. Một hàm trích variantId trả mảng rỗng cho hình
 * dạng nó không hiểu sẽ IM LẶNG cho qua: "không có variantId nào" và "tôi không
 * đọc nổi cái này" là hai chuyện khác hẳn nhau.
 */

const ORPHAN = "UDP01";
/** Chiều xóa dùng mã RIÊNG: request đúng, trạng thái xung đột, và RETRYABLE */
const IN_USE = "UDP02";

let client: Client;
let ids: {
  flagId: string;
  ownVariantId: string;
  foreignVariantId: string;
  ruleId: string;
  envConfigId: string;
};

beforeAll(async () => {
  client = await openClient();
  const res = await client.query<{
    flag_id: string;
    own_variant: string;
    foreign_variant: string;
    rule_id: string;
    env_config_id: string;
  }>(`
    WITH a AS (SELECT id FROM feature_flags WHERE key = 'dark-mode'),
         b AS (SELECT id FROM feature_flags WHERE key = 'checkout-algorithm')
    SELECT a.id AS flag_id,
           -- Phai la variant KHONG phai default cua flag hay cua env config nao:
           -- neu no la default thi FK Restrict chan truoc, va test se chung minh
           -- FK chu khong chung minh trigger. Hai lop nay xep chong, khong thay the nhau.
           (SELECT v.id FROM flag_variants v
             WHERE v.flag_id = a.id
               AND NOT EXISTS (SELECT 1 FROM feature_flags f WHERE f.default_variant_id = v.id)
               AND NOT EXISTS (SELECT 1 FROM flag_env_configs c WHERE c.default_variant_id = v.id)
             LIMIT 1) AS own_variant,
           (SELECT id FROM flag_variants WHERE flag_id = b.id LIMIT 1) AS foreign_variant,
           (SELECT r.id FROM flag_targeting_rules r
              JOIN flag_env_configs f ON f.id = r.flag_env_config_id
             WHERE f.flag_id = a.id LIMIT 1) AS rule_id,
           (SELECT id FROM flag_env_configs WHERE flag_id = a.id LIMIT 1) AS env_config_id
      FROM a, b`);

  const row = res.rows[0];
  // Guard mọi trường, không chỉ rule_id: thiếu bất kỳ cái nào cũng cho ra một
  // chuỗi lỗi khó hiểu ở giữa test thay vì một câu nói rõ phải làm gì.
  if (row === undefined || Object.values(row).some((v) => v === null)) {
    throw new Error(
      `Database chưa seed đủ — chạy pnpm db:seed trước (nhận: ${JSON.stringify(row)})`,
    );
  }
  ids = {
    flagId: row.flag_id,
    ownVariantId: row.own_variant,
    foreignVariantId: row.foreign_variant,
    ruleId: row.rule_id,
    envConfigId: row.env_config_id,
  };
});

afterAll(async () => {
  await client?.end();
});

/** Đặt `serve` của rule mẫu bằng biểu thức SQL, luôn rollback sau đó */
function setServe(serveSql: string, extra: unknown[] = []) {
  return inRollback(client, () =>
    client.query(`UPDATE flag_targeting_rules SET serve = ${serveSql} WHERE id = $1`, [
      ids.ruleId,
      ...extra,
    ]),
  );
}

describe("I39(a) — chặn lưu rule trỏ variant không hợp lệ", () => {
  it("variant không tồn tại", async () => {
    const r = await setServe(
      "jsonb_build_object('kind','variant','variantId',gen_random_uuid()::text)",
    );
    expect(r.error?.code).toBe(ORPHAN);
  });

  it("variant của flag KHÁC", async () => {
    const r = await setServe("jsonb_build_object('kind','variant','variantId',$2::text)", [
      ids.foreignVariantId,
    ]);
    expect(r.error?.code).toBe(ORPHAN);
  });

  it("variant hợp lệ của chính flag mình thì qua", async () => {
    const r = await setServe("jsonb_build_object('kind','variant','variantId',$2::text)", [
      ids.ownVariantId,
    ]);
    expect(r.error).toBeUndefined();
  });
});

describe("I39(b) — chặn xóa variant còn được tham chiếu (VARIANT_IN_USE)", () => {
  it("xóa variant đang nằm trong serve bị chặn lúc COMMIT", async () => {
    const r = await inRollback(client, async () => {
      await client.query(
        "UPDATE flag_targeting_rules SET serve = jsonb_build_object('kind','variant','variantId',$2::text) WHERE id = $1",
        [ids.ruleId, ids.ownVariantId],
      );
      await client.query("DELETE FROM flag_variants WHERE id = $1", [ids.ownVariantId]);
      // Constraint trigger hoãn tới COMMIT; ép chạy ngay để không phải commit thật.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    expect(r.error?.code).toBe(IN_USE);
  });
});

describe("I39(b2) — chặn xóa variant được tham chiếu qua distribution", () => {
  it("variant nằm trong weights cũng chặn được", async () => {
    // Nhánh `serve @> {'weights':[...]}` của trigger xóa. Khác hẳn nhánh
    // `kind='variant'`: cùng một hàm nhưng hai vị từ chứa khác nhau, nên chỉ
    // test một nhánh là để nhánh kia không có lưới.
    const r = await inRollback(client, async () => {
      await client.query(
        `UPDATE flag_targeting_rules SET serve = jsonb_build_object('kind','distribution','weights',
           jsonb_build_array(jsonb_build_object('variantId',$2::text,'weight',100000))) WHERE id = $1`,
        [ids.ruleId, ids.ownVariantId],
      );
      await client.query("DELETE FROM flag_variants WHERE id = $1", [ids.ownVariantId]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    expect(r.error?.code).toBe(IN_USE);
  });

  it("xóa variant đang là default bị FK chặn, không phải trigger", async () => {
    // Hai lớp xếp chồng chứ không thay thế nhau: FK lo `default_variant_id`,
    // trigger lo JSONB. Mã ở đây là 23503 (foreign_key_violation), KHÁC UDP01 —
    // và đó là bằng chứng FK Restrict thật sự đang làm việc.
    const def = await client.query<{ id: string }>(
      `SELECT default_variant_id AS id FROM feature_flags WHERE id = $1`, [ids.flagId],
    );
    const defaultVariantId = def.rows[0]?.id;
    expect(defaultVariantId, "seed phải đặt default_variant_id").toBeTruthy();

    const r = await inRollback(client, () =>
      client.query("DELETE FROM flag_variants WHERE id = $1", [defaultVariantId]),
    );
    expect(r.error?.code).toBe("23503");
  });
});

describe("I39(c) — default variant phải THUỘC flag đó", () => {
  // FK chỉ cưỡng chế *tồn tại*, không cưỡng chế *quyền sở hữu* — nửa này của
  // §6.7 không có ràng buộc khai báo nào giữ được, phải là trigger.
  it("flag trỏ default sang variant của flag khác", async () => {
    const r = await inRollback(client, () =>
      client.query("UPDATE feature_flags SET default_variant_id = $2 WHERE id = $1", [
        ids.flagId,
        ids.foreignVariantId,
      ]),
    );
    expect(r.error?.code).toBe(ORPHAN);
  });

  it("env config trỏ default sang variant của flag khác", async () => {
    const r = await inRollback(client, () =>
      client.query("UPDATE flag_env_configs SET default_variant_id = $2 WHERE id = $1", [
        ids.envConfigId,
        ids.foreignVariantId,
      ]),
    );
    expect(r.error?.code).toBe(ORPHAN);
  });
});

describe("I39(d) — serve sai hình dạng phải bị CHẶN, không im lặng cho qua", () => {
  const badShapes: ReadonlyArray<readonly [string, string]> = [
    ["kind sai chính tả", "jsonb_build_object('kind','varaint','variantId',gen_random_uuid()::text)"],
    ["JSON null", "'null'::jsonb"],
    ["mảng thay vì object", "'[]'::jsonb"],
    ["thiếu kind", "jsonb_build_object('variantId',gen_random_uuid()::text)"],
    ["variant thiếu variantId", "jsonb_build_object('kind','variant')"],
    ["variantId không phải uuid", "jsonb_build_object('kind','variant','variantId','khong-phai-uuid')"],
    ["distribution thiếu weights", "jsonb_build_object('kind','distribution')"],
    ["weights là mảng rỗng", "jsonb_build_object('kind','distribution','weights','[]'::jsonb)"],
    ["weights không phải mảng", "jsonb_build_object('kind','distribution','weights','{}'::jsonb)"],
  ];

  for (const [name, sql] of badShapes) {
    it(name, async () => {
      const r = await setServe(sql);
      expect(r.error?.code).toBe(ORPHAN);
    });
  }

  it("distribution toàn uuid hợp lệ nhưng có variant của flag khác", async () => {
    // Ca LÕI của nhóm distribution: không NULL, không sai định dạng, chỉ sai
    // quyền sở hữu. Test NULL bên dưới một mình KHÔNG ghim được ca này — nó
    // dừng ở nhánh "variantId rỗng" trước khi tới phép kiểm sở hữu, nên vẫn
    // xanh kể cả khi phép kiểm sở hữu bị gỡ.
    const r = await setServe(
      `jsonb_build_object('kind','distribution','weights',
         jsonb_build_array(jsonb_build_object('variantId',$2::text,'weight',50000),
                           jsonb_build_object('variantId',$3::text,'weight',50000)))`,
      [ids.ownVariantId, ids.foreignVariantId],
    );
    expect(r.error?.code).toBe(ORPHAN);
  });

  it("phần tử variantId NULL không được nuốt variantId lạ đứng sau nó", async () => {
    // Bẫy thật: NOT EXISTS(... = NULL) là TRUE nên hàng NULL được chọn trước,
    // LIMIT 1 dừng ngay ở đó, và uuid lạ phía sau không bao giờ được xét tới.
    const r = await setServe(
      `jsonb_build_object('kind','distribution','weights',
         jsonb_build_array(jsonb_build_object('variantId',null,'weight',0),
                           jsonb_build_object('variantId',$2::text,'weight',100000)))`,
      [ids.foreignVariantId],
    );
    expect(r.error?.code).toBe(ORPHAN);
  });
});

describe("I39(e) — không được chặn nhầm thao tác hợp lệ", () => {
  it("xóa cả FeatureFlag vẫn chạy trót (variant và rule cùng cascade)", async () => {
    const r = await inRollback(client, async () => {
      await client.query("DELETE FROM feature_flags WHERE id = $1", [ids.flagId]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    });
    expect(r.error).toBeUndefined();
  });

  it("distribution hợp lệ thì qua", async () => {
    const r = await setServe(
      `jsonb_build_object('kind','distribution','weights',
         jsonb_build_array(jsonb_build_object('variantId',$2::text,'weight',100000)))`,
      [ids.ownVariantId],
    );
    expect(r.error).toBeUndefined();
  });
});
