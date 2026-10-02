import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEgressFetch } from "../src/core/egress/egress.js";
import {
  expectationOf,
  resetTrustedDeployKeyCache,
  verifyTrustedDeploy,
  type TrustedDeployExpectation,
} from "../src/modules/cicd/trusted-deploy.js";

/**
 * [Plan #61 QĐ-17, 61d-2a] Lõi xác minh của Trusted Deploy (AC-11).
 *
 * **Mọi phép khẳng định ở đây phải TẤT ĐỊNH** — không phép nào được phụ thuộc đồng hồ thật, độ trễ mạng,
 * hay độ lệch đồng hồ của máy chạy test. Đó không phải sở thích: chính những thứ đó là cái mà bản sửa
 * `occurred_at` của 61d-1 vừa dạy, và một phép kiểm bảo mật mà kết quả đổi theo máy thì không kiểm gì cả.
 * Vì vậy: khoá sinh trong tiến trình, đồng hồ tiêm vào, và `fetch` tiêm vào.
 *
 * `fetch` toàn cục bị thay bằng một hàm NÉM trong cả tệp. Nếu `jose` (hay bất cứ ai) đi ra mạng bằng
 * đường toàn cục thì mọi ô đỏ ngay, thay vì lặng lẽ gọi Internet trong CI.
 */

vi.stubGlobal("fetch", () => {
  throw new Error("mã sản phẩm gọi fetch toàn cục, không đi qua egressFetch");
});

const GITHUB_ISS = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS = `${GITHUB_ISS}/.well-known/jwks`;
const WEBHOOK = "https://udp.test/api/v1/webhooks/cicd/p-1/github-actions";

interface Signer {
  jwk: JWK;
  key: CryptoKey;
}

