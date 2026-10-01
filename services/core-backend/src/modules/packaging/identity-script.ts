import type { BuildIdentityCloud, RegistryPush } from "@udp/adapter-core";
import {
  BUILD_NAMESPACE,
  BUILDER_SERVICE_ACCOUNT,
  effectivePush,
  oidcAudience,
  type CiTool,
} from "../adapter-base/packaging/build-script.js";

/**
 * [Plan #61 QĐ-6] Script danh tính build — chủ tài khoản cloud chạy MỘT lần (CloudShell), không phải UDP.
 *
 * Vì sao script mà không phải nút bấm: tạo nhà cung cấp OIDC và vai trò tin một bên thứ ba (GitHub, GitLab, CircleCI)
 * là mở cửa tài khoản cloud của khách; người làm việc đó phải là chủ tài khoản, bằng quyền của họ, đọc được từng dòng.
 * Vai trò BYOC của UDP không cần thêm quyền IAM nào.
 *
 * Mỗi project một bộ riêng: vai trò `udp-build-<slug>` (AWS), pool Workload Identity `udp-<slug>` (GCP — pool tách
 * theo project vì mọi cluster có cùng chủ thể `system:serviceaccount:udp-build:udp-builder`), managed identity
 * `udp-build-<slug>` (Azure). Chỉ tin đúng chủ thể của CI (repo, project, nhánh của các environment, hay SA build của
 * cluster), chỉ được đẩy vào đúng repository image. Chạy lại an toàn: tạo thứ chưa có, đưa quyền về đúng mô tả.
 *
 * Giá trị chèn vào script đều đã qua regex của cấu hình (adapter registry, adapter CI) — không có gì phải thoát.
 */

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

export type CiIdentityConfig =
  | { kind: "github-actions"; repository: string }
  | { kind: "gitlab-ci"; projectPath: string; gitlabUrl: string }
  | {
      kind: "circleci";
      organizationId: string | null;
      projectId: string | null;
    }
  | { kind: "in-cluster"; tool: "jenkins" | "tekton" | "drone" };

/** Cluster của project (hàng `cluster` READY của sổ tài nguyên) — cho CI chạy trong cluster */
export interface ClusterRef {
  provider: "aws" | "gcp" | "azure";
  /** EKS: tên; GKE: tên; AKS: ARM id đầy đủ */
  providerId: string;
  region: string;
}

export interface IdentityScriptInput {
  slug: string;
  push: RegistryPush;
  /** Endpoint của binding `registry.oci` — mang tài khoản/project/repository của registry */
  registryEndpoint: string;
  ci: CiIdentityConfig;
  /** `main` và nhánh của các environment khác — chủ thể của CI chỉ được là các nhánh này */
  branches: readonly string[];
  cluster: ClusterRef | null;
}

/** Không sinh được script — mã để Portal nói việc cần làm */
export type IdentityScriptProblem =
  "NOT_CLOUD_REGISTRY" | "CIRCLECI_IDS" | "NO_CLUSTER" | "CLUSTER_OTHER_CLOUD";

export type IdentityScriptResult =
  | { ok: true; cloud: BuildIdentityCloud; text: string }
  | { ok: false; problem: IdentityScriptProblem };

const ciTool = (ci: CiIdentityConfig): CiTool =>
  ci.kind === "in-cluster" ? ci.tool : ci.kind;

/** Tên tài nguyên ≤ `max` ký tự, kết thúc bằng chữ hay số */
function nameOf(prefix: string, slug: string, max: number): string {
  return `${prefix}${slug}`.slice(0, max).replace(/-+$/, "");
}

