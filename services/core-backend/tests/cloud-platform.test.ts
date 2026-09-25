import { SecretBuffer } from "@udp/adapter-core";
import { awsPlan } from "@udp/cloud-adapters/aws";
import { azurePlan } from "@udp/cloud-adapters/azure";
import { gcpPlan } from "@udp/cloud-adapters/gcp";
import { describe, expect, it } from "vitest";
import {
  capabilitiesOf,
  createCloudPlatform,
  externalIdOf,
} from "../src/modules/cloud/cloud.platform.js";
import { buildSetup } from "../src/modules/cloud/cloud.setup.js";

/**
 * Phần THUẦN của bước cloud (Plan #26 P6): khả năng của triển khai suy từ cấu hình, dữ
 * liệu setup, và các lời từ chối của bước đổi token xảy ra TRƯỚC mọi lời gọi mạng.
 */

const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";
const SECRET = "bi-mat-external-id-cua-udp-toi-thieu-32";
const stored = (v: unknown) => new SecretBuffer(JSON.stringify(v));

describe("ExternalId", () => {
  it("tất định theo project, 32 hex, khác nhau giữa các project", () => {
    const a = externalIdOf(SECRET, PROJECT);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(externalIdOf(SECRET, PROJECT)).toBe(a);
    expect(
      externalIdOf(SECRET, "1f0f0f0f-1111-4222-8333-444455556666"),
    ).not.toBe(a);
    expect(externalIdOf(`${SECRET}-khac`, PROJECT)).not.toBe(a);
  });
});

describe("khả năng của triển khai", () => {
  it("MANAGED chỉ bật cho cloud có trong danh sách VÀ có đích", () => {
    const caps = capabilitiesOf(
      {
        MANAGED_CLOUDS: ["aws", "gcp", "azure"],
        MANAGED_GCP_PROJECT_ID: "udp-managed",
      },
      null,
    );
    expect(caps.managed).toEqual({
      aws: {},
      gcp: { gcpProjectId: "udp-managed" },
      azure: null,
    });
    expect(caps.awsRole).toBeNull();
    expect(caps.oidcIssuer).toBeNull();
  });
});

describe("đổi token bị từ chối trước khi gọi mạng", () => {
  const platform = createCloudPlatform({ MANAGED_CLOUDS: [] }, null);
  const request = {
    projectId: PROJECT,
    region: "ap-southeast-1",
    mode: "BYOC" as const,
  };

  it("authKind lệch cloud ⇒ configuration, không đoán thay", async () => {
    await expect(
      platform.exchange({
        ...request,
        provider: "aws",
        authKind: "GCP_WIF",
        stored: stored({}),
      }),
    ).rejects.toMatchObject({ errorClass: "configuration" });
  });

  it("AWS_ROLE khi UDP chưa bật AWS federation ⇒ configuration", async () => {
    await expect(
      platform.exchange({
        ...request,
        provider: "aws",
        authKind: "AWS_ROLE",
        stored: stored({ roleArn: "arn:aws:iam::123456789012:role/x" }),
      }),
    ).rejects.toMatchObject({ errorClass: "configuration" });
  });

  it("GCP_WIF khi UDP chưa bật OIDC issuer ⇒ configuration", async () => {
    await expect(
      platform.exchange({
        ...request,
        provider: "gcp",
        region: "asia-southeast1",
        authKind: "GCP_WIF",
        stored: stored({
          gcpProjectId: "demo-project",
          projectNumber: "123456789012",
          poolId: "udp-pool",
          providerId: "udp-oidc",
          serviceAccountEmail: "udp@demo-project.iam.gserviceaccount.com",
        }),
      }),
    ).rejects.toMatchObject({ errorClass: "configuration" });
  });

  it("mọi cloud đều có adapter thật", () => {
    for (const provider of ["aws", "gcp", "azure"] as const) {
      expect(platform.adapterFor(provider, "r-1")?.providerId).toBe(provider);
    }
  });
});

describe("dữ liệu setup", () => {
  const caps = capabilitiesOf(
    {
      UDP_AWS_PRINCIPAL_ARN: "arn:aws:iam::111122223333:role/udp-controlplane",
      UDP_EXTERNAL_ID_SECRET: SECRET,
      MANAGED_CLOUDS: [],
    },
    null,
  );

  it("mỗi cloud liệt kê đúng hai cách xác thực của nó, federation trước", () => {
    expect(
      buildSetup("AWS", PROJECT, caps).methods.map((m) => m.authKind),
    ).toEqual(["AWS_ROLE", "AWS_KEY"]);
    expect(
      buildSetup("GCP", PROJECT, caps).methods.map((m) => m.authKind),
    ).toEqual(["GCP_WIF", "GCP_KEY"]);
    expect(
      buildSetup("AZURE", PROJECT, caps).methods.map((m) => m.authKind),
    ).toEqual(["AZURE_FEDERATED", "AZURE_SECRET"]);
  });

  it("danh sách quyền và tài liệu là của CHÍNH kế hoạch sẽ provisioning", () => {
    expect(buildSetup("AWS", PROJECT, caps).requiredPermissions).toEqual([
      ...awsPlan.requiredPermissions,
    ]);
    expect(buildSetup("GCP", PROJECT, caps).docUrl).toBe(gcpPlan.docUrl);
    expect(buildSetup("AZURE", PROJECT, caps).requiredPermissions).toEqual([
      ...azurePlan.requiredPermissions,
    ]);
  });

  it("mọi khối JSON parse được; khối shell chỉ để trống đúng thứ khách mới biết", () => {
    for (const provider of ["AWS", "GCP", "AZURE"] as const) {
      for (const method of buildSetup(provider, PROJECT, caps).methods) {
        for (const snippet of method.snippets) {
          if (snippet.language === "json") {
            expect(() => JSON.parse(snippet.content) as unknown).not.toThrow();
          }
          const placeholders = snippet.content.match(/<[A-Z_]+>/g) ?? [];
          for (const p of placeholders) {
            expect([
              "<GCP_PROJECT_ID>",
              "<SERVICE_ACCOUNT_EMAIL>",
              "<PROJECT_NUMBER>",
              "<APP_ID>",
              "<SUBSCRIPTION_ID>",
              "<RESOURCE_GROUP>",
            ]).toContain(p);
          }
        }
      }
    }
  });
});
