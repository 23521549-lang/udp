import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  api,
  ApiError,
  createRefresher,
  refreshSession,
  setSessionExpiredHandler,
} from "../src/lib/http";
import { API, golden, server } from "./msw";

const ok = z.object({ ok: z.literal(true) }).strict();

describe("lớp HTTP: CSRF và mã yêu cầu", () => {
  it("lệnh ghi mang X-CSRF-Token đọc từ cookie udp_csrf; lệnh đọc thì không", async () => {
    document.cookie = "udp_csrf=tok-123; path=/";
    const seen: { method: string; csrf: string | null; rid: string | null }[] =
      [];
    server.use(
      http.all(`${API}/probe`, ({ request }) => {
        seen.push({
          method: request.method,
          csrf: request.headers.get("X-CSRF-Token"),
          rid: request.headers.get("X-Request-ID"),
        });
        return HttpResponse.json({ ok: true });
      }),
    );
    await api(ok, "/probe");
    await api(ok, "/probe", { method: "POST", body: {} });
    expect(seen[0]?.csrf).toBeNull();
    expect(seen[1]?.csrf).toBe("tok-123");
    expect(seen.every((s) => s.rid !== null && s.rid.length > 0)).toBe(true);
  });

  it("Idempotency-Key chỉ gửi khi được truyền", async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post(`${API}/probe`, ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return HttpResponse.json({ ok: true });
      }),
    );
    await api(ok, "/probe", { method: "POST", body: {} });
    await api(ok, "/probe", {
      method: "POST",
      body: {},
      idempotencyKey: "k-1",
    });
    expect(keys).toEqual([null, "k-1"]);
  });
});

describe("lớp HTTP: refresh phiên", () => {
  it("401 ⇒ refresh ĐÚNG một lần ⇒ gửi lại và thành công", async () => {
    let refreshes = 0;
    let calls = 0;
    server.use(
      http.get(`${API}/probe`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { title: "x", status: 401, traceId: "t" },
              { status: 401 },
            )
          : HttpResponse.json({ ok: true });
      }),
      http.post(`${API}/auth/refresh`, () => {
        refreshes += 1;
        return HttpResponse.json({}, { status: 200 });
      }),
    );
    await expect(api(ok, "/probe")).resolves.toEqual({ ok: true });
    expect(refreshes).toBe(1);
    expect(calls).toBe(2);
  });

  it("năm request cùng gặp 401 ⇒ vẫn chỉ MỘT lời gọi /auth/refresh (single-flight)", async () => {
    let refreshes = 0;
    let fresh = false;
    server.use(
      http.get(`${API}/probe`, () =>
        fresh
          ? HttpResponse.json({ ok: true })
          : HttpResponse.json(
              { title: "x", status: 401, traceId: "t" },
              { status: 401 },
            ),
      ),
      http.post(`${API}/auth/refresh`, async () => {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 20));
        fresh = true;
        return HttpResponse.json({});
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api(ok, "/probe")),
    );
    expect(results).toHaveLength(5);
    expect(refreshes).toBe(1);
  });

  it("tab khác đã refresh SAU khi request bắt đầu ⇒ không refresh lần hai (tránh revokeFamily)", async () => {
    let refreshes = 0;
    server.use(
      http.post(`${API}/auth/refresh`, () => {
        refreshes += 1;
        return HttpResponse.json({});
      }),
    );
    const startedAt = Date.now() - 1000;
    localStorage.setItem("udp_refreshed_at", String(Date.now()));
    await expect(refreshSession(startedAt)).resolves.toBe(true);
    expect(refreshes).toBe(0);
  });

  it("có Web Locks ⇒ refresh chạy BÊN TRONG khoá udp-auth-refresh", async () => {
    const names: string[] = [];
    const locks = {
      request: vi.fn(async (name: string, cb: () => Promise<boolean>) => {
        names.push(name);
        return cb();
      }),
    };
    Object.defineProperty(navigator, "locks", {
      value: locks,
      configurable: true,
    });
    server.use(http.post(`${API}/auth/refresh`, () => HttpResponse.json({})));
    try {
      await expect(refreshSession(Date.now())).resolves.toBe(true);
      expect(names).toEqual(["udp-auth-refresh"]);
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("refresh thất bại ⇒ báo phiên hết hạn và ném 401", async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    server.use(
      http.get(`${API}/probe`, () =>
        HttpResponse.json(
          { title: "x", status: 401, traceId: "t" },
          { status: 401 },
        ),
      ),
      http.post(`${API}/auth/refresh`, () =>
        HttpResponse.json(
          { title: "x", status: 401, traceId: "t" },
          { status: 401 },
        ),
      ),
    );
    const err = await api(ok, "/probe").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
    setSessionExpiredHandler(() => undefined);
  });

  it("401 ở /auth/login KHÔNG kích hoạt refresh — đó là câu trả lời, không phải phiên cũ", async () => {
    let refreshes = 0;
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json(
          { title: "x", status: 401, traceId: "t" },
          { status: 401 },
        ),
      ),
      http.post(`${API}/auth/refresh`, () => {
        refreshes += 1;
        return HttpResponse.json({});
      }),
    );
    await expect(
      api(ok, "/auth/login", { method: "POST", body: {} }),
    ).rejects.toThrow();
    expect(refreshes).toBe(0);
  });
});

