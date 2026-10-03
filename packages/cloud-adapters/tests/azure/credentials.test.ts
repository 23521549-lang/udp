import { SecretBuffer } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  AZURE_FEDERATION_AUDIENCE,
  exchangeAzureCredential,
} from "../../src/azure/credentials.js";
import { STATIC_CREDENTIAL_TTL_MS } from "../../src/core/credential-exchange.js";
import { fakeHttp } from "../helpers/fake-http.js";

/** Đổi credential Azure (§4.3, Plan #26 AC-9) */

const NOW = Date.parse("2026-09-25T00:00:00.000Z");
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const TARGET = {
  subscriptionId: "11111111-2222-3333-4444-555555555555",
  resourceGroup: "udp-khach",
};
const FEDERATED = {
  tenantId: TENANT,
  clientId: "99999999-8888-7777-6666-555555555555",
  ...TARGET,
};
const stored = (v: unknown) => new SecretBuffer(JSON.stringify(v));
const sessionOf = (cred: { payload: SecretBuffer }) =>
  cred.payload.use((b) => JSON.parse(b.toString("utf8")) as unknown);
const noFederation = () => Promise.reject(new Error("không được gọi"));
const form = (body: unknown) => new URLSearchParams(String(body));

describe("AZURE_FEDERATED (mặc định)", () => {
  it("assertion OIDC của UDP ⇒ hai token (ARM, AKS); hạn là hạn sớm hơn", async () => {
    const http = fakeHttp({
      [`POST ${TOKEN_URL}`]: [
        { body: { access_token: "arm", expires_in: 3599 } },
        { body: { access_token: "aks", expires_in: 1800 } },
      ],
    });
    const audiences: string[] = [];
    const cred = await exchangeAzureCredential({
      mode: "BYOC",
      authKind: "AZURE_FEDERATED",
      stored: stored(FEDERATED),
      federationToken: (aud) => {
        audiences.push(aud);
        return Promise.resolve("udp-oidc-jwt");
      },
      fetch: http.fetch,
      now: () => NOW,
    });
    expect(audiences).toEqual([AZURE_FEDERATION_AUDIENCE]);
    const [arm, aks] = http.calls.map((c) => form(c.body));
    expect(arm?.get("client_assertion")).toBe("udp-oidc-jwt");
    expect(arm?.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(arm?.get("scope")).toBe("https://management.azure.com/.default");
    expect(aks?.get("scope")).toBe(
      "6dae42f8-4368-4678-94ff-3960e28e3630/.default",
    );
    expect(arm?.has("client_secret")).toBe(false);
    expect(sessionOf(cred)).toEqual({
      armToken: "arm",
      aksToken: "aks",
      ...TARGET,
    });
    expect(cred.expiresAt.getTime()).toBe(NOW + 1_800_000);
    cred.dispose();
    expect(cred.payload.everyByteIsZero()).toBe(true);
  });

  it("khách đã xoá federated credential (invalid_client) ⇒ permission", async () => {
    const http = fakeHttp({
      [`POST ${TOKEN_URL}`]: { status: 401, body: { error: "invalid_client" } },
    });
    await expect(
      exchangeAzureCredential({
        mode: "BYOC",
        authKind: "AZURE_FEDERATED",
        stored: stored(FEDERATED),
        federationToken: () => Promise.resolve("jwt"),
        fetch: http.fetch,
      }),
    ).rejects.toMatchObject({ errorClass: "permission" });
  });

  it("payload sai hình ⇒ configuration, KHÔNG gọi Entra ID", async () => {
    const http = fakeHttp({});
    await expect(
      exchangeAzureCredential({
        mode: "BYOC",
        authKind: "AZURE_FEDERATED",
        stored: stored({ ...FEDERATED, tenantId: "khong-phai-uuid" }),
        federationToken: noFederation,
        fetch: http.fetch,
      }),
    ).rejects.toMatchObject({ errorClass: "configuration" });
    expect(http.calls).toHaveLength(0);
  });
});

describe("AZURE_SECRET (dự phòng)", () => {
  it("client secret, bản trong RAM sống tối đa 15 phút", async () => {
    const http = fakeHttp({
      [`POST ${TOKEN_URL}`]: { body: { access_token: "t", expires_in: 3599 } },
    });
    const cred = await exchangeAzureCredential({
      mode: "BYOC",
      authKind: "AZURE_SECRET",
      stored: stored({ ...FEDERATED, clientSecret: "bi-mat-dai-han" }),
      federationToken: noFederation,
      fetch: http.fetch,
      now: () => NOW,
    });
    expect(form(http.calls[0]?.body).get("client_secret")).toBe(
      "bi-mat-dai-han",
    );
    expect(cred.expiresAt.getTime()).toBe(NOW + STATIC_CREDENTIAL_TTL_MS);
  });
});

describe("MANAGED", () => {
  it("IMDS có header Metadata, expires_in dạng chuỗi", async () => {
    const http = fakeHttp({
      "GET http://169.254.169.254/metadata/identity/oauth2/token": [
        { body: { access_token: "arm", expires_in: "3599" } },
        { body: { access_token: "aks", expires_in: "3599" } },
      ],
    });
    const cred = await exchangeAzureCredential({
      mode: "MANAGED",
      authKind: "AZURE_FEDERATED",
      stored: stored(TARGET),
      federationToken: noFederation,
      fetch: http.fetch,
      now: () => NOW,
    });
    expect(http.calls[0]?.headers.Metadata).toBe("true");
    expect(new URL(http.calls[1]?.url ?? "").searchParams.get("resource")).toBe(
      "6dae42f8-4368-4678-94ff-3960e28e3630",
    );
    expect(cred.expiresAt.getTime()).toBe(NOW + 3_599_000);
    expect(cred.mode).toBe("MANAGED");
  });
});