async function newSigner(kid: string, alg = "RS256"): Promise<Signer> {
  const pair = await generateKeyPair(alg, { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  return { jwk: { ...jwk, alg, kid }, key: pair.privateKey };
}

/** Một phản hồi JSON đủ dùng cho JWKS hay discovery document */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** `fetch` ghi lại MỌI URL đã gọi — danh sách đó là một phép khẳng định, không phải một tiện ích gỡ lỗi */
function recordingFetch(byUrl: Record<string, unknown>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = byUrl[url];
    if (body === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(jsonResponse(body));
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const githubExpectation = (): TrustedDeployExpectation => {
  const got = expectationOf({
    provider: "github-actions",
    toolConfig: { repository: "acme/web" },
    webhookUrl: WEBHOOK,
  });
  if ("unavailable" in got) throw new Error("github phải khả dụng");
  return got;
};

/** Token "đúng mọi thứ" — mỗi ô test chỉ đổi MỘT điều so với nó, nên lý do đỏ không bao giờ mơ hồ */
async function githubToken(
  signer: Signer,
  over: {
    iss?: string;
    aud?: string;
    repository?: string;
    ref?: string;
    jti?: string | null;
    iat?: number;
    exp?: number;
    alg?: string;
    kid?: string | null;
  } = {},
): Promise<string> {
  const now = Math.floor(NOW.getTime() / 1000);
  const claims: Record<string, unknown> = {
    repository: over.repository ?? "acme/web",
    ref: over.ref ?? "refs/heads/main",
    iat: over.iat ?? now,
    exp: over.exp ?? now + 300,
  };
  if (over.jti !== null) claims.jti = over.jti ?? "jti-1";
  const header: Record<string, unknown> = { alg: over.alg ?? "RS256" };
  if (over.kid !== null) header.kid = over.kid ?? (signer.jwk.kid as string);
  return await new SignJWT(claims)
    .setProtectedHeader(header as never)
    .setIssuer(over.iss ?? GITHUB_ISS)
    .setAudience(over.aud ?? WEBHOOK)
    .sign(signer.key);
}

/** Đồng hồ TIÊM VÀO — không một ô nào đọc đồng hồ thật */
const NOW = new Date("2026-10-02T12:00:00.000Z");

let signer: Signer;

beforeEach(async () => {
  resetTrustedDeployKeyCache();
  signer = await newSigner("k1");
});

describe("Trusted Deploy — issuer suy từ cấu hình, không từ token", () => {
  it("GitHub: đúng MỘT lời gọi tới JWKS ghim cứng, KHÔNG lời gọi discovery nào", async () => {
    const net = recordingFetch({ [GITHUB_JWKS]: { keys: [signer.jwk] } });
    const verdict = await verifyTrustedDeploy({
      expected: githubExpectation(),
      authorization: `Bearer ${await githubToken(signer)}`,
      egressFetch: net.fetch,
      clusterKeys: null,
      now: NOW,
    });

    expect(verdict).toMatchObject({ kind: "verified", tokenId: "jti-1" });
    // So BẰNG chứ không `toContain`: một lời gọi THỪA (ví dụ discovery theo `iss` của token) thành đỏ
    expect(net.calls).toEqual([GITHUB_JWKS]);
  });

  it("issuer thù địch: token ký hoàn hảo, claim đúng hết ⇒ từ chối và KHÔNG một lời gọi mạng nào", async () => {
    const evil = await newSigner("evil-1");
    const net = recordingFetch({ [GITHUB_JWKS]: { keys: [signer.jwk] } });
    const verdict = await verifyTrustedDeploy({
      expected: githubExpectation(),
      authorization: `Bearer ${await githubToken(evil, { iss: "https://evil.test" })}`,
      egressFetch: net.fetch,
      clusterKeys: null,
      now: NOW,
    });

    expect(verdict).toMatchObject({
      kind: "rejected",
      code: "TOKEN_ISSUER_UNEXPECTED",
    });
    // Phép khẳng định SSRF, không cần mạng: lấy discovery theo `iss` chưa xác minh là bypass toàn phần
    expect(net.calls).toEqual([]);
  });

  it("CircleCI thiếu organizationId hay projectId ⇒ không khả dụng, không suy issuer từ token", () => {
    expect(
      expectationOf({
        provider: "circleci",
        toolConfig: { projectSlug: "gh/acme/web" },
        webhookUrl: WEBHOOK,
      }),
    ).toEqual({ unavailable: "MISSING_CIRCLECI_IDS" });
  });

  it("ba CI trong cụm: mong đợi theo CỤM, chủ thể ghim, không claim repo hay ref", () => {
    for (const provider of ["jenkins", "tekton", "drone"]) {
      expect(
        expectationOf({ provider, toolConfig: {}, webhookUrl: WEBHOOK }),
      ).toEqual({
        kind: "cluster",
        provider,
        // `aud` là địa chỉ webhook tuyệt đối, như GitHub và GitLab
        audience: WEBHOOK,
        // Chủ thể là phép kiểm chặn leo thang nội cụm: mọi pod khác trong cụm có `sub` khác
        subject: "system:serviceaccount:udp-build:udp-builder",
        tokenIdClaim: "jti",
      });
    }
  });

  it("CircleCI: `aud` mong đợi là organizationId, không phải địa chỉ webhook", () => {
    const got = expectationOf({
      provider: "circleci",
      toolConfig: {
        projectSlug: "gh/acme/web",
        organizationId: "11111111-2222-3333-4444-555555555555",
        projectId: "66666666-7777-8888-9999-000000000000",
      },
      webhookUrl: WEBHOOK,
    });
    if ("unavailable" in got || got.kind !== "provider") {
      throw new Error("circleci phải khả dụng và là một nhà cung cấp SaaS");
    }
    expect(got.audience).toBe("11111111-2222-3333-4444-555555555555");
    expect(got.issuer).toBe(
      "https://oidc.circleci.com/org/11111111-2222-3333-4444-555555555555",
    );
    expect(got.tokenIdClaim).toBe("oidc.circleci.com/job-id");
  });
});

describe("Trusted Deploy — thời gian, với đồng hồ tiêm vào", () => {
  const verify = async (over: Parameters<typeof githubToken>[1], now: Date) => {
    const net = recordingFetch({ [GITHUB_JWKS]: { keys: [signer.jwk] } });
    return await verifyTrustedDeploy({
      expected: githubExpectation(),
      authorization: `Bearer ${await githubToken(signer, over)}`,
      egressFetch: net.fetch,
      clusterKeys: null,
      now,
    });
  };
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);

  it("`exp` đã qua nhưng `iat` còn mới ⇒ từ chối", async () => {
    const now = sec(NOW);
    expect(await verify({ iat: now - 300, exp: now - 240 }, NOW)).toMatchObject(
      { kind: "rejected", code: "TOKEN_EXPIRED" },
    );
  });

  /**
   * Lề lệch đồng hồ là một con số CÓ CHỦ ĐÍCH, nên nó phải được ghim bằng một phép khẳng định.
   *
   * Vì sao có lề: `iat`/`exp` do nhà cung cấp CI đặt, `now` do Service 1 đặt — hai đồng hồ khác nhau.
   * Không lề thì một lệch vài giây làm bước báo đỏ oan, và với chế độ bắt buộc đã bật thì project không
   * deploy được. Chiều NGUY HIỂM là S1 chạy chậm hơn nhà cung cấp (token hết hạn thật vẫn được nhận), nên
   * lề phải nhỏ: 60 giây, và cửa sổ đó còn bị chặn thêm bởi chính bảng "dùng một lần" (I41) — một token
   * quá hạn trong lề chỉ dùng được nếu nó CHƯA từng được dùng.
   */
  it("`exp` quá hạn trong lề 60 giây vẫn được nhận; quá lề thì không", async () => {
    const now = sec(NOW);
    expect(await verify({ iat: now - 120, exp: now - 30 }, NOW)).toMatchObject({
      kind: "verified",
    });
    expect(await verify({ iat: now - 120, exp: now - 90 }, NOW)).toMatchObject({
      kind: "rejected",
      code: "TOKEN_EXPIRED",
    });
  });

  it("`exp = iat + 2 phút` nhưng trình ở `iat + 5 phút` ⇒ từ chối", async () => {
    // Luật "chỉ `iat` không quá 10 phút" sẽ NHẬN ô này — nó canh đúng chỗ đó
    const iat = sec(NOW);
    expect(
      await verify({ iat, exp: iat + 120 }, new Date(NOW.getTime() + 300_000)),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_EXPIRED" });
  });

  it("`iat` cũ hơn trần chính sách 10 phút ⇒ từ chối dù `exp` còn hạn", async () => {
    const iat = sec(NOW) - 20 * 60;
    expect(await verify({ iat, exp: sec(NOW) + 3600 }, NOW)).toMatchObject({
      kind: "rejected",
      code: "TOKEN_EXPIRED",
    });
  });

  it("`iat` ở TƯƠNG LAI quá lề lệch đồng hồ ⇒ từ chối", async () => {
    const iat = sec(NOW) + 600;
    expect(await verify({ iat, exp: iat + 300 }, NOW)).toMatchObject({
      kind: "rejected",
    });
  });
});

describe("Trusted Deploy — khoá và thuật toán", () => {
  it("`aud` sai ⇒ từ chối", async () => {
    const net = recordingFetch({ [GITHUB_JWKS]: { keys: [signer.jwk] } });
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(signer, { aud: "https://khac.test/hook" })}`,
        egressFetch: net.fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_AUDIENCE_MISMATCH" });
  });

  it("ký bằng khoá KHÁC khoá trong JWKS ⇒ từ chối", async () => {
    const other = await newSigner("k1");
    const net = recordingFetch({ [GITHUB_JWKS]: { keys: [signer.jwk] } });
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(other)}`,
        egressFetch: net.fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_INVALID" });
  });

  it("thuật toán khác RS256 ⇒ từ chối (đóng lớp alg-confusion)", async () => {
    const es = await newSigner("k1", "ES256");
    const net = recordingFetch({ [GITHUB_JWKS]: { keys: [es.jwk] } });
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(es, { alg: "ES256" })}`,
        egressFetch: net.fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_INVALID" });
  });

  it("JWKS hai khoá mà token không `kid` ⇒ từ chối, KHÔNG lấy khoá đầu", async () => {
    const second = await newSigner("k2");
    const net = recordingFetch({
      [GITHUB_JWKS]: { keys: [signer.jwk, second.jwk] },
    });
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(signer, { kid: null })}`,
        egressFetch: net.fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_INVALID" });
  });

  it("không lấy được khoá ⇒ TOKEN_KEYS_UNAVAILABLE (hạ tầng, retryable), KHÔNG rơi về HMAC", async () => {
    const net = recordingFetch({});
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(signer)}`,
        egressFetch: net.fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_KEYS_UNAVAILABLE" });
  });

  it("nhà cung cấp hỏng SAU một lần lấy thành công ⇒ phục vụ bản khoá cũ, không chặn deploy", async () => {
    const ok = recordingFetch({ [GITHUB_JWKS]: { keys: [signer.jwk] } });
    const first = await verifyTrustedDeploy({
      expected: githubExpectation(),
      authorization: `Bearer ${await githubToken(signer)}`,
      egressFetch: ok.fetch,
      clusterKeys: null,
      now: NOW,
    });
    expect(first).toMatchObject({ kind: "verified" });

    // Nhà cung cấp chết, và đồng hồ nhảy quá hạn cache nên bộ kiểm BUỘC phải thử lấy mới
    const dead = recordingFetch({});
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(signer, {
          jti: "jti-2",
          iat: Math.floor(later.getTime() / 1000),
          exp: Math.floor(later.getTime() / 1000) + 300,
        })}`,
        egressFetch: dead.fetch,
        clusterKeys: null,
        now: later,
      }),
    ).toMatchObject({ kind: "verified", tokenId: "jti-2" });
    expect(dead.calls).toEqual([GITHUB_JWKS]);
  });
});