describe("lớp HTTP: lỗi", () => {
  it("ProblemDetails được giữ nguyên: code và traceId đọc được", async () => {
    server.use(
      http.post(`${API}/probe`, () =>
        HttpResponse.json(
          {
            type: "https://udp.dev/problems/duplicate-resource",
            title: "Resource already exists",
            status: 409,
            code: "DUPLICATE_RESOURCE",
            traceId: "trace-9",
          },
          {
            status: 409,
            headers: { "content-type": "application/problem+json" },
          },
        ),
      ),
    );
    const err = (await api(ok, "/probe", { method: "POST", body: {} }).catch(
      (e: unknown) => e,
    )) as ApiError;
    expect(err.kind).toBe("http");
    expect(err.code).toBe("DUPLICATE_RESOURCE");
    expect(err.traceId).toBe("trace-9");
  });

  it("response lệch schema ⇒ ApiError kind contract, KHÔNG trả object sai kiểu", async () => {
    server.use(
      http.get(`${API}/probe`, () => HttpResponse.json({ ok: true, extra: 1 })),
    );
    const err = (await api(ok, "/probe").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("contract");
  });

  it("mất mạng ⇒ ApiError kind network", async () => {
    server.use(http.get(`${API}/probe`, () => HttpResponse.error()));
    const err = (await api(ok, "/probe").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("network");
  });

  it("204 ⇒ undefined", async () => {
    server.use(
      http.delete(
        `${API}/probe`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    await expect(
      api(null, "/probe", { method: "DELETE" }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Trả mục nợ `portal-refresh-lock`: hai tab cùng gặp 401 trên trình duyệt KHÔNG có Web
 * Locks. Tiêu chí Đạt: đúng MỘT lời gọi /auth/refresh và cả hai tab vẫn đăng nhập.
 */
describe("lớp HTTP: hai tab, không có Web Locks", () => {
  it("hai tab cùng refresh ⇒ đúng một /auth/refresh, cả hai nhận true", async () => {
    let refreshes = 0;
    server.use(
      http.post(`${API}/auth/refresh`, async () => {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 30));
        return HttpResponse.json({});
      }),
    );
    const tabA = createRefresher(() => undefined);
    const tabB = createRefresher(() => undefined);
    const startedAt = Date.now() - 5;
    const [a, b] = await Promise.all([tabA(startedAt), tabB(startedAt)]);
    expect([a, b]).toEqual([true, true]);
    expect(refreshes).toBe(1);
    expect(localStorage.getItem("udp_refresh_lease")).toBeNull();
  });

  it("lease của tab đã chết (hết hạn) không chặn mãi", async () => {
    let refreshes = 0;
    server.use(
      http.post(`${API}/auth/refresh`, () => {
        refreshes += 1;
        return HttpResponse.json({});
      }),
    );
    localStorage.setItem(
      "udp_refresh_lease",
      JSON.stringify({ owner: "tab-da-chet", expiresAt: Date.now() - 1 }),
    );
    await expect(createRefresher(() => undefined)(Date.now())).resolves.toBe(
      true,
    );
    expect(refreshes).toBe(1);
  });

  it("đối chứng: KHÔNG khoá gì thì hai tab refresh hai lần — đúng ca bị revokeFamily", async () => {
    let refreshes = 0;
    server.use(
      http.post(`${API}/auth/refresh`, async () => {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 30));
        return HttpResponse.json({});
      }),
    );
    const noLock = {
      request: (_n: string, cb: () => Promise<boolean>) => cb(),
    } as unknown as LockManager;
    const startedAt = Date.now() - 5;
    await Promise.all([
      createRefresher(() => noLock)(startedAt),
      createRefresher(() => noLock)(startedAt),
    ]);
    expect(refreshes).toBe(2);
  });
});

describe("[Plan #41] danh sách flag theo trang", () => {
  it("một trang: không bao giờ xin quá 50; stats chỉ khi xin; count đọc total bằng limit=1", async () => {
    const { flagApi } = await import("../src/features/flag/flag-api");
    const seen: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/projects/:id/flags`, ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json({ flags: [], total: 230 });
      }),
    );

    await flagApi.page("p", "e", "UTC", { limit: 500, offset: 100 });
    expect(seen[0]?.get("limit")).toBe("50");
    expect(seen[0]?.get("offset")).toBe("100");
    expect(seen[0]?.has("include")).toBe(false);

    await flagApi.page("p", "e", "UTC", { stats: true, search: "pay" });
    expect(seen[1]?.get("include")).toBe("stats");
    expect(seen[1]?.get("search")).toBe("pay");

    expect(await flagApi.count("p", "e", { isEnabled: true })).toBe(230);
    expect(seen[2]?.get("limit")).toBe("1");
    expect(seen[2]?.get("isEnabled")).toBe("true");
  });
});
