import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbConstraintError } from "../src/errors.js";
import { createPgAdapter } from "../src/adapter.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { connectionString } from "./helpers/db.js";

/**
 * Hợp đồng giữa trigger của database và danh mục lỗi §9.
 *
 * Test này tồn tại vì một giả định load-bearing: rằng SQLSTATE tự định nghĩa
 * ĐI QUA ĐƯỢC Prisma. Nếu Prisma nuốt mã, toàn bộ lựa chọn dùng `UDP01` làm hợp
 * đồng máy đọc là vô nghĩa và phải thiết kế lại. Đường bóc mã là một chi tiết
 * nội bộ của Prisma (`meta.driverAdapterError.cause.code`), nên nó có thể vỡ ở
 * một lần nâng phiên bản mà không có gì báo — trừ test này.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: createPgAdapter({ connectionString: connectionString(), max: 2 }),
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("dbErrorCode — SQLSTATE của trigger tới được tầng ứng dụng", () => {
  it("vi phạm ORPHAN_RULE qua Prisma trả đúng mã nghiệp vụ", async () => {
    const rule = await prisma.flagTargetingRule.findFirstOrThrow();

    const err = await prisma.flagTargetingRule
      .update({
        where: { id: rule.id },
        // uuid hợp lệ về định dạng nhưng không thuộc flag nào
        data: { serve: { kind: "variant", variantId: "00000000-0000-4000-8000-0000000000ff" } },
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err, "update lẽ ra phải bị trigger chặn").toBeDefined();

    const mapped = dbConstraintError(err);
    expect(mapped?.code).toBe("ORPHAN_RULE");

    // `detail` phải là chuỗi RAISE của ta, KHÔNG phải message của Prisma. Đây là
    // điều kiện để trả nó ra ở production: nó không mang đường dẫn file, tên
    // bảng nội bộ hay câu SQL. Và nó phải nêu ĐÍCH DANH variant sai, vì mã này
    // khai `fixableBy: "user"` — nói "trỏ sai" mà không nói sai cái nào là vô dụng.
    expect(mapped?.detail).toContain("00000000-0000-4000-8000-0000000000ff");
    expect(mapped?.detail).not.toContain("prisma.");
    expect(mapped?.detail).not.toContain("Invalid `");
    expect(mapped?.detail.startsWith("ORPHAN_RULE:"), "tiền tố mã phải bị cắt").toBe(false);
  });

  it("lỗi không phải của UDP trả undefined chứ không đoán bừa", () => {
    expect(dbConstraintError(new Error("mạng hỏng"))).toBeUndefined();
    expect(dbConstraintError({ code: "23505" })).toBeUndefined();
    expect(dbConstraintError(undefined)).toBeUndefined();
    expect(dbConstraintError(null)).toBeUndefined();
  });

  it("nhận cả SQLSTATE phẳng từ pg.Client, không chỉ dạng lồng của Prisma", () => {
    expect(dbConstraintError({ code: "UDP01", message: "ORPHAN_RULE: x" })).toEqual({
      code: "ORPHAN_RULE",
      detail: "x",
    });
  });

  it("lỗi phát sinh lúc COMMIT của $transaction vẫn map được", async () => {
    // Hình dạng THỨ BA của lỗi Prisma, và là hình dạng duy nhất mà chiều xóa của
    // §6.7 đi qua: constraint trigger hoãn tới COMMIT nên lỗi không gắn vào câu
    // lệnh nào — Prisma ném DriverAdapterError với `code` và `meta` đều undefined,
    // SQLSTATE nằm ở `cause.code`. Bản mapper đầu tiên không biết dạng này, nên
    // mọi VARIANT_IN_USE rơi xuống nhánh 500. Test này ghim nó lại.
    const flag = await prisma.featureFlag.findFirstOrThrow({ where: { key: "dark-mode" } });
    const rule = await prisma.flagTargetingRule.findFirstOrThrow({
      where: { flagEnvConfig: { flagId: flag.id } },
    });
    const variant = await prisma.flagVariant.findFirstOrThrow({
      where: { flagId: flag.id, key: "on" },
    });

    const err = await prisma
      .$transaction(async (tx) => {
        await tx.flagTargetingRule.update({
          where: { id: rule.id },
          data: { serve: { kind: "variant", variantId: variant.id } },
        });
        await tx.flagVariant.delete({ where: { id: variant.id } });
      })
      .then(() => undefined, (e: unknown) => e);

    const mapped = dbConstraintError(err);
    expect(mapped?.code).toBe("VARIANT_IN_USE");
    expect(mapped?.detail).toContain(variant.id);
  });

  it("UDP02 là mã RIÊNG, không gộp vào ORPHAN_RULE", () => {
    // Hai tình huống khác nhau ở `retryable`: gửi lại một rule sai vẫn sai, còn
    // xoá variant thì gỡ rule đang trỏ tới nó rồi thử lại là được.
    const mapped = dbConstraintError({ code: "UDP02", message: "VARIANT_IN_USE: y" });
    expect(mapped).toEqual({ code: "VARIANT_IN_USE", detail: "y" });
  });
});
