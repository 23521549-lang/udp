import { createVerify, generateKeyPairSync } from "node:crypto";
import { SecretBuffer } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  exchangeGcpCredential,
  serviceAccountAssertion,
  STATIC_CREDENTIAL_TTL_MS,
} from "../../src/gcp/credentials.js";
import { fakeHttp } from "../helpers/fake-http.js";

/** Đổi credential GCP (§4.3, Plan #26 AC-9) */

const NOW = Date.parse("2026-09-25T00:00:00.000Z");
const stored = (v: unknown) => new SecretBuffer(JSON.stringify(v));
const sessionOf = (cred: { payload: SecretBuffer }) =>
  cred.payload.use((b) => JSON.parse(b.toString("utf8")) as unknown);
const noFederation = () => Promise.reject(new Error("không được gọi"));

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const PRIVATE_PEM = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const WIF = {
  gcpProjectId: "demo-project",
  projectNumber: "123456789012",
  poolId: "udp-pool",
  providerId: "udp-oidc",
  serviceAccountEmail: "udp-deployer@demo-project.iam.gserviceaccount.com",
};
const STS = "https://sts.googleapis.com/v1/token";
const IMPERSONATE = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${WIF.serviceAccountEmail}:generateAccessToken`;

describe("GCP_WIF (federation mặc định)", () => {
  it("token OIDC của UDP ⇒ STS ⇒ generateAccessToken; hạn là hạn Google trả", async () => {
    const google = fakeHttp({
      [`POST ${STS}`]: { body: { access_token: "federated" } },
      [`POST ${IMPERSONATE}`]: {
        body: { accessToken: "ya29.sa", expireTime: "2026-09-25T01:00:00Z" },
      },
    });
    const audiences: string[] = [];
    const cred = await exchangeGcpCredential({
      mode: "BYOC",
      authKind: "GCP_WIF",
      stored: stored(WIF),
      federationToken: (aud) => {
        audiences.push(aud);
        return Promise.resolve("udp-oidc-jwt");
      },
      fetch: google.fetch,
      now: () => NOW,
    });
    const audience =
      "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/udp-pool/providers/udp-oidc";
    expect(audiences).toEqual([audience]);
    expect(google.calls[0]?.body).toMatchObject({
      audience,
      subjectToken: "udp-oidc-jwt",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
    });
    expect(google.calls[1]?.headers.Authorization).toBe("Bearer federated");
    expect(sessionOf(cred)).toEqual({
      accessToken: "ya29.sa",
      gcpProjectId: "demo-project",
    });
    expect(cred.expiresAt.toISOString()).toBe("2026-09-25T01:00:00.000Z");
    cred.dispose();
    expect(cred.payload.everyByteIsZero()).toBe(true);
  });

  it("khách đã xoá provider khỏi pool (invalid_grant) ⇒ permission", async () => {
    const google = fakeHttp({
      [`POST ${STS}`]: { status: 400, body: { error: "invalid_grant" } },
    });
    await expect(
      exchangeGcpCredential({
        mode: "BYOC",
        authKind: "GCP_WIF",
        stored: stored(WIF),
        federationToken: () => Promise.resolve("jwt"),
        fetch: google.fetch,
      }),
    ).rejects.toMatchObject({ errorClass: "permission" });
  });

  it("payload sai hình ⇒ configuration, KHÔNG gọi Google", async () => {
    const google = fakeHttp({});
    await expect(
      exchangeGcpCredential({
        mode: "BYOC",
        authKind: "GCP_WIF",
        stored: stored({ ...WIF, projectNumber: "khong-phai-so" }),
        federationToken: noFederation,
        fetch: google.fetch,
      }),
    ).rejects.toMatchObject({ errorClass: "configuration" });
    expect(google.calls).toHaveLength(0);
  });
});

describe("GCP_KEY (khoá JSON dự phòng)", () => {
  const keyFile = {
    type: "service_account",
    project_id: "demo-project",
    client_email: "udp@demo-project.iam.gserviceaccount.com",
    private_key: PRIVATE_PEM,
    private_key_id: "bo-qua",
  };

  it("JWT RS256 ký đúng khoá, gửi grant jwt-bearer; bản trong RAM sống 15 phút", async () => {
    const google = fakeHttp({
      "POST https://oauth2.googleapis.com/token": {
        body: { access_token: "ya29.key", expires_in: 3599 },
      },
    });
    const cred = await exchangeGcpCredential({
      mode: "BYOC",
      authKind: "GCP_KEY",
      stored: stored(keyFile),
      federationToken: noFederation,
      fetch: google.fetch,
      now: () => NOW,
    });
    const form = new URLSearchParams(String(google.calls[0]?.body));
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const [header, claims, signature] = (form.get("assertion") ?? "").split(
      ".",
    );
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header ?? ""}.${claims ?? ""}`);
    expect(
      verifier.verify(publicKey, Buffer.from(signature ?? "", "base64url")),
    ).toBe(true);
    expect(
      JSON.parse(Buffer.from(claims ?? "", "base64url").toString()),
    ).toMatchObject({
      iss: keyFile.client_email,
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    expect(cred.expiresAt.getTime()).toBe(NOW + STATIC_CREDENTIAL_TTL_MS);
    expect(sessionOf(cred)).toEqual({
      accessToken: "ya29.key",
      gcpProjectId: "demo-project",
    });
  });

  it("khoá không phải service account ⇒ configuration", async () => {
    await expect(
      exchangeGcpCredential({
        mode: "BYOC",
        authKind: "GCP_KEY",
        stored: stored({ ...keyFile, type: "authorized_user" }),
        federationToken: noFederation,
        fetch: fakeHttp({}).fetch,
      }),
    ).rejects.toMatchObject({ errorClass: "configuration" });
  });

  it("assertion là JWT ba đoạn base64url, không ký tự đệm", () => {
    const jwt = serviceAccountAssertion(
      "a@b.iam.gserviceaccount.com",
      PRIVATE_PEM,
      1,
    );
    expect(jwt).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });
});

describe("MANAGED", () => {
  it("token từ metadata server, có header Metadata-Flavor", async () => {
    const google = fakeHttp({
      "GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token":
        { body: { access_token: "ya29.managed", expires_in: 1800 } },
    });
    const cred = await exchangeGcpCredential({
      mode: "MANAGED",
      authKind: "GCP_WIF",
      stored: stored({ gcpProjectId: "udp-managed" }),
      federationToken: noFederation,
      fetch: google.fetch,
      now: () => NOW,
    });
    expect(google.calls[0]?.headers["Metadata-Flavor"]).toBe("Google");
    expect(cred.expiresAt.getTime()).toBe(NOW + 1_800_000);
    expect(cred.mode).toBe("MANAGED");
  });

  it("metadata không tới được ⇒ transient", async () => {
    await expect(
      exchangeGcpCredential({
        mode: "MANAGED",
        authKind: "GCP_WIF",
        stored: stored({ gcpProjectId: "udp-managed" }),
        federationToken: noFederation,
        fetch: fakeHttp({}).fetch,
      }),
    ).rejects.toMatchObject({ errorClass: "transient" });
  });
});
