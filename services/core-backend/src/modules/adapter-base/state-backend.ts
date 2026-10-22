import { z } from "zod";

/**
 * State của IaC chạy trong CI (Plan #37 QĐ-4) — UDP CẤU HÌNH backend, khách chọn bucket.
 *
 * Một state MỖI environment của MỖI project: khoá `udp/<project>/<environment>` — nhánh `dev` và
 * nhánh `main` không bao giờ ghi đè state của nhau. Khoá chống ghi đồng thời là của chính backend
 * (S3 `use_lockfile`, GCS và Azure Blob có sẵn) — không cần bảng DynamoDB riêng.
 *
 * Chứng thực cloud là việc của CI (OIDC federation hay biến bí mật): bước chỉ khai TÊN biến mà nó
 * cần đọc — không bao giờ giá trị.
 */

/** Đường dẫn tương đối trong repo — không `..`, không tuyệt đối */
export const repoPathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine((p) => !p.split("/").includes(".."), "không được ra ngoài repo");

const awsRegion = z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/);

export const stateBackendSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("s3"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    region: awsRegion,
  }),
  z.object({
    kind: z.literal("gcs"),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/),
  }),
  z.object({
    kind: z.literal("azurerm"),
    storageAccount: z.string().regex(/^[a-z0-9]{3,24}$/),
    container: z.string().regex(/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/),
    resourceGroup: z.string().regex(/^[A-Za-z0-9._()-]{1,90}$/),
  }),
]);

export type StateBackend = z.infer<typeof stateBackendSchema>;

/** Khoá state của một environment — shell mở rộng `$UDP_ENVIRONMENT` lúc chạy */
export const stateKey = (projectSlug: string): string =>
  `udp/${projectSlug}/$UDP_ENVIRONMENT`;

/** Biến chứng thực mà CI phải cung cấp để đọc/ghi state ở backend này */
export function backendCredentialEnv(backend: StateBackend): string[] {
  switch (backend.kind) {
    case "s3":
      return [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ];
    case "gcs":
      return ["GOOGLE_APPLICATION_CREDENTIALS"];
    case "azurerm":
      return [
        "ARM_CLIENT_ID",
        "ARM_TENANT_ID",
        "ARM_SUBSCRIPTION_ID",
        "ARM_USE_OIDC",
        "ARM_OIDC_TOKEN",
      ];
  }
}

/** Mô tả backend cho ConfigMap (đích drift) — không có gì bí mật trong đó */
export function describeBackend(backend: StateBackend): string {
  switch (backend.kind) {
    case "s3":
      return `s3://${backend.bucket} (${backend.region})`;
    case "gcs":
      return `gs://${backend.bucket}`;
    case "azurerm":
      return `azurerm://${backend.storageAccount}/${backend.container}`;
  }
}
