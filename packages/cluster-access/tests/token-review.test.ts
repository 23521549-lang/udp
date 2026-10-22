import { describe, expect, it } from "vitest";
import {
  TOKEN_REVIEW_PATH,
  tokenReviewVerifier,
} from "../src/in-cluster/token-review.js";

/**
 * [Plan #67] `TokenReview` trên API server GIẢ: hình request, ba điều kiện, nhớ dương, không nhớ âm, gộp lời hỏi đang
 * bay, và bản nhớ có trần CHỈ khi API server vắng.
 */

const AUD = "udp:internal:flag-service";
const CALLER = "system:serviceaccount:udp:pd-controller";
const TOKEN = "caller-token-abc";

interface Call {
  url: string;
  init: RequestInit;
}

type Reply = Response | Error;

function fakeApi(replies: (() => Reply)[]) {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    api: {
      apiServer: "https://10.43.0.1:443",
      token: () => Promise.resolve("own-sa-token"),
      transport: {
        request(url: string, init: RequestInit) {
          calls.push({ url, init });
          const make = replies[Math.min(i, replies.length - 1)];
          i += 1;
          const reply = make?.() ?? new Error("không có trả lời");
          return reply instanceof Error
            ? Promise.reject(reply)
            : Promise.resolve(reply);
        },
      },
    },
  };
}

const review = (status: Record<string, unknown>) => () =>
  new Response(
    JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      status,
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );

const ok = review({
  authenticated: true,
  audiences: [AUD],
  user: { username: CALLER },
});
const no = review({
  authenticated: false,
  error: "token has been invalidated",
});
const down = (status: number) => () => new Response("", { status });

function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("tokenReviewVerifier (Plan #67)", () => {
  it("gửi đúng TokenReview: POST, token của chính service, spec.audiences là audience của bên nhận", async () => {
    const { api, calls } = fakeApi([ok]);
    const v = tokenReviewVerifier({ api, audience: AUD });
    expect(await v.verify(TOKEN)).toBe(CALLER);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe(`https://10.43.0.1:443${TOKEN_REVIEW_PATH}`);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer own-sa-token",
    );
    expect(JSON.parse(call.init.body as string)).toEqual({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: { token: TOKEN, audiences: [AUD] },
    });
  });

  it("thiếu bất kỳ điều nào trong ba ⇒ null", async () => {
    const cases = [
      review({ authenticated: false }),
      review({ authenticated: true, user: { username: CALLER } }),
      review({
        authenticated: true,
        audiences: [],
        user: { username: CALLER },
      }),
      review({
        authenticated: true,
        audiences: ["https://kubernetes.default.svc"],
        user: { username: CALLER },
      }),
      review({ authenticated: true, audiences: [AUD], user: {} }),
      review({ authenticated: true, audiences: [AUD], user: { username: "" } }),
      () => new Response("{}", { status: 201 }),
    ];
    for (const [i, reply] of cases.entries()) {
      const { api } = fakeApi([reply]);
      expect(
        await tokenReviewVerifier({ api, audience: AUD }).verify(TOKEN),
        String(i),
      ).toBeNull();
    }
  });

  it("dương nhớ trong ttl, hỏi lại khi quá ttl", async () => {
    const c = clock();
    const { api, calls } = fakeApi([ok]);
    const v = tokenReviewVerifier({
      api,
      audience: AUD,
      ttlMs: 10_000,
      now: c.now,
    });
    await v.verify(TOKEN);
    c.advance(9_999);
    await v.verify(TOKEN);
    expect(calls).toHaveLength(1);
    c.advance(2);
    await v.verify(TOKEN);
    expect(calls).toHaveLength(2);
  });

  it("âm không nhớ: mỗi lần hỏi lại", async () => {
    const { api, calls } = fakeApi([no]);
    const v = tokenReviewVerifier({ api, audience: AUD });
    expect(await v.verify(TOKEN)).toBeNull();
    expect(await v.verify(TOKEN)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("gộp các lời hỏi cùng token đang bay", async () => {
    const { api, calls } = fakeApi([ok]);
    const v = tokenReviewVerifier({ api, audience: AUD });
    const all = await Promise.all([
      v.verify(TOKEN),
      v.verify(TOKEN),
      v.verify(TOKEN),
    ]);
    expect(all).toEqual([CALLER, CALLER, CALLER]);
    expect(calls).toHaveLength(1);
  });

  it("API server vắng sau một lần dương: dùng bản nhớ tới staleMs, quá thì ném", async () => {
    const c = clock();
    const { api } = fakeApi([ok, down(503)]);
    const v = tokenReviewVerifier({
      api,
      audience: AUD,
      ttlMs: 10_000,
      staleMs: 60_000,
      now: c.now,
    });
    await v.verify(TOKEN);
    c.advance(30_000);
    expect(await v.verify(TOKEN)).toBe(CALLER);
    c.advance(30_001);
    await expect(v.verify(TOKEN)).rejects.toThrow(/503/);
  });

  it("lỗi mạng hay 429 cũng là vắng mặt; chưa từng dương thì ném", async () => {
    for (const reply of [
      () => new Error("ECONNREFUSED"),
      down(429),
      down(500),
    ]) {
      const { api } = fakeApi([reply]);
      await expect(
        tokenReviewVerifier({ api, audience: AUD }).verify(TOKEN),
      ).rejects.toThrow();
    }
  });

  it("API server nói 'không' thắng bản nhớ và xoá nó: lần vắng sau đó không được dùng bản cũ", async () => {
    const c = clock();
    const { api } = fakeApi([ok, no, down(503)]);
    const v = tokenReviewVerifier({
      api,
      audience: AUD,
      ttlMs: 10_000,
      now: c.now,
    });
    await v.verify(TOKEN);
    c.advance(10_001);
    expect(await v.verify(TOKEN)).toBeNull();
    await expect(v.verify(TOKEN)).rejects.toThrow();
  });

  it("401/403 là cấu hình sai, không phải vắng mặt: ném ngay cả khi có bản nhớ", async () => {
    const c = clock();
    const { api } = fakeApi([ok, down(403)]);
    const v = tokenReviewVerifier({
      api,
      audience: AUD,
      ttlMs: 10_000,
      now: c.now,
    });
    await v.verify(TOKEN);
    c.advance(10_001);
    await expect(v.verify(TOKEN)).rejects.toThrow(/tokenreviews/);
  });

  it("không thông điệp lỗi nào chứa token", async () => {
    for (const reply of [
      () => new Error(`boom ${TOKEN}`),
      down(503),
      down(403),
      () => new Response("x", { status: 201 }),
    ]) {
      const { api } = fakeApi([reply]);
      const err = await tokenReviewVerifier({ api, audience: AUD })
        .verify(TOKEN)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(String(err instanceof Error ? err.message : err)).not.toContain(
        TOKEN,
      );
    }
  });

  it("bộ nhớ có trần số mục", async () => {
    const { api, calls } = fakeApi([ok]);
    const v = tokenReviewVerifier({ api, audience: AUD, maxEntries: 2 });
    await v.verify("t1");
    await v.verify("t2");
    await v.verify("t3");
    await v.verify("t1");
    expect(calls).toHaveLength(4);
  });
});
