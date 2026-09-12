import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbAvailabilityError, dbConstraintError } from "../src/errors.js";
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
  /**
   * Tat luat o DUNG mot dong, va day la ly do.
   *
   * TypeScript coi bien nay la da gan chac chan vi `beforeAll` co gan no.
   * Nhung neu chinh `beforeAll` nem — khong noi duoc database, sai mat khau,
   * seed thieu — thi `afterAll` VAN chay voi bien chua gan. Bo `?.` di thi
   * loi that su bi che boi mot `TypeError` trong buoc don dep, va nguoi doc
   * log thay sai cho hoan toan.
   *
   * Doi kieu thanh `| undefined` la cach dung ve mat kieu nhung bat 64 cho
   * dung khac trong bo test nay phai thu hep — cai gia lon hon nhieu so voi
   * mot dong tat luat co giai thich.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  await prisma?.$disconnect();
});

describe("dbErrorCode — SQLSTATE của trigger tới được tầng ứng dụng", () => {
  it("vi phạm ORPHAN_RULE qua Prisma trả đúng mã nghiệp vụ", async () => {
    const rule = await prisma.flagTargetingRule.findFirstOrThrow();

    const err = await prisma.flagTargetingRule
      .update({
        where: { id: rule.id },
        // uuid hợp lệ về định dạng nhưng không thuộc flag nào
        data: {
          serve: {
            kind: "variant",
            variantId: "00000000-0000-4000-8000-0000000000ff",
          },
        },
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
    expect(
      mapped?.detail.startsWith("ORPHAN_RULE:"),
      "tiền tố mã phải bị cắt",
    ).toBe(false);
  });

  it("lỗi không phải của UDP trả undefined chứ không đoán bừa", () => {
    expect(dbConstraintError(new Error("mạng hỏng"))).toBeUndefined();
    expect(dbConstraintError({ code: "23505" })).toBeUndefined();
    expect(dbConstraintError(undefined)).toBeUndefined();
    expect(dbConstraintError(null)).toBeUndefined();
  });

  it("nhận cả SQLSTATE phẳng từ pg.Client, không chỉ dạng lồng của Prisma", () => {
    expect(
      dbConstraintError({ code: "UDP01", message: "ORPHAN_RULE: x" }),
    ).toEqual({
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
    const flag = await prisma.featureFlag.findFirstOrThrow({
      where: { key: "dark-mode" },
    });
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
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    const mapped = dbConstraintError(err);
    expect(mapped?.code).toBe("VARIANT_IN_USE");
    expect(mapped?.detail).toContain(variant.id);
  });

  it("UDP02 là mã RIÊNG, không gộp vào ORPHAN_RULE", () => {
    // Hai tình huống khác nhau ở `retryable`: gửi lại một rule sai vẫn sai, còn
    // xoá variant thì gỡ rule đang trỏ tới nó rồi thử lại là được.
    const mapped = dbConstraintError({
      code: "UDP02",
      message: "VARIANT_IN_USE: y",
    });
    expect(mapped).toEqual({ code: "VARIANT_IN_USE", detail: "y" });
  });
});

describe("dbAvailabilityError — cạn pool là 503, bug của transaction vẫn là 500", () => {
  it("cạn pool THẬT: $transaction hết maxWait ra PROVIDER_UNAVAILABLE", async () => {
    /**
     * Cạn pool thật chứ không dựng một object giả: nhánh này khớp theo THÔNG ĐIỆP của
     * Prisma, nên chỉ một lần gọi thật mới nói được thông điệp đó còn đúng chữ hay
     * không. Nâng phiên bản Prisma mà câu chữ đổi thì test này đỏ — thay vì hệ
     * thống âm thầm trượt 503 về 500.
     */
    const tiny = new PrismaClient({
      adapter: createPgAdapter({
        connectionString: connectionString(),
        max: 1,
      }),
    });

    try {
      /**
       * Giữ khe DUY NHẤT của pool trong 2 giây.
       *
       * `$executeRaw` chứ không `$queryRaw`: `pg_sleep` trả về một cột kiểu `void`,
       * và `$queryRaw` cố giải tuần tự cột đó rồi ném — khiến CHÍNH transaction giữ
       * khe hỏng, và test đỏ vì một lý do không liên quan gì tới điều nó kiểm.
       * `$executeRaw` chỉ đếm số hàng, không đọc cột nào.
       */
      const holder = tiny.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_sleep(2)`;
        },
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 400));

      const err = await tiny
        .$transaction(() => Promise.resolve(), { maxWait: 200 })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      await holder;

      expect(
        err,
        "pool 1 khe đang bị giữ mà transaction thứ hai vẫn mở được",
      ).toBeDefined();
      expect(dbAvailabilityError(err)?.code).toBe("PROVIDER_UNAVAILABLE");
      // Không được lọt vào nhánh ràng buộc — hai nhánh log ở hai mức khác nhau
      expect(dbConstraintError(err)).toBeUndefined();
    } finally {
      await tiny.$disconnect();
    }
  });

  it("các lớp con KHÁC của P2028 không bị coi là quá tải", () => {
    /**
     * Nguyên văn hai trong sáu lớp con còn lại, lấy từ runtime 7.10. Cả hai là bug của
     * người viết code — dùng transaction đã đóng hoặc đã hết hạn. Báo 503 retryable
     * cho chúng là bảo người gọi thử lại một bug mãi mãi.
     */
    const closed = {
      code: "P2028",
      message:
        "Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.",
    };
    const expired = {
      code: "P2028",
      message:
        "Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 6012 ms passed since the start of the transaction.",
    };

    expect(dbAvailabilityError(closed)).toBeUndefined();
    expect(dbAvailabilityError(expired)).toBeUndefined();
  });
});

describe("dbAvailabilityError — cạn pool NGOÀI transaction cũng là 503 [v4.2]", () => {
  it("một truy vấn trần chờ khe quá acquireTimeoutMs ⇒ PROVIDER_UNAVAILABLE", async () => {
    /**
     * Từ [v4.2] đường nạp snapshot không còn transaction, nên `maxWait` không
     * bảo vệ nó nữa; thay vào đó là `connectionTimeoutMillis` ở tầng adapter cho
     * MỌI truy vấn. Test này canh hai thứ: hạn chờ đó có hiệu lực (không xếp
     * hàng vô hạn), và thông điệp của `pg-pool` còn được nhận diện đúng chữ.
     */
    /**
     * `connectionTimeoutMillis` của pg-pool tính cả thời gian MỞ kết nối mới
     * (TLS tới Supabase ~0,5s từ máy dev), không chỉ thời gian chờ khe — đã đo:
     * 300ms giết luôn transaction giữ chỗ trước khi nó kịp nối. 2 giây đủ cho
     * handshake và vẫn ngắn hơn 4 giây pg_sleep, nên truy vấn thứ hai chắc chắn
     * hết hạn TRONG lúc khe còn bị giữ.
     */
    const tiny = new PrismaClient({
      adapter: createPgAdapter({
        connectionString: connectionString(),
        max: 1,
        acquireTimeoutMs: 2_000,
      }),
    });

    const holder = tiny
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_sleep(4)`;
        },
        { maxWait: 5_000, timeout: 10_000 },
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    try {
      await new Promise((r) => setTimeout(r, 1_200));

      const started = Date.now();
      const err = await tiny.$queryRaw`SELECT 1`.then(
        () => undefined,
        (e: unknown) => e,
      );
      const waited = Date.now() - started;

      expect(
        err,
        "pool 1 khe đang bị giữ mà truy vấn trần vẫn chạy được",
      ).toBeDefined();
      expect(waited).toBeGreaterThanOrEqual(1_500);
      expect(waited).toBeLessThan(4_000);
      expect(dbAvailabilityError(err)?.code).toBe("PROVIDER_UNAVAILABLE");
      expect(
        await holder,
        "transaction giữ chỗ phải tự kết thúc êm",
      ).toBeUndefined();
    } finally {
      await holder;
      await tiny.$disconnect();
    }
  });
});