export function identityScript(
  input: IdentityScriptInput,
): IdentityScriptResult {
  const push = effectivePush(input.push, ciTool(input.ci));
  if (input.ci.kind === "circleci" && push.kind !== "basic") {
    if (input.ci.organizationId === null || input.ci.projectId === null) {
      return { ok: false, problem: "CIRCLECI_IDS" };
    }
  }
  const cloud =
    push.kind === "aws-ecr"
      ? "aws"
      : push.kind === "gcp"
        ? "gcp"
        : push.kind === "azure-acr"
          ? "azure"
          : null;
  if (cloud === null) return { ok: false, problem: "NOT_CLOUD_REGISTRY" };
  if (input.ci.kind === "in-cluster") {
    if (input.cluster === null) return { ok: false, problem: "NO_CLUSTER" };
    if (input.cluster.provider !== cloud) {
      return { ok: false, problem: "CLUSTER_OTHER_CLOUD" };
    }
  }
  const text =
    cloud === "aws"
      ? awsScript(input, push as Extract<RegistryPush, { kind: "aws-ecr" }>)
      : cloud === "gcp"
        ? gcpScript(input)
        : azureScript(
            input,
            push as Extract<RegistryPush, { kind: "azure-acr" }>,
          );
  return { ok: true, cloud, text: text.join("\n") + "\n" };
}

const header = (input: IdentityScriptInput, where: string): string[] => [
  "#!/usr/bin/env bash",
  `# UDP — danh tính build của ${input.slug} (Plan #61). Chạy MỘT lần ${where} bằng quyền quản trị.`,
  "# Chạy lại an toàn: chỉ tạo thứ chưa có và đưa quyền về đúng mô tả dưới đây. Không tạo khoá nào.",
  "set -euo pipefail",
  "",
];

// -------------------------------------------------------------------------------------------- AWS

function awsScript(
  input: IdentityScriptInput,
  push: Extract<RegistryPush, { kind: "aws-ecr" }>,
): string[] {
  const account = push.server.split(".")[0] ?? "";
  const prefix = input.registryEndpoint.split("/").slice(1).join("/");
  const repository = prefix === "" ? input.slug : `${prefix}/${input.slug}`;
  const role = nameOf("udp-build-", input.slug, 64);
  const ci = input.ci;
  const subjects = awsSubjects(input);
  return [
    ...header(input, `trong AWS CloudShell của tài khoản ${account}`),
    `ACCOUNT=${account}`,
    `REGION=${push.region}`,
    `REPOSITORY=${repository}`,
    `ROLE=${role}`,
    "",
    "# 1. Repository ECR (ECR không tự tạo khi đẩy; thẻ đổi được — cache và rebase đẩy lại cùng thẻ)",
    'aws ecr describe-repositories --region "$REGION" --repository-names "$REPOSITORY" >/dev/null 2>&1 ||',
    '  aws ecr create-repository --region "$REGION" --repository-name "$REPOSITORY" --image-scanning-configuration scanOnPush=true >/dev/null',
    "",
    ...(ci.kind === "in-cluster" && input.cluster !== null
      ? [
          "# 2. Nhà cung cấp OIDC của cluster (UDP đã tạo cho IRSA khi dựng EKS)",
          `ISSUER=$(aws eks describe-cluster --region ${input.cluster.region} --name ${input.cluster.providerId} --query cluster.identity.oidc.issuer --output text)`,
          'ISSUER_HOST="${ISSUER#https://}"',
          'PROVIDER_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/$ISSUER_HOST"',
        ]
      : [
          `# 2. Nhà cung cấp OIDC của ${ciLabel(ci)}`,
          `ISSUER_HOST=${awsIssuerHost(ci)}`,
          'PROVIDER_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/$ISSUER_HOST"',
          'if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then',
          '  aws iam create-open-id-connect-provider --url "https://$ISSUER_HOST" --client-id-list sts.amazonaws.com >/dev/null',
          "fi",
          'aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" --client-id sts.amazonaws.com 2>/dev/null || true',
        ]),
    "",
    "# 3. Vai trò chỉ tin đúng chủ thể của CI, chỉ được đẩy vào đúng repository",
    "cat > /tmp/udp-trust.json <<JSON",
    `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"$PROVIDER_ARN"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"$ISSUER_HOST:aud":"sts.amazonaws.com"},"StringLike":{"$ISSUER_HOST:sub":${JSON.stringify(subjects)}}}}]}`,
    "JSON",
    'if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then',
    '  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document file:///tmp/udp-trust.json',
    "else",
    '  aws iam create-role --role-name "$ROLE" --path /udp/ --assume-role-policy-document file:///tmp/udp-trust.json >/dev/null',
    "fi",
    "cat > /tmp/udp-push.json <<JSON",
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},{"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:BatchGetImage","ecr:CompleteLayerUpload","ecr:DescribeImages","ecr:GetDownloadUrlForLayer","ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart"],"Resource":"arn:aws:ecr:$REGION:$ACCOUNT:repository/$REPOSITORY"}]}',
    "JSON",
    'aws iam put-role-policy --role-name "$ROLE" --policy-name udp-build-push --policy-document file:///tmp/udp-push.json',
    "",
    "# 4. Dán dòng dưới vào mục Đóng gói của UDP",
    'echo "UDP_BUILD_IDENTITY={\\"cloud\\":\\"aws\\",\\"roleArn\\":\\"arn:aws:iam::$ACCOUNT:role/udp/$ROLE\\"}"',
  ];
}

