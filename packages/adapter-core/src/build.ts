import type { CapabilityBinding } from "@udp/shared-types";

/**
 * [Plan #61 QĐ-2, QĐ-3] Kế hoạch build image của một project — dữ liệu THUẦN: Service 1 dựng nó (cài đặt build
 * của project, binding `registry.oci`, danh tính build), sáu CI/CD adapter chỉ VẼ nó theo cú pháp của mình.
 *
 * Đi vào `PipelineTemplateParams.build` — một MỞ RỘNG BỐI CẢNH như `environments` của D-P29: không đổi tên, không
 * thêm phương thức của `CicdDomainAdapter`.
 */

/** `auto`: có Dockerfile ⇒ BuildKit, không có ⇒ Buildpacks — quyết định LÚC PIPELINE CHẠY (QĐ-4) */
export type BuildStrategy = "auto" | "dockerfile" | "buildpacks";
export const BUILD_STRATEGIES: readonly BuildStrategy[] = [
  "auto",
  "dockerfile",
  "buildpacks",
];

/**
 * Cách pipeline đăng nhập registry để ĐẨY (QĐ-6). Registry khai bằng thuộc tính `pushAuth` của binding
 * `registry.oci`; `server` là máy chủ như `docker login` dùng.
 */
export type RegistryPush =
  | { kind: "basic"; server: string }
  | { kind: "github-token"; server: string }
  | { kind: "aws-ecr"; server: string; region: string }
  | { kind: "gcp"; server: string }
  | { kind: "azure-acr"; server: string; registryName: string };
export type RegistryPushKind = RegistryPush["kind"];
export const REGISTRY_PUSH_KINDS: readonly RegistryPushKind[] = [
  "basic",
  "github-token",
  "aws-ecr",
  "gcp",
  "azure-acr",
];

/** Registry của cloud — đẩy bằng danh tính build, không bằng khoá */
export const CLOUD_PUSH_KINDS: readonly RegistryPushKind[] = [
  "aws-ecr",
  "gcp",
  "azure-acr",
];

/**
 * Mã định danh KHÔNG bí mật của danh tính build trong cloud của khách — in ra bởi script mà chủ tài khoản chạy một
 * lần (QĐ-6). Không mang khoá: lấy được mật khẩu registry phải có JWT của đúng CI.
 */
export type BuildIdentity =
  | { cloud: "aws"; roleArn: string }
  | {
      cloud: "gcp";
      /** `projects/<số>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` */
      workloadIdentityProvider: string;
      serviceAccount: string;
    }
  | { cloud: "azure"; clientId: string; tenantId: string };
export type BuildIdentityCloud = BuildIdentity["cloud"];

/** Cloud mà một kiểu đẩy cần danh tính — `null` cho registry không phải của cloud */
export function identityCloudOf(
  kind: RegistryPushKind,
): BuildIdentityCloud | null {
  switch (kind) {
    case "aws-ecr":
      return "aws";
    case "gcp":
      return "gcp";
    case "azure-acr":
      return "azure";
    default:
      return null;
  }
}

/** Bước test (QĐ-9): chạy lệnh, tắt tường minh, hay chưa có lệnh ⇒ dừng pipeline với lời nhắn */
export type BuildTest =
  | { kind: "run"; command: string; image: string }
  | { kind: "skip" }
  | { kind: "missing"; language: string };

export interface BuildPlan {
  strategy: BuildStrategy;
  /** Thư mục build, tương đối với gốc repo — `.` mặc định */
  context: string;
  /** Dockerfile, tương đối với `context` */
  dockerfile: string;
  /** `linux/amd64` — kiến trúc node mà UDP dựng (QĐ-11) */
  platform: string;
  push: RegistryPush;
  /** Bắt buộc với registry của cloud; thiếu thì bước đăng nhập dừng với lời nhắn */
  identity: BuildIdentity | null;
  test: BuildTest;
}

/** Thuộc tính của binding `registry.oci` ⇒ cách đẩy. Thiếu hay sai ⇒ `null` (Service 1 báo áp lại domain registry) */
export function registryPushOf(
  binding: Pick<CapabilityBinding, "endpoint" | "attributes"> | undefined,
): RegistryPush | null {
  const endpoint = binding?.endpoint;
  const attributes = binding?.attributes ?? {};
  if (endpoint === undefined) return null;
  const server = registryServerOf(endpoint);
  switch (attributes.pushAuth) {
    case "basic":
    case "github-token":
    case "gcp":
      return { kind: attributes.pushAuth, server };
    case "aws-ecr":
      return attributes.region === undefined
        ? null
        : { kind: "aws-ecr", server, region: attributes.region };
    case "azure-acr":
      return attributes.registryName === undefined
        ? null
        : {
            kind: "azure-acr",
            server,
            registryName: attributes.registryName,
          };
    default:
      return null;
  }
}

