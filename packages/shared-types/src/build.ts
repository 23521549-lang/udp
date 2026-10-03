import { z } from "zod";

/**
 * [Plan #61 QĐ-9] Cài đặt build của một project (`projects.build_settings`) — schema DUY NHẤT cho dây, database và
 * Portal. Luật ký tự ở đây là luật của template pipeline: mọi chuỗi đi vào sáu cú pháp (YAML, Groovy, shell) mà không
 * phải thoát ký tự (`@udp/adapter-core` dùng lại đúng các luật này khi vẽ).
 */

/** Ngôn ngữ của bước test và của dự đoán đóng gói */
export const BUILD_LANGUAGES = [
  "nodejs",
  "python",
  "go",
  "java-maven",
  "java-gradle",
  "dotnet",
  "ruby",
  "php",
  "static",
  "rust",
  "other",
] as const;
export type BuildLanguage = (typeof BUILD_LANGUAGES)[number];

/**
 * Ngôn ngữ mà builder Paketo Ubuntu 24.04 build được KHÔNG cần Dockerfile (`builder.toml` của nó: .NET, Go, Java,
 * Node.js, PHP, Python, Ruby, web-servers). Rust không có trong builder mặc định ⇒ cần Dockerfile.
 */
export const BUILDPACKS_LANGUAGES: readonly BuildLanguage[] = [
  "nodejs",
  "python",
  "go",
  "java-maven",
  "java-gradle",
  "dotnet",
  "ruby",
  "php",
  "static",
];

export const BUILD_STRATEGIES = ["auto", "dockerfile", "buildpacks"] as const;
export type BuildStrategyName = (typeof BUILD_STRATEGIES)[number];

