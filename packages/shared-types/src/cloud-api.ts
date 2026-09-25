import { z } from "zod";

/**
 * [v4.11] Hợp đồng ghi cấu hình cloud của project (Plan #26, §4.3, §9) — MỘT định nghĩa
 * cho form của Portal, biên `PUT /projects/:id/cloud` của Service 1, và bước đổi token
 * của `@udp/cloud-adapters` (payload đã lưu CHÍNH LÀ `credential` bỏ `authKind`).
 *
 * Tên nhà cung cấp ở đây là dạng của database (`AWS`, chữ hoa) — dạng Portal và API dùng;
 * adapter dùng chữ thường, và Service 1 dịch qua `provider-codec.ts`.
 */

export const CLOUD_PROVIDERS_WIRE = ["AWS", "GCP", "AZURE"] as const;
export type CloudProviderWire = (typeof CLOUD_PROVIDERS_WIRE)[number];
export const cloudProviderSchema = z.enum(CLOUD_PROVIDERS_WIRE);

export const CLOUD_AUTH_KINDS = [
  "AWS_ROLE",
  "AWS_KEY",
  "GCP_WIF",
  "GCP_KEY",
  "AZURE_FEDERATED",
  "AZURE_SECRET",
] as const;
export type CloudAuthKindWire = (typeof CLOUD_AUTH_KINDS)[number];
export const cloudAuthKindSchema = z.enum(CLOUD_AUTH_KINDS);

/** Nhà cung cấp của từng cách xác thực — PUT với cặp lệch nhau bị từ chối */
export const PROVIDER_OF_AUTH_KIND: Readonly<
  Record<CloudAuthKindWire, CloudProviderWire>
> = {
  AWS_ROLE: "AWS",
  AWS_KEY: "AWS",
  GCP_WIF: "GCP",
  GCP_KEY: "GCP",
  AZURE_FEDERATED: "AZURE",
  AZURE_SECRET: "AZURE",
};

/** Họ federation — mặc định khuyến nghị; ba họ còn lại là khoá dài hạn (§4.3) */
export const FEDERATED_AUTH_KINDS: readonly CloudAuthKindWire[] = [
  "AWS_ROLE",
  "GCP_WIF",
  "AZURE_FEDERATED",
];

/** Region của cả ba cloud: `ap-southeast-1`, `asia-southeast1`, `southeastasia` */
export const cloudRegionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}$/, "region không hợp lệ");

const gcpProjectId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, "project GCP không hợp lệ");
const azureTarget = {
  subscriptionId: z.string().uuid("subscription ID không hợp lệ"),
  resourceGroup: z
    .string()
    .regex(/^[\w().-]{1,90}$/, "resource group không hợp lệ"),
};
const azurePrincipal = {
  tenantId: z.string().uuid("tenant ID không hợp lệ"),
  clientId: z.string().uuid("client ID không hợp lệ"),
};

/**
 * Hình của payload theo `authKind` — đúng thứ được mã hoá và lưu (§4.3). Mọi schema
 * `.strict()`: một trường lạ trong payload là một thứ không ai định lưu mà vẫn bị mã hoá
 * và giữ mãi.
 */
