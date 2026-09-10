import { describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "@udp/shared-types/problem";
import { OptimisticLockError, PreconditionFailedError } from "../src/errors.js";

/**
 * Lớp lỗi và catalog là HAI nơi nói về cùng một con số.
 *
 * `error-handler` lấy status từ lớp, còn client tra `retryable` và `fixableBy`
 * từ catalog theo `code`. Hai nơi lệch nhau thì HTTP trả một status trong khi
 * catalog nói một status khác cho cùng một lỗi — và không gì báo, vì cả hai đều
 * "chạy đúng" theo từng phía.
 */
describe("PreconditionFailedError — 412 của fencing (I23)", () => {
  it("status của lớp khớp đúng con số catalog khai cho PRECONDITION_FAILED", () => {
    const err = new PreconditionFailedError(
      "fencing token đã cũ",
      undefined,
      "PRECONDITION_FAILED",
    );

    expect(err.statusCode).toBe(ERROR_CATALOG.PRECONDITION_FAILED.httpStatus);
    expect(err.kind).toBe("PRECONDITION_FAILED");
    expect(err.problemCode).toBe("PRECONDITION_FAILED");
  });

  it("catalog khai nó KHÔNG retryable — lớp này dựa vào đúng tính chất đó", () => {
    /**
     * Worker tỉnh muộn mà thử lại là ghi đè đúng thứ fencing sinh ra để bảo vệ.
     * §7.1 xử lý 412 bằng một dòng `return`, không backoff, không retry. Nếu ai đó
     * đổi catalog thành `retryable: true`, lớp lỗi vẫn biên dịch — test này là
     * nơi duy nhất nói ra rằng hai thứ phải đi cùng nhau.
     */
    expect(ERROR_CATALOG.PRECONDITION_FAILED.retryable).toBe(false);
    expect(ERROR_CATALOG.PRECONDITION_FAILED.fixableBy).toBe("nobody");
  });
});

describe("OptimisticLockError — 409 kèm bản mới nhất (§8.4)", () => {
  it("là 409 OPTIMISTIC_LOCK đúng như catalog, và mang theo bản mới nhất", () => {
    const current = { id: "f1", description: "người kia đã lưu" };
    const err = new OptimisticLockError("đã bị sửa", current);

    expect(err.statusCode).toBe(ERROR_CATALOG.OPTIMISTIC_LOCK.httpStatus);
    expect(err.problemCode).toBe("OPTIMISTIC_LOCK");
    expect(err.current).toBe(current);
  });
});