/** Luật ký tự của mọi chuỗi kế hoạch build đi vào template */
export const BUILD_TEXT_RULES = {
  /** Đường dẫn tương đối (thư mục build, Dockerfile) — kiểm thêm "không `..`" bằng `isSafeBuildPath` */
  PATH: /^(\.|[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/,
  SERVER: /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{2,5})?$/,
  REGION: /^[a-z]{2}(-gov)?-[a-z]+-\d$/,
  ACR_NAME: /^[a-zA-Z0-9]{5,50}$/,
  AWS_ROLE_ARN:
    /^arn:aws(-cn|-us-gov)?:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/,
  GCP_PROVIDER:
    /^projects\/\d{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/,
  GCP_SERVICE_ACCOUNT:
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /** Lệnh test: không nháy, không backslash, không `%`, không xuống dòng, không backtick (đặt trong `sh -c "…"`) */
  COMMAND: /^[^"'\\%`\n\r]{1,500}$/,
  IMAGE:
    /^[a-z0-9][a-z0-9._\-/]*(:[A-Za-z0-9_.-]{1,128})?(@sha256:[0-9a-f]{64})?$/,
  /** [Plan #61 QĐ-14] URI khoá KMS mà cosign nhận — một dạng mỗi cloud */
  KMS_AWS:
    /^awskms:\/\/\/arn:aws:kms:[a-z0-9-]{4,30}:\d{12}:key\/[0-9a-f-]{36}$/,
  KMS_GCP:
    /^gcpkms:\/\/projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{2,40}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/versions\/\d{1,4}$/,
  KMS_AZURE:
    /^azurekms:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/[A-Za-z0-9-]{1,127}$/,
  /** Khoá CÔNG KHAI dạng PEM — khoá bí mật (`BEGIN … PRIVATE KEY`) không khớp */
  PUBLIC_KEY_PEM:
    /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]{40,800}\n-----END PUBLIC KEY-----\n?$/,
} as const;

/** Đường dẫn tương đối, không `..`, không tuyệt đối */
export const isSafeBuildPath = (path: string): boolean =>
  BUILD_TEXT_RULES.PATH.test(path) && !path.split("/").includes("..");

const buildPath = z
  .string()
  .max(200)
  .refine(
    isSafeBuildPath,
    "Đường dẫn tương đối, không có .. hay ký tự đặc biệt",
  );

/**
 * Danh tính build trong cloud của khách — CHỈ mã định danh, không bí mật: lấy được mật khẩu registry phải có JWT của
 * đúng CI (QĐ-6). Mỗi trường khớp đúng định dạng của nó, nên không dán nhầm một khoá vào đây được.
 */
export const buildIdentitySchema = z.discriminatedUnion("cloud", [
  z
    .object({
      cloud: z.literal("aws"),
      roleArn: z.string().regex(BUILD_TEXT_RULES.AWS_ROLE_ARN),
    })
    .strict(),
  z
    .object({
      cloud: z.literal("gcp"),
      workloadIdentityProvider: z.string().regex(BUILD_TEXT_RULES.GCP_PROVIDER),
      serviceAccount: z.string().regex(BUILD_TEXT_RULES.GCP_SERVICE_ACCOUNT),
    })
    .strict(),
  z
    .object({
      cloud: z.literal("azure"),
      clientId: z.string().regex(BUILD_TEXT_RULES.UUID),
      tenantId: z.string().regex(BUILD_TEXT_RULES.UUID),
    })
    .strict(),
]);
export type BuildIdentityInput = z.infer<typeof buildIdentitySchema>;

/** Cloud của một URI khoá KMS — `null` khi không phải dạng nào của ba cloud */
export function kmsCloudOf(uri: string): "aws" | "gcp" | "azure" | null {
  if (BUILD_TEXT_RULES.KMS_AWS.test(uri)) return "aws";
  if (BUILD_TEXT_RULES.KMS_GCP.test(uri)) return "gcp";
  if (BUILD_TEXT_RULES.KMS_AZURE.test(uri)) return "azure";
  return null;
}

const kmsUri = z
  .string()
  .max(300)
  .refine((uri) => kmsCloudOf(uri) !== null, "URI khoá KMS không đúng dạng");

/**
 * [Plan #61 QĐ-14] Khoá ký của project: khoá bí mật ở KMS của cloud, UDP chỉ giữ khoá CÔNG KHAI (kiểm chữ ký) và URI
 * (pipeline gọi KMS ký). `id` (dấu vân tay) và `addedAt` do Service 1 điền khi lưu.
 */
export const signingKeySchema = z
  .object({
    id: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional(),
    publicKey: z.string().regex(BUILD_TEXT_RULES.PUBLIC_KEY_PEM),
    kms: kmsUri,
    addedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type SigningKey = z.infer<typeof signingKeySchema>;

/**
 * Ký image: khoá MỚI NHẤT (đầu danh sách) ký, mọi khoá trong danh sách được chấp nhận khi kiểm — xoay khoá không gián
 * đoạn. `compat`: thêm chữ ký simple signing cho podman/CRI-O. `enforce`: thiếu chữ ký thì không deploy — Service 1 tự
 * bật khi nhận chữ ký hợp lệ đầu tiên; bật/tắt tay là thao tác riêng (`PUT /build/signing-enforce`), lưu cài đặt build
 * giữ nguyên giá trị đang có.
 */
export const buildSigningSchema = z
  .object({
    keys: z.array(signingKeySchema).max(5).default([]),
    compat: z.boolean().default(true),
    enforce: z.boolean().default(false),
  })
  .strict();

/**
 * Dòng `UDP_BUILD_IDENTITY=…` mà script danh tính in: danh tính và, khi script tạo khoá ký, `signing` — Portal tách:
 * danh tính vào `identity`, khoá vào đầu `signing.keys`.
 */
const lineSigning = z
  .object({
    key: kmsUri,
    publicKey: z.string().regex(BUILD_TEXT_RULES.PUBLIC_KEY_PEM),
  })
  .strict()
  .optional();
const [awsIdentity, gcpIdentity, azureIdentity] = buildIdentitySchema.options;
export const identityLineSchema = z.discriminatedUnion("cloud", [
  awsIdentity.extend({ signing: lineSigning }),
  gcpIdentity.extend({ signing: lineSigning }),
  azureIdentity.extend({ signing: lineSigning }),
]);
export type IdentityLine = z.infer<typeof identityLineSchema>;

/** `PUT /projects/:id/build/signing-enforce` — bật/tắt chế độ bắt buộc chữ ký (MAINTAINER, có nhật ký) */
export const signingEnforceSchema = z.object({ enforce: z.boolean() }).strict();

/** [Plan #61 QĐ-16] Lý do cổng deploy từ chối một image */
export const SIGNATURE_REJECTIONS = [
  "SIGNATURE_MISSING",
  "SIGNATURE_INVALID",
  "SIGNATURE_MISMATCH",
  "SIGNATURE_STALE",
] as const;
export type SignatureRejection = (typeof SIGNATURE_REJECTIONS)[number];

/**
 * [Plan #61 QĐ-17, 61d-2a] Lý do Trusted Deploy từ chối một lời báo (AC-11).
 *
 * Cố ý KHÔNG vào `ERROR_CATALOG`, cùng lý lẽ với `SIGNATURE_REJECTIONS`: catalog là 25 mã mà Portal hiển
 * thị cho người dùng, nó không có mã 401 hay 403 nào, và `problem.ts` kiểm số mã LÚC NẠP MODULE nên thêm
 * một mã là sửa năm chỗ và làm service sập nếu quên. Đây là phán quyết của một cổng xác thực, đi theo
 * đường của nó: `metadata` của lần deploy, rồi lên dây ở một trường RIÊNG.
 *
 * Trường riêng chứ không nhồi vào enum `signature`: hai cổng chứng minh hai thứ khác nhau — chữ ký image
 * chứng minh BYTE được deploy, Trusted Deploy chứng minh LƯỢT CHẠY là thật — và nhồi chung sẽ lặng lẽ đổi
 * ngữ nghĩa của danh sách deployment và của DORA.
 *
 * Phân biệt hai họ lý do, vì chúng có mã HTTP khác nhau: lỗi của token hay claim là TERMINAL (401 — không
 * lớp retry nào thử lại, và đúng vậy), còn lỗi hạ tầng là RETRYABLE (503 — để `curl --retry` của bước báo
 * và runner tự lành; trả 401 cho một lần JWKS không với tới là một lỗi không bao giờ tự khỏi).
 */
/**
 * [Plan #61 61d-2b-1] Ba CI chạy TRONG CỤM của project.
 *
 * Ở `@udp/shared-types` vì cả Service 1 và Portal cần đúng tập này: Service 1 để chọn đường xác minh theo
 * cụm, Portal để nói ra bậc bảo đảm yếu hơn ("không chứng minh nhánh"). Một bản chép thứ hai trong Portal
 * sẽ trôi khỏi bản của backend đúng vào ngày thêm CI thứ bảy.
 *
 * `packages/design-lint/tests/trusted-deploy-providers.test.ts` ghim dòng này đối chiếu §8.3.
 */
export const IN_CLUSTER_CI = ["jenkins", "tekton", "drone"] as const;

export const TRUSTED_DEPLOY_REJECTIONS = [
  /** `oidcRequired` đã bật mà lời báo không mang `Authorization` */
  "TOKEN_MISSING",
  /** Header có mà không phải một JWT ba phần, hay quá dài */
  "TOKEN_MALFORMED",
  /** Chữ ký sai, thuật toán không được ghim, hay JWKS không có khoá khớp */
  "TOKEN_INVALID",
  /** `iss` không bằng issuer suy từ cấu hình của project — chặn trước mọi lời gọi mạng */
  "TOKEN_ISSUER_UNEXPECTED",
  /** `aud` không bằng địa chỉ webhook tuyệt đối của chính project này */
  "TOKEN_AUDIENCE_MISMATCH",
  /** `exp` đã qua, `nbf` chưa tới, hay `iat` cũ hơn trần chính sách */
  "TOKEN_EXPIRED",
  /** Claim của token lệch cấu hình: repo, nhánh, hay environment không được phép */
  "TOKEN_CLAIM_MISMATCH",
  /** Token đã dùng rồi, và thân lần này KHÁC lần đầu — một lượt replay, không phải retry */
  "TOKEN_REPLAYED",
  /** Không lấy được khoá công khai của nơi phát, kể cả bản đã cache — HẠ TẦNG, retryable */
  "TOKEN_KEYS_UNAVAILABLE",
] as const;
export type TrustedDeployRejection = (typeof TRUSTED_DEPLOY_REJECTIONS)[number];

/** Lý do thuộc hạ tầng ⇒ 503 và retryable; mọi lý do khác là terminal ⇒ 401 */
export const TRUSTED_DEPLOY_RETRYABLE: readonly TrustedDeployRejection[] = [
  "TOKEN_KEYS_UNAVAILABLE",
];

/** `PUT /projects/:id/domains/CICD/oidc-required` — bật/tắt Trusted Deploy (MAINTAINER, có nhật ký) */
export const oidcRequiredSchema = z.object({ required: z.boolean() }).strict();

/** Bước test: mặc định theo ngôn ngữ, lệnh tự khai, hay tắt tường minh */
export const buildTestSettingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z
    .object({
      mode: z.literal("custom"),
      command: z.string().regex(BUILD_TEXT_RULES.COMMAND),
      image: z.string().regex(BUILD_TEXT_RULES.IMAGE),
    })
    .strict(),
  z.object({ mode: z.literal("none") }).strict(),
]);

export const buildSettingsSchema = z
  .object({
    strategy: z.enum(BUILD_STRATEGIES).default("auto"),
    context: buildPath.default("."),
    dockerfile: buildPath
      .refine((p) => p !== ".", "Tên tệp Dockerfile")
      .default("Dockerfile"),
    /** `null` = suy từ lần quét repo hay runtime của project */
    language: z.enum(BUILD_LANGUAGES).nullable().default(null),
    test: buildTestSettingSchema.default({ mode: "default" }),
    identity: buildIdentitySchema.nullable().default(null),
    signing: buildSigningSchema.default({}),
  })
  .strict();
export type BuildSettings = z.infer<typeof buildSettingsSchema>;

export const DEFAULT_BUILD_SETTINGS: BuildSettings = buildSettingsSchema.parse(
  {},
);

/** Giờ chạy hằng ngày (UTC) của lượt rebase theo lịch */
export interface RebaseSchedule {
  hour: number;
  minute: number;
  /** Biểu thức cron năm trường `phút giờ * * *` */
  cron: string;
}

/**
 * [Plan #61 QĐ-13] Lịch rebase của project — `null` khi chiến lược ghim Dockerfile (chỉ image Buildpacks rebase được).
 * Giờ tất định theo slug (FNV-1a) trong 01:00–06:59 UTC để rải tải giữa các project; phút khác 0 vì GitHub trễ lịch
 * đầu giờ. Service 1 (pipeline, mục Đóng gói) và bản xem thử của Portal tính CÙNG một hàm.
 */
export function rebaseScheduleOf(
  plan: { strategy: BuildStrategyName },
  projectSlug: string,
): RebaseSchedule | null {
  if (plan.strategy === "dockerfile") return null;
  let hash = 0x811c9dc5;
  for (const char of projectSlug) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  const minute = 1 + (hash % 59);
  const hour = 1 + (Math.floor(hash / 59) % 6);
  return { hour, minute, cron: `${String(minute)} ${String(hour)} * * *` };
}
