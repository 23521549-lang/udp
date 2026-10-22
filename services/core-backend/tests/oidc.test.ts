import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  createOidcIssuer,
  FEDERATION_TOKEN_TTL_SECONDS,
  jwkThumbprint,
  oidcIssuerFromConfig,
  oidcPaths,
} from "../src/modules/oidc/oidc.issuer.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import {
  inertCloudPlatform,
  inertProvisioning,
  noDomainAdapters,
  noEgress,
  noExternalAuth,
  noRepoSource,
  outsidePlatform,
} from "./helpers/inert-deps.js";

/**
 * UDP là OIDC issuer (Plan #26 P5): token ký ra kiểm được bằng CHÍNH JWKS công bố — đúng
 * đường mà Google STS và Entra ID đi — và hai endpoint công khai trả đúng tài liệu.
 */

const ISSUER = "https://udp.example/oidc";
const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const NOW = Date.parse("2026-09-25T00:00:00.000Z");
const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";

const decode = (part: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

describe("token federation", () => {
  const issuer = createOidcIssuer({
    issuer: ISSUER,
    privateKeyPem: PEM,
    now: () => NOW,
  });
  const audience =
    "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/u";
  const token = issuer.issueFederationToken(PROJECT, audience);
  const [header, claims, signature] = token.split(".");

  it("chữ ký kiểm được bằng khoá trong JWKS, chọn theo kid", () => {
    const kid = decode(header).kid;
    const jwk = issuer.jwks().keys.find((k) => k.kid === kid);
    if (jwk === undefined)
      throw new Error("JWKS không có khoá mang kid của token");
    const publicKey = createPublicKey({
      key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
      format: "jwk",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header ?? ""}.${claims ?? ""}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("claim: iss, sub project, aud, hạn 5 phút, jti duy nhất", () => {
    const iat = NOW / 1000;
    expect(decode(header)).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toMatchObject({
      iss: ISSUER,
      sub: `project:${PROJECT}`,
      aud: audience,
      iat,
      nbf: iat,
      exp: iat + FEDERATION_TOKEN_TTL_SECONDS,
    });
    const other = issuer.issueFederationToken(PROJECT, audience).split(".")[1];
    expect(decode(other).jti).not.toBe(decode(claims).jti);
  });

  it("kid là thumbprint RFC 7638 (vector của chính RFC, §3.1)", () => {
    expect(
      jwkThumbprint({
        kty: "RSA",
        e: "AQAB",
        n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      }),
    ).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  });

  it("đường dẫn suy từ issuer (OpenID Discovery §4), kể cả issuer ở gốc", () => {
    expect(oidcPaths(ISSUER)).toEqual({
      discovery: "/oidc/.well-known/openid-configuration",
      jwks: "/oidc/jwks",
    });
    expect(oidcPaths("https://udp.example")).toEqual({
      discovery: "/.well-known/openid-configuration",
      jwks: "/jwks",
    });
  });

  it("thiếu một trong hai biến ⇒ không có issuer", () => {
    expect(oidcIssuerFromConfig({ UDP_OIDC_ISSUER: ISSUER })).toBeNull();
    expect(
      oidcIssuerFromConfig({
        UDP_OIDC_ISSUER: ISSUER,
        UDP_OIDC_SIGNING_KEY: Buffer.from(PEM).toString("base64"),
      })?.issuer,
    ).toBe(ISSUER);
  });
});

describe("endpoint công khai", () => {
  const appWith = (oidcIssuer: ReturnType<typeof createOidcIssuer> | null) =>
    createApp({
      metricsFor: () => new FakeMetricsProvider(),
      flagService: createFlagServiceClient({
        baseUrl: "http://127.0.0.1:9",
        secret: "x".repeat(32),
      }),
      oidcIssuer,
      cloud: inertCloudPlatform,
      repoSource: noRepoSource,
      egressFetch: noEgress,
      platform: outsidePlatform,
      auth: noExternalAuth,
      domainRegistry: noDomainAdapters,
      provisioning: inertProvisioning,
    });
  const app = appWith(createOidcIssuer({ issuer: ISSUER, privateKeyPem: PEM }));

  it("discovery trỏ jwks_uri về đúng issuer, không cần phiên, có cache", async () => {
    const res = await request(app).get(
      "/oidc/.well-known/openid-configuration",
    );
    expect(res.status).toBe(200);
    expect(res.get("cache-control")).toBe("public, max-age=300");
    expect(res.body).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
    });
  });

  it("JWKS chỉ có phần CÔNG KHAI của khoá", async () => {
    const res = await request(app).get("/oidc/jwks");
    expect(res.status).toBe(200);
    const [key] = (res.body as { keys: Record<string, unknown>[] }).keys;
    expect(Object.keys(key ?? {}).sort()).toEqual([
      "alg",
      "e",
      "kid",
      "kty",
      "n",
      "use",
    ]);
  });

  it("chưa cấu hình ⇒ 404 cho cả hai", async () => {
    const off = appWith(null);
    expect(
      (await request(off).get("/oidc/.well-known/openid-configuration")).status,
    ).toBe(404);
    expect((await request(off).get("/oidc/jwks")).status).toBe(404);
  });
});
