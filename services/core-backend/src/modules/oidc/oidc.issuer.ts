import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

/**
 * UDP là OIDC issuer (Plan #26 QĐ-5): ký token ngắn hạn mà federation của GCP (Workload
 * Identity) và Azure (federated credential) đổi lấy quyền trên cloud của khách. Khách tin
 * issuer + subject `project:<id>`, không tin một bí mật nào UDP giữ hộ họ.
 *
 * Thuần: không đọc env, không I/O — `createOidcIssuer` nhận khoá và đồng hồ.
 */

/** Token chỉ để đổi ngay lấy token cloud: 5 phút là đủ và đủ ngắn nếu bị lộ trên đường */
export const FEDERATION_TOKEN_TTL_SECONDS = 300;
const ALG = "RS256";

const base64url = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64url");

export const jwkWire = z
  .object({
    kty: z.literal("RSA"),
    n: z.string().min(1),
    e: z.string().min(1),
    kid: z.string().min(1),
    alg: z.literal(ALG),
    use: z.literal("sig"),
  })
  .strict();
export const jwksWire = z.object({ keys: z.array(jwkWire).min(1) }).strict();

export const discoveryWire = z
  .object({
    issuer: z.string().url(),
    jwks_uri: z.string().url(),
    response_types_supported: z.array(z.string()),
    subject_types_supported: z.array(z.string()),
    id_token_signing_alg_values_supported: z.array(z.literal(ALG)),
    claims_supported: z.array(z.string()),
  })
  .strict();

export type Jwks = z.infer<typeof jwksWire>;
export type DiscoveryDocument = z.infer<typeof discoveryWire>;

export interface OidcIssuer {
  readonly issuer: string;
  discovery(): DiscoveryDocument;
  jwks(): Jwks;
  /** Token OIDC cho MỘT project, gửi tới MỘT audience (provider WIF, `api://AzureADTokenExchange`) */
  issueFederationToken(projectId: string, audience: string): string;
}

/** `kid` = thumbprint JWK theo RFC 7638: SHA-256 của `{"e","kty","n"}` theo thứ tự từ điển */
export function jwkThumbprint(jwk: {
  e: string;
  kty: string;
  n: string;
}): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return base64url(createHash("sha256").update(canonical).digest());
}

/**
 * Đường dẫn của hai tài liệu, suy từ CHÍNH issuer (OpenID Discovery §4: tài liệu nằm ở
 * `<issuer>/.well-known/openid-configuration`). Issuer `https://udp.example/oidc` ⇒
 * `/oidc/.well-known/openid-configuration` và `/oidc/jwks`.
 */
export function oidcPaths(issuer: string): { discovery: string; jwks: string } {
  const base = new URL(issuer).pathname.replace(/\/$/, "");
  return {
    discovery: `${base}/.well-known/openid-configuration`,
    jwks: `${base}/jwks`,
  };
}

export function createOidcIssuer(options: {
  issuer: string;
  /** PEM của khoá riêng RSA (env giữ base64 của nó — bên gọi giải trước) */
  privateKeyPem: string;
  now?: () => number;
}): OidcIssuer {
  const privateKey: KeyObject = createPrivateKey(options.privateKeyPem);
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  if (
    exported.kty !== "RSA" ||
    exported.n === undefined ||
    exported.e === undefined
  ) {
    throw new Error("khoá ký OIDC phải là khoá RSA");
  }
  const publicJwk = { kty: "RSA" as const, n: exported.n, e: exported.e };
  const kid = jwkThumbprint(publicJwk);
  const now = options.now ?? Date.now;

  return {
    issuer: options.issuer,

    discovery: () => ({
      issuer: options.issuer,
      jwks_uri: `${options.issuer}/jwks`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [ALG],
      claims_supported: ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"],
    }),

    jwks: () => ({ keys: [{ ...publicJwk, kid, alg: ALG, use: "sig" }] }),

    issueFederationToken: (projectId, audience) => {
      const iat = Math.floor(now() / 1000);
      const header = base64url(JSON.stringify({ alg: ALG, typ: "JWT", kid }));
      const claims = base64url(
        JSON.stringify({
          iss: options.issuer,
          sub: `project:${projectId}`,
          aud: audience,
          iat,
          nbf: iat,
          exp: iat + FEDERATION_TOKEN_TTL_SECONDS,
          jti: randomUUID(),
        }),
      );
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        privateKey,
      );
      return `${header}.${claims}.${base64url(signature)}`;
    },
  };
}

/** Từ hai biến env (cùng có hoặc cùng không — `env.ts` đã canh) */
export function oidcIssuerFromConfig(config: {
  UDP_OIDC_ISSUER?: string | undefined;
  UDP_OIDC_SIGNING_KEY?: string | undefined;
}): OidcIssuer | null {
  if (
    config.UDP_OIDC_ISSUER === undefined ||
    config.UDP_OIDC_SIGNING_KEY === undefined
  ) {
    return null;
  }
  return createOidcIssuer({
    issuer: config.UDP_OIDC_ISSUER,
    privateKeyPem: Buffer.from(config.UDP_OIDC_SIGNING_KEY, "base64").toString(
      "utf8",
    ),
  });
}