describe("Trusted Deploy — hình dạng header và claim bắt buộc", () => {
  const net = () => recordingFetch({ [GITHUB_JWKS]: { keys: [signer.jwk] } });

  it("không có header ⇒ `absent`, không phải từ chối", async () => {
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: undefined,
        egressFetch: net().fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toEqual({ kind: "absent" });
  });

  it("header không phải Bearer JWT ba phần ⇒ TOKEN_MALFORMED, không gọi mạng", async () => {
    const spy = net();
    for (const header of ["Basic abc", "Bearer khong-phai-jwt", "Bearer a.b"]) {
      expect(
        await verifyTrustedDeploy({
          expected: githubExpectation(),
          authorization: header,
          egressFetch: spy.fetch,
          clusterKeys: null,
          now: NOW,
        }),
      ).toMatchObject({ kind: "rejected", code: "TOKEN_MALFORMED" });
    }
    expect(spy.calls).toEqual([]);
  });

  it("claim repo lệch cấu hình project ⇒ từ chối, kể cả khi chữ ký đúng", async () => {
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(signer, { repository: "acme/khac" })}`,
        egressFetch: net().fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_CLAIM_MISMATCH" });
  });

  it("token không mang mã một lần ⇒ từ chối, không bỏ qua trong im lặng", async () => {
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(signer, { jti: null })}`,
        egressFetch: net().fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "rejected", code: "TOKEN_CLAIM_MISMATCH" });
  });

  it("`ref` lên tới phán quyết để cổng nhánh dùng — lấy từ CLAIM, không từ thân", async () => {
    expect(
      await verifyTrustedDeploy({
        expected: githubExpectation(),
        authorization: `Bearer ${await githubToken(signer, { ref: "refs/heads/feature-x" })}`,
        egressFetch: net().fetch,
        clusterKeys: null,
        now: NOW,
      }),
    ).toMatchObject({ kind: "verified", ref: "refs/heads/feature-x" });
  });
});

