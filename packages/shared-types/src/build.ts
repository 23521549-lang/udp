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
  })
  .strict();
export type BuildSettings = z.infer<typeof buildSettingsSchema>;

export const DEFAULT_BUILD_SETTINGS: BuildSettings = buildSettingsSchema.parse(
  {},
);