export const credentialPayloadSchemas = {
  AWS_ROLE: z
    .object({
      roleArn: z
        .string()
        .regex(
          /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/,
          "roleArn không hợp lệ",
        ),
    })
    .strict(),
  AWS_KEY: z
    .object({
      accessKeyId: z
        .string()
        .regex(/^(AKIA|ASIA)[A-Z0-9]{12,}$/, "accessKeyId không hợp lệ"),
      secretAccessKey: z.string().min(20, "secret access key quá ngắn"),
    })
    .strict(),
  GCP_WIF: z
    .object({
      gcpProjectId,
      projectNumber: z
        .string()
        .regex(/^\d{6,20}$/, "project number không hợp lệ"),
      poolId: z.string().regex(/^[a-z0-9-]{4,32}$/, "pool id không hợp lệ"),
      providerId: z
        .string()
        .regex(/^[a-z0-9-]{4,32}$/, "provider id không hợp lệ"),
      serviceAccountEmail: z
        .string()
        .email("email service account không hợp lệ"),
    })
    .strict(),
  /** Bốn trường cần của khoá JSON tải từ Console — Portal lọc trước khi gửi */
  GCP_KEY: z
    .object({
      type: z.literal("service_account", {
        errorMap: () => ({ message: "khoá không phải của service account" }),
      }),
      project_id: gcpProjectId,
      client_email: z.string().email("client_email không hợp lệ"),
      private_key: z
        .string()
        .includes("PRIVATE KEY", {
          message: "private_key không phải khoá PEM",
        }),
    })
    .strict(),
  AZURE_FEDERATED: z.object({ ...azurePrincipal, ...azureTarget }).strict(),
  AZURE_SECRET: z
    .object({
      ...azurePrincipal,
      ...azureTarget,
      clientSecret: z.string().min(8, "client secret quá ngắn"),
    })
    .strict(),
} as const;

export type CredentialPayload<K extends CloudAuthKindWire> = z.infer<
  (typeof credentialPayloadSchemas)[K]
>;

const credentialSchema = z.discriminatedUnion("authKind", [
  credentialPayloadSchemas.AWS_ROLE.extend({ authKind: z.literal("AWS_ROLE") }),
  credentialPayloadSchemas.AWS_KEY.extend({ authKind: z.literal("AWS_KEY") }),
  credentialPayloadSchemas.GCP_WIF.extend({ authKind: z.literal("GCP_WIF") }),
  credentialPayloadSchemas.GCP_KEY.extend({ authKind: z.literal("GCP_KEY") }),
  credentialPayloadSchemas.AZURE_FEDERATED.extend({
    authKind: z.literal("AZURE_FEDERATED"),
  }),
  credentialPayloadSchemas.AZURE_SECRET.extend({
    authKind: z.literal("AZURE_SECRET"),
  }),
]);
export type CloudCredentialInput = z.infer<typeof credentialSchema>;

/**
 * Body của `PUT /projects/:id/cloud`. BYOC mang credential của khách; MANAGED không
 * mang gì — UDP dùng identity của chính nó (§4.3), nên không có gì để khách nhập.
 */
export const putCloudBodySchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("BYOC"),
        provider: cloudProviderSchema,
        region: cloudRegionSchema,
        credential: credentialSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("MANAGED"),
        provider: cloudProviderSchema,
        region: cloudRegionSchema,
      })
      .strict(),
  ])
  .superRefine((body, ctx) => {
    if (
      body.mode === "BYOC" &&
      PROVIDER_OF_AUTH_KIND[body.credential.authKind] !== body.provider
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["credential", "authKind"],
        message: `${body.credential.authKind} không dùng được với ${body.provider}`,
      });
    }
  });
export type PutCloudBody = z.infer<typeof putCloudBodySchema>;

/** Tách `authKind` khỏi credential: phần còn lại là đúng payload sẽ mã hoá */
export function payloadOf(credential: CloudCredentialInput): {
  authKind: CloudAuthKindWire;
  payload: Record<string, string>;
} {
  const { authKind, ...payload } = credential;
  return { authKind, payload };
}

/** Query của `GET /projects/:id/cloud/setup` */
export const cloudSetupQuerySchema = z
  .object({ provider: cloudProviderSchema })
  .strict();
export type CloudSetupQuery = z.infer<typeof cloudSetupQuerySchema>;

/**
 * Slug `type` của ba lỗi mà Portal rẽ nhánh ở bước cloud — không thêm mã vào catalog 24 mã
 * (I36): các lỗi này không có mã nghiệp vụ riêng, chỉ cần phân biệt được ở client.
 */
export const CLOUD_ERROR_SLUGS = {
  notConfigured: "cloud-not-configured",
  methodUnavailable: "cloud-method-unavailable",
  credentialInvalid: "cloud-credential-invalid",
} as const;