describe("Trusted Deploy — hàng rào egress thật nằm trong đường đi", () => {
  it("issuer GitLab trỏ vào địa chỉ nội bộ ⇒ chặn ở tầng egress, không phải timeout", async () => {
    const got = expectationOf({
      provider: "gitlab-ci",
      toolConfig: {
        projectPath: "acme/web",
        // Regex của `gitlabUrl` NHẬN chuỗi này — nên hàng rào egress là thứ duy nhất chặn nó
        gitlabUrl: "https://169.254.169.254",
      },
      webhookUrl: WEBHOOK,
    });
    if ("unavailable" in got || got.kind !== "provider") {
      throw new Error("gitlab phải khả dụng và là một nhà cung cấp SaaS");
    }
    expect(got.keys).toEqual({
      kind: "direct",
      jwksUri: "https://169.254.169.254/oauth/discovery/keys",
    });

    const verdict = await verifyTrustedDeploy({
      expected: got,
      authorization: `Bearer ${await githubToken(signer, {
        iss: "https://169.254.169.254",
      })}`,
      // `createEgressFetch` THẬT, với `lookup` tiêm vào: không một gói nào ra khỏi máy
      egressFetch: createEgressFetch({
        lookup: (_host, _opts, cb) => {
          cb(null, [{ address: "169.254.169.254", family: 4 }]);
        },
      }),
      clusterKeys: null,
      now: NOW,
    });

    expect(verdict).toMatchObject({
      kind: "rejected",
      code: "TOKEN_KEYS_UNAVAILABLE",
    });
    expect((verdict as { detail: string }).detail).toMatch(/egress|Không gọi/i);
  });
});

