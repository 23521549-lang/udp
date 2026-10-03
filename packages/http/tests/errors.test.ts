import { describe, expect, it } from "vitest";
import { ERROR_CATALOG } from "@udp/shared-types/problem";
import { auditIp } from "../src/audit.js";
import {
  ConfirmationRequiredError,
  OptimisticLockError,
  PreconditionFailedError,
  relayedProblemOf,
  ROUTE_NOT_FOUND_SLUG,
  ServiceUnavailableError,
} from "../src/errors.js";

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

describe("ServiceUnavailableError — 503 của phụ thuộc chết [v4.4]", () => {
  it("mặc định PROVIDER_UNAVAILABLE, status khớp catalog và catalog khai retryable", () => {
    const err = new ServiceUnavailableError("Service 2 không phản hồi");
    expect(err.problemCode).toBe("PROVIDER_UNAVAILABLE");
    expect(err.statusCode).toBe(ERROR_CATALOG.PROVIDER_UNAVAILABLE.httpStatus);
    expect(ERROR_CATALOG.PROVIDER_UNAVAILABLE.retryable).toBe(true);
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

describe("ConfirmationRequiredError — 428 của xác nhận hai bước (§8.4) [v4.5]", () => {
  it("status khớp catalog; người dùng sửa được bằng cách xác nhận, thử lại y nguyên thì không", () => {
    const err = new ConfirmationRequiredError("gõ lại key");
    expect(err.statusCode).toBe(ERROR_CATALOG.CONFIRMATION_REQUIRED.httpStatus);
    expect(err.problemCode).toBe("CONFIRMATION_REQUIRED");
    expect(ERROR_CATALOG.CONFIRMATION_REQUIRED.retryable).toBe(false);
    expect(ERROR_CATALOG.CONFIRMATION_REQUIRED.fixableBy).toBe("user");
  });
});

describe("relayedProblemOf — lỗi nào của service phía sau được tới Portal [v4.5]", () => {
  it("chỉ 404/409/422; 400/401/403/5xx ⇒ undefined (bên gọi coi là lỗi hợp đồng)", () => {
    for (const status of [404, 409, 422]) {
      expect(relayedProblemOf(status, { title: "x" })?.statusCode).toBe(status);
    }
    for (const status of [400, 401, 403, 428, 500, 503]) {
      expect(relayedProblemOf(status, { title: "x" })).toBeUndefined();
    }
  });

  it("giữ mã có trong catalog, detail, errors, current, resourceId", () => {
    const err = relayedProblemOf(409, {
      title: "Conflict",
      code: "ROLLOUT_IN_PROGRESS",
      detail: "đang có rollout",
      current: { updatedAt: "2026-09-22T00:00:00.000Z" },
      resourceId: "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b",
      errors: [{ field: "key", message: "trùng" }],
    });
    expect(err?.problemCode).toBe("ROLLOUT_IN_PROGRESS");
    expect(err?.resourceId).toBe("0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b");
    expect(err?.problem).toMatchObject({
      detail: "đang có rollout",
      current: { updatedAt: "2026-09-22T00:00:00.000Z" },
      errors: [{ field: "key", message: "trùng" }],
    });
  });

  it("404 'không có route' của phía sau ⇒ undefined — lệch phiên bản giữa hai service, không phải 'không tìm thấy'", () => {
    expect(
      relayedProblemOf(404, {
        type: `https://udp.dev/problems/${ROUTE_NOT_FOUND_SLUG}`,
        title: "Route not found",
        detail: "Không có route PATCH /internal/x",
      }),
    ).toBeUndefined();
  });

  it("errors[] chỉ giữ phần tử đúng hình { field, message }", () => {
    const err = relayedProblemOf(422, {
      title: "x",
      errors: [{ field: "a", message: "b" }, "rác", { field: 1 }],
    });
    expect(err?.problem.errors).toEqual([{ field: "a", message: "b" }]);
  });

  it("mã lạ (không có trong catalog) và body hỏng không lọt qua", () => {
    expect(
      relayedProblemOf(409, { title: "x", code: "NOT_A_CODE" })?.problemCode,
    ).toBeUndefined();
    expect(
      relayedProblemOf(409, { title: "x", code: "toString" })?.problemCode,
    ).toBeUndefined();
    expect(relayedProblemOf(404, "không phải JSON")?.problem.title).toBe(
      "Error",
    );
  });
});

describe("auditIp — chỉ thứ cột INET nhận được (audit nằm TRONG transaction nghiệp vụ)", () => {
  it("IPv4, IPv6 giữ nguyên; chuỗi lạ và IPv6 kèm zone ⇒ bỏ", () => {
    expect(auditIp("203.0.113.7")).toBe("203.0.113.7");
    expect(auditIp("2001:db8::1")).toBe("2001:db8::1");
    for (const bad of ["cafe", "1.2.3", "unknown", "fe80::1%eth0", undefined]) {
      expect(auditIp(bad)).toBeUndefined();
    }
  });
});