function awsIssuerHost(ci: CiIdentityConfig): string {
  switch (ci.kind) {
    case "github-actions":
      return GITHUB_ISSUER.replace("https://", "");
    case "gitlab-ci":
      return ci.gitlabUrl.replace("https://", "");
    case "circleci":
      return `oidc.circleci.com/org/${ci.organizationId ?? ""}`;
    case "in-cluster":
      return "";
  }
}

/** Chủ thể JWT được tin — AWS cho `*` trong `StringLike` */
function awsSubjects(input: IdentityScriptInput): string[] {
  const ci = input.ci;
  switch (ci.kind) {
    case "github-actions":
      return input.branches.map(
        (b) => `repo:${ci.repository}:ref:refs/heads/${b}`,
      );
    case "gitlab-ci":
      return input.branches.map(
        (b) => `project_path:${ci.projectPath}:ref_type:branch:ref:${b}`,
      );
    case "circleci":
      return [
        `org/${ci.organizationId ?? ""}/project/${ci.projectId ?? ""}/user/*`,
      ];
    case "in-cluster":
      return [inClusterSubject()];
  }
}

const inClusterSubject = (): string =>
  `system:serviceaccount:${BUILD_NAMESPACE}:${BUILDER_SERVICE_ACCOUNT}`;

function ciLabel(ci: CiIdentityConfig): string {
  switch (ci.kind) {
    case "github-actions":
      return `GitHub Actions (repo ${ci.repository})`;
    case "gitlab-ci":
      return `GitLab CI (project ${ci.projectPath})`;
    case "circleci":
      return `CircleCI (project ${ci.projectId ?? ""})`;
    case "in-cluster":
      return `${ci.tool} trong cluster`;
  }
}

// -------------------------------------------------------------------------------------------- GCP