/**
 * [Plan #61 61d-2b-1] Nhánh CI-trong-cụm: khoá kiểm lấy từ CHÍNH cụm của project (I42).
 *
 * Cùng kỷ luật với phần trên — khoá sinh trong tiến trình, đồng hồ tiêm vào, cổng đọc cụm tiêm vào — nên
 * không ô nào cần một cụm thật. Thứ các ô này chốt là bốn nửa của I42 cộng hai tính chất của cache.
 */
describe("Trusted Deploy — ba CI trong cụm, khoá từ chính cụm (I42)", () => {
  const CLUSTER_ISS = "https://oidc.eks.ap-southeast-1.amazonaws.com/id/ABC";
  const JENKINS_WEBHOOK = "https://udp.test/api/v1/webhooks/cicd/p-1/jenkins";
  const SUBJECT = "system:serviceaccount:udp-build:udp-builder";

  const clusterExpectation = (): TrustedDeployExpectation => {
    const got = expectationOf({
      provider: "jenkins",
      toolConfig: {},
      webhookUrl: JENKINS_WEBHOOK,
    });
    if ("unavailable" in got) throw new Error("jenkins phải khả dụng");
    return got;
  };

  /** Token bound SA của pod build — mọi claim đúng trừ thứ mỗi ô cố ý đổi */
  async function saToken(
    signerOf: Signer,
    over: {
      iss?: string;
      aud?: string;
      sub?: string;
      jti?: string | null;
      alg?: string;
    } = {},
  ): Promise<string> {
    const now = Math.floor(NOW.getTime() / 1000);
    const claims: Record<string, unknown> = {
      sub: over.sub ?? SUBJECT,
      "kubernetes.io": { namespace: "udp-build" },
      iat: now,
      exp: now + 3600,
    };
    if (over.jti !== null) claims.jti = over.jti ?? "jti-cum-1";
    return await new SignJWT(claims)
      .setProtectedHeader({
        alg: over.alg ?? "RS256",
        kid: signerOf.jwk.kid as string,
      })
      .setIssuer(over.iss ?? CLUSTER_ISS)
      .setAudience(over.aud ?? JENKINS_WEBHOOK)
      .sign(signerOf.key);
  }

  /** Cổng đọc cụm, đếm số lượt đọc — số đó là oracle của cache và của cache ÂM */
  function clusterPort(
    read: () => Promise<{
      issuer: string;
      algorithms: readonly string[];
      jwks: unknown;
    }>,
    cacheKey = "p-1",
  ): { port: { cacheKey: string; read: typeof read }; reads: () => number } {
    let count = 0;
    return {
      port: {
        cacheKey,
        read: () => {
          count += 1;
          return read();
        },
      },
      reads: () => count,
    };
  }

  const servesCluster = (
    signerOf: Signer,
    algorithms: readonly string[] = ["RS256"],
    issuer = CLUSTER_ISS,
  ) =>
    clusterPort(() =>
      Promise.resolve({ issuer, algorithms, jwks: { keys: [signerOf.jwk] } }),
    );

  /** `egressFetch` của nhánh cụm phải KHÔNG BAO GIỜ được gọi — đường đọc là `ClusterAccess` */
  const noEgress = (() => {
    throw new Error("nhánh cụm không được gọi egressFetch");
  }) as unknown as typeof fetch;

  it("token của pod build: nhận, và KHÔNG một lời gọi egress nào", async () => {
    const { port, reads } = servesCluster(signer);
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(signer)}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    expect(verdict).toMatchObject({
      kind: "verified",
      issuer: CLUSTER_ISS,
      tokenId: "jti-cum-1",
      // Token SA không mang claim ref: lớp này KHÔNG chứng minh nhánh (§8.3, §16)
      ref: null,
    });
    expect(reads()).toBe(1);
  });

  it("chủ thể là một ServiceAccount KHÁC trong cùng cụm ⇒ từ chối (chặn leo thang nội cụm)", async () => {
    const { port } = servesCluster(signer);
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(signer, {
        sub: "system:serviceaccount:default:app",
      })}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    expect(verdict).toMatchObject({
      kind: "rejected",
      code: "TOKEN_CLAIM_MISMATCH",
    });
    // Thông điệp mang chủ thể NHẬN ĐƯỢC: không có nó, một lượt Tekton thiếu cờ SA là 401 không truy được
    expect((verdict as { detail: string }).detail).toContain(
      "system:serviceaccount:default:app",
    );
  });

  it("token ký bằng khoá của CỤM KHÁC, cùng kid ⇒ từ chối ở chữ ký", async () => {
    const other = await newSigner(signer.jwk.kid as string);
    const { port } = servesCluster(signer);
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(other)}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    expect(verdict).toMatchObject({ kind: "rejected", code: "TOKEN_INVALID" });
  });

  it("`iss` không phải chuỗi cụm khai ⇒ từ chối, kể cả khi chữ ký đúng", async () => {
    const { port } = servesCluster(signer);
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(signer, {
        iss: "https://cum-khac.test/id/XYZ",
      })}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    expect(verdict).toMatchObject({
      kind: "rejected",
      code: "TOKEN_ISSUER_UNEXPECTED",
    });
  });

  it("`aud` của project khác ⇒ từ chối", async () => {
    const { port } = servesCluster(signer);
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(signer, {
        aud: "https://udp.test/api/v1/webhooks/cicd/p-2/jenkins",
      })}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    expect(verdict).toMatchObject({
      kind: "rejected",
      code: "TOKEN_AUDIENCE_MISMATCH",
    });
  });

  it("cụm dùng khoá EC: nhận ES256 — ghim cứng RS256 sẽ chặn chính cụm đó", async () => {
    const ec = await newSigner("k-ec", "ES256");
    const { port } = servesCluster(ec, ["ES256"]);
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(ec, { alg: "ES256" })}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    expect(verdict).toMatchObject({ kind: "verified" });
  });

  it("cụm khai thuật toán ngoài allowlist ⇒ 503 retryable, KHÔNG 401", async () => {
    const { port } = servesCluster(signer, ["HS256"]);
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(signer)}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    // Lý do là hạ tầng (cụm khai thứ UDP không kiểm được), nên nó phải retryable — không phải lỗi của token
    expect(verdict).toMatchObject({
      kind: "rejected",
      code: "TOKEN_KEYS_UNAVAILABLE",
    });
  });

  it("tiến trình không có đường ra cụm ⇒ 503, không bao giờ bỏ qua phép kiểm", async () => {
    const verdict = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${await saToken(signer)}`,
      egressFetch: noEgress,
      clusterKeys: null,
      now: NOW,
    });

    expect(verdict).toMatchObject({
      kind: "rejected",
      code: "TOKEN_KEYS_UNAVAILABLE",
    });
  });

  it("cache: hai lời báo liên tiếp đọc cụm ĐÚNG một lần", async () => {
    const { port, reads } = servesCluster(signer);
    for (const jti of ["jti-a", "jti-b"]) {
      const verdict = await verifyTrustedDeploy({
        expected: clusterExpectation(),
        authorization: `Bearer ${await saToken(signer, { jti })}`,
        egressFetch: noEgress,
        clusterKeys: port,
        now: NOW,
      });
      expect(verdict).toMatchObject({ kind: "verified" });
    }
    expect(reads()).toBe(1);
  });

  /**
   * Cache ÂM — chốt cho đúng lỗ mà vòng QA của plan 61d-2b tìm ra.
   *
   * Trước đợt này, `cache.set` chỉ chạy trên đường thành công, nên khi chưa có bản khoá nào thì MỌI lời báo
   * hỏng đều đi đọc lại ngay. Với nhánh cụm, mỗi lượt đọc là một lần lấy credential cloud + một token quản
   * trị + hai lời gọi API server ⇒ một kẻ có secret HMAC biến webhook thành máy bơm vào cloud của khách.
   */
  it("cache ÂM: cụm hỏng, hai lời báo liên tiếp đọc cụm ĐÚNG một lần", async () => {
    const { port, reads } = clusterPort(() =>
      Promise.reject(new Error("cụm không với tới")),
    );
    for (const jti of ["jti-a", "jti-b"]) {
      const verdict = await verifyTrustedDeploy({
        expected: clusterExpectation(),
        authorization: `Bearer ${await saToken(signer, { jti })}`,
        egressFetch: noEgress,
        clusterKeys: port,
        now: NOW,
      });
      expect(verdict).toMatchObject({
        kind: "rejected",
        code: "TOKEN_KEYS_UNAVAILABLE",
      });
    }
    expect(reads()).toBe(1);
  });

  it("cache ÂM hết hạn sau cooldown ⇒ thử lại đúng MỘT lần nữa", async () => {
    const { port, reads } = clusterPort(() =>
      Promise.reject(new Error("cụm không với tới")),
    );
    const call = async (now: Date) =>
      await verifyTrustedDeploy({
        expected: clusterExpectation(),
        authorization: `Bearer ${await saToken(signer)}`,
        egressFetch: noEgress,
        clusterKeys: port,
        now,
      });

    await call(NOW);
    await call(new Date(NOW.getTime() + 29_000));
    expect(reads()).toBe(1);
    await call(new Date(NOW.getTime() + 31_000));
    expect(reads()).toBe(2);
  });

  it("I24: cache KHÔNG giữ token nào, chỉ khoá công khai", async () => {
    const { port } = servesCluster(signer);
    const token = await saToken(signer);
    await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${token}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });

    // Lượt đọc thứ hai phục vụ từ cache: nếu cache giữ token thì nó sẽ nằm trong `jwks` đã lưu
    const second = await verifyTrustedDeploy({
      expected: clusterExpectation(),
      authorization: `Bearer ${token}`,
      egressFetch: noEgress,
      clusterKeys: port,
      now: NOW,
    });
    expect(JSON.stringify(second)).not.toContain(token.split(".")[2]);
  });
});