/** `ghcr.io/acme` ⇒ `ghcr.io`; `nexus.acme.vn:8443/x` ⇒ `nexus.acme.vn:8443` */
export const registryServerOf = (endpoint: string): string =>
  endpoint.split("/")[0] ?? endpoint;

// --------------------------------------------------------------------- an toàn khi đi vào template

/**
 * Mọi chuỗi của kế hoạch đi vào sáu cú pháp (YAML, Groovy ba nháy đơn, `sh -ec '…'`, chỗ trống `%TÊN%`). Cùng luật
 * với bước của domain khác (D-P28): cấm ký tự thì không phải thoát ở đâu cả.
 */
const PATH =
  /^(\.|[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)$/;
const SERVER = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{2,5})?$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const ACR_NAME = /^[a-zA-Z0-9]{5,50}$/;
const AWS_ROLE_ARN =
  /^arn:aws(-cn|-us-gov)?:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;
const GCP_PROVIDER =
  /^projects\/\d{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
const GCP_SERVICE_ACCOUNT =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Lệnh test: không nháy, không backslash, không `%`, không xuống dòng, không backtick (đặt trong `sh -c "…"`) */
const COMMAND = /^[^"'\\%`\n\r]{1,500}$/;
const IMAGE =
  /^[a-z0-9][a-z0-9._\-/]*(:[A-Za-z0-9_.-]{1,128})?(@sha256:[0-9a-f]{64})?$/;

export const BUILD_TEXT_RULES = {
  PATH,
  SERVER,
  REGION,
  ACR_NAME,
  AWS_ROLE_ARN,
  GCP_PROVIDER,
  GCP_SERVICE_ACCOUNT,
  UUID,
  COMMAND,
  IMAGE,
} as const;

export class BuildPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildPlanError";
  }
}

const check = (ok: boolean, message: string): void => {
  if (!ok) throw new BuildPlanError(message);
};

/** Đường dẫn tương đối, không `..`, không tuyệt đối */
export const isSafeBuildPath = (path: string): boolean =>
  PATH.test(path) && !path.split("/").includes("..");

/** Ném `BuildPlanError` khi một chuỗi của kế hoạch không an toàn cho template — renderer gọi trước khi vẽ */
export function assertBuildPlanSafe(plan: BuildPlan): void {
  check(
    BUILD_STRATEGIES.includes(plan.strategy),
    `chiến lược lạ: ${plan.strategy}`,
  );
  check(
    isSafeBuildPath(plan.context),
    `thư mục build không an toàn: ${plan.context}`,
  );
  check(
    isSafeBuildPath(plan.dockerfile) && plan.dockerfile !== ".",
    `đường Dockerfile không an toàn: ${plan.dockerfile}`,
  );
  check(
    /^linux\/(amd64|arm64)$/.test(plan.platform),
    `nền tảng lạ: ${plan.platform}`,
  );
  check(
    SERVER.test(plan.push.server),
    `máy chủ registry lạ: ${plan.push.server}`,
  );
  if (plan.push.kind === "aws-ecr") {
    check(REGION.test(plan.push.region), `region lạ: ${plan.push.region}`);
  }
  if (plan.push.kind === "azure-acr") {
    check(ACR_NAME.test(plan.push.registryName), "tên ACR lạ");
  }
  const id = plan.identity;
  if (id !== null) {
    const wanted = identityCloudOf(plan.push.kind);
    check(
      wanted === null || wanted === id.cloud,
      `danh tính ${id.cloud} không đẩy được vào registry ${plan.push.kind}`,
    );
    if (id.cloud === "aws")
      check(AWS_ROLE_ARN.test(id.roleArn), "ARN vai trò lạ");
    if (id.cloud === "gcp") {
      check(GCP_PROVIDER.test(id.workloadIdentityProvider), "provider GCP lạ");
      check(GCP_SERVICE_ACCOUNT.test(id.serviceAccount), "service account lạ");
    }
    if (id.cloud === "azure") {
      check(UUID.test(id.clientId) && UUID.test(id.tenantId), "id Azure lạ");
    }
  }
  if (plan.test.kind === "run") {
    check(
      COMMAND.test(plan.test.command),
      "lệnh test mang ký tự không an toàn",
    );
    check(IMAGE.test(plan.test.image), `image test lạ: ${plan.test.image}`);
  }
  if (plan.test.kind === "missing") {
    check(/^[a-z0-9-]{1,40}$/.test(plan.test.language), "ngôn ngữ lạ");
  }
}