function gcpScript(input: IdentityScriptInput): string[] {
  // `<location>-docker.pkg.dev/<project>/<repository>`
  const [host, project = "", repository = ""] =
    input.registryEndpoint.split("/");
  const location = (host ?? "").replace(/-docker\.pkg\.dev$/, "");
  const pool = nameOf("udp-", input.slug, 32);
  const ci = input.ci;
  const provider = ci.kind === "in-cluster" ? "cluster" : gcpProviderId(ci);
  const sa = nameOf("udp-build-", input.slug, 30);
  const issuer =
    ci.kind === "in-cluster" && input.cluster !== null
      ? `https://container.googleapis.com/v1/projects/$CLUSTER_PROJECT/locations/${input.cluster.region}/clusters/${input.cluster.providerId}`
      : gcpIssuer(ci);
  return [
    ...header(input, `trong Cloud Shell của Google Cloud project ${project}`),
    `PROJECT=${project}`,
    `LOCATION=${location}`,
    `REPOSITORY=${repository}`,
    `POOL=${pool}`,
    `PROVIDER=${provider}`,
    `SA_ID=${sa}`,
    'SA="$SA_ID@$PROJECT.iam.gserviceaccount.com"',
    ...(ci.kind === "in-cluster"
      ? [
          "# Cluster mặc định cùng project với registry; khác thì đặt CLUSTER_PROJECT trước khi chạy",
          'CLUSTER_PROJECT="${CLUSTER_PROJECT:-$PROJECT}"',
        ]
      : []),
    'PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format="value(projectNumber)")',
    "",
    "# 1. Pool Workload Identity RIÊNG của project này",
    'gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT" --location global >/dev/null 2>&1 ||',
    `  gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT" --location global --display-name "UDP build ${input.slug}"`,
    "",
    `# 2. Nhà cung cấp OIDC: ${ci.kind === "in-cluster" ? `${ci.tool} trong cluster` : ciLabel(ci)} — chỉ nhận đúng chủ thể này`,
    "PROVIDER_ARGS=(",
    '  --project "$PROJECT" --location global --workload-identity-pool "$POOL"',
    `  --issuer-uri "${issuer}"`,
    `  --attribute-mapping "${gcpMapping(ci)}"`,
    `  --attribute-condition "${gcpCondition(input)}"`,
    ")",
    'if gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1; then',
    '  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}"',
    "else",
    '  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" "${PROVIDER_ARGS[@]}"',
    "fi",
    "",
    "# 3. Service account chỉ được ghi vào đúng repository; pool được mạo danh nó",
    'gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||',
    `  gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" --display-name "UDP build ${input.slug}"`,
    'gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --project "$PROJECT" --location "$LOCATION" --member "serviceAccount:$SA" --role roles/artifactregistry.writer >/dev/null',
    'gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" --role roles/iam.workloadIdentityUser --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/*" >/dev/null',
    "",
    "# 4. Dán dòng dưới vào mục Đóng gói của UDP",
    'echo "UDP_BUILD_IDENTITY={\\"cloud\\":\\"gcp\\",\\"workloadIdentityProvider\\":\\"projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER\\",\\"serviceAccount\\":\\"$SA\\"}"',
  ];
}

function gcpProviderId(
  ci: Exclude<CiIdentityConfig, { kind: "in-cluster" }>,
): string {
  return ci.kind === "github-actions"
    ? "github"
    : ci.kind === "gitlab-ci"
      ? "gitlab"
      : "circleci";
}

function gcpIssuer(ci: CiIdentityConfig): string {
  switch (ci.kind) {
    case "github-actions":
      return GITHUB_ISSUER;
    case "gitlab-ci":
      return ci.gitlabUrl;
    case "circleci":
      return `https://oidc.circleci.com/org/${ci.organizationId ?? ""}`;
    case "in-cluster":
      return "";
  }
}

function gcpMapping(ci: CiIdentityConfig): string {
  switch (ci.kind) {
    case "github-actions":
      return "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref";
    case "gitlab-ci":
      return "google.subject=assertion.sub,attribute.project_path=assertion.project_path,attribute.ref=assertion.ref";
    case "circleci":
      return "google.subject=assertion.sub,attribute.project_id=assertion['oidc.circleci.com/project-id']";
    case "in-cluster":
      return "google.subject=assertion.sub";
  }
}

/** Điều kiện CEL của provider — chỉ repo/project/nhánh của chính project này */
function gcpCondition(input: IdentityScriptInput): string {
  const ci = input.ci;
  const refs = (prefix: string): string =>
    `[${input.branches.map((b) => `'${prefix}${b}'`).join(", ")}]`;
  switch (ci.kind) {
    case "github-actions":
      return `assertion.repository=='${ci.repository}' && assertion.ref in ${refs("refs/heads/")}`;
    case "gitlab-ci":
      return `assertion.project_path=='${ci.projectPath}' && assertion.ref_type=='branch' && assertion.ref in ${refs("")}`;
    case "circleci":
      return `assertion['oidc.circleci.com/project-id']=='${ci.projectId ?? ""}'`;
    case "in-cluster":
      return `assertion.sub=='${inClusterSubject()}'`;
  }
}

// ------------------------------------------------------------------------------------------ Azure

function azureScript(
  input: IdentityScriptInput,
  push: Extract<RegistryPush, { kind: "azure-acr" }>,
): string[] {
  const name = nameOf("udp-build-", input.slug, 120);
  const ci = input.ci;
  const audience = oidcAudience({ cloud: "azure", clientId: "", tenantId: "" });
  return [
    ...header(input, "trong Azure Cloud Shell của subscription chứa registry"),
    `REGISTRY=${push.registryName}`,
    `NAME=${name}`,
    'ACR_ID=$(az acr show --name "$REGISTRY" --query id --output tsv)',
    'GROUP=$(az acr show --name "$REGISTRY" --query resourceGroup --output tsv)',
    "",
    "# 1. Managed identity của project",
    'az identity show --resource-group "$GROUP" --name "$NAME" >/dev/null 2>&1 ||',
    '  az identity create --resource-group "$GROUP" --name "$NAME" >/dev/null',
    'CLIENT_ID=$(az identity show --resource-group "$GROUP" --name "$NAME" --query clientId --output tsv)',
    'PRINCIPAL_ID=$(az identity show --resource-group "$GROUP" --name "$NAME" --query principalId --output tsv)',
    'TENANT_ID=$(az identity show --resource-group "$GROUP" --name "$NAME" --query tenantId --output tsv)',
    "",
    "# 2. Federated credential: Azure chỉ nhận chủ thể KHỚP ĐÚNG — mỗi nhánh một credential",
    "federate() {",
    '  az identity federated-credential show --resource-group "$GROUP" --identity-name "$NAME" --name "$1" >/dev/null 2>&1 ||',
    `    az identity federated-credential create --resource-group "$GROUP" --identity-name "$NAME" --name "$1" --issuer "$2" --subject "$3" --audiences ${audience} >/dev/null`,
    "}",
    ...(ci.kind === "in-cluster" && input.cluster !== null
      ? [
          `ISSUER=$(az aks show --ids "${input.cluster.providerId}" --query oidcIssuerProfile.issuerUrl --output tsv)`,
          `federate udp-builder "$ISSUER" "${inClusterSubject()}"`,
        ]
      : input.branches.map((b) =>
          ci.kind === "github-actions"
            ? `federate github-${b} ${GITHUB_ISSUER} "repo:${ci.repository}:ref:refs/heads/${b}"`
            : ci.kind === "gitlab-ci"
              ? `federate gitlab-${b} ${ci.gitlabUrl} "project_path:${ci.projectPath}:ref_type:branch:ref:${b}"`
              : "",
        )),
    "",
    "# 3. Quyền đẩy image vào đúng registry",
    'if [ "$(az role assignment list --assignee "$PRINCIPAL_ID" --role AcrPush --scope "$ACR_ID" --query "length(@)" --output tsv)" = "0" ]; then',
    '  az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role AcrPush --scope "$ACR_ID" >/dev/null',
    "fi",
    "",
    "# 4. Dán dòng dưới vào mục Đóng gói của UDP",
    'echo "UDP_BUILD_IDENTITY={\\"cloud\\":\\"azure\\",\\"clientId\\":\\"$CLIENT_ID\\",\\"tenantId\\":\\"$TENANT_ID\\"}"',
  ];
}
