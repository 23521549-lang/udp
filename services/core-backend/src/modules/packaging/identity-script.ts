import {
  identityCloudOf,
  type BuildIdentityCloud,
  type RegistryPush,
} from "@udp/adapter-core";
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
 * [Plan #61 QĐ-14] Danh tính nằm ở cloud của CHÍNH project (credential đang dùng), không phải cloud của registry:
 * project dùng GHCR, Docker Hub, Harbor… vẫn ký được. Script tạo thêm khoá ký bất đối xứng trong KMS của cloud đó
 * (AWS KMS, Cloud KMS, Key Vault) và cấp quyền ký cho ĐÚNG danh tính trên ĐÚNG khoá; khoá bí mật không rời KMS, dòng
 * kết quả mang URI và khoá CÔNG KHAI. Phần đẩy registry chỉ có khi registry là của cloud đó.
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
  /**
   * [Plan #61 QĐ-14] Cloud của danh tính — đẩy registry của cloud đó và ký bằng khoá KMS ở `region` của project. `region`
   * `null`: project chưa có cloud — chỉ phần đẩy registry, không khoá ký (chưa ký được, mục ký nói lý do)
   */
  cloud: { provider: BuildIdentityCloud; region: string | null };
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
  "CIRCLECI_IDS" | "CIRCLECI_AZURE" | "NO_CLUSTER" | "CLUSTER_OTHER_CLOUD";

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
  const ci = input.ci;
  const cloud = input.cloud.provider;
  // Chủ thể JWT của CircleCI mang id người chạy; federated credential của Azure đòi khớp đúng (QĐ-14)
  if (ci.kind === "circleci" && cloud === "azure") {
    return { ok: false, problem: "CIRCLECI_AZURE" };
  }
  if (
    ci.kind === "circleci" &&
    (ci.organizationId === null || ci.projectId === null)
  ) {
    return { ok: false, problem: "CIRCLECI_IDS" };
  }
  if (ci.kind === "in-cluster") {
    if (input.cluster === null) return { ok: false, problem: "NO_CLUSTER" };
    if (input.cluster.provider !== cloud) {
      return { ok: false, problem: "CLUSTER_OTHER_CLOUD" };
    }
  }
  // Đẩy bằng danh tính chỉ khi registry là của CHÍNH cloud này; registry khác đẩy bằng secret của CI
  const push = effectivePush(input.push, ciTool(ci));
  const own = identityCloudOf(push.kind) === cloud;
  const text =
    cloud === "aws"
      ? awsScript(input, own && push.kind === "aws-ecr" ? push : null)
      : cloud === "gcp"
        ? gcpScript(input, own)
        : azureScript(input, own && push.kind === "azure-acr" ? push : null);
  return { ok: true, cloud, text: text.join("\n") + "\n" };
}

const header = (input: IdentityScriptInput, where: string): string[] => [
  "#!/usr/bin/env bash",
  `# UDP — danh tính build của ${input.slug} (Plan #61). Chạy MỘT lần ${where} bằng quyền quản trị.`,
  "# Chạy lại an toàn: chỉ tạo thứ chưa có và đưa quyền về đúng mô tả dưới đây.",
  ...(input.cloud.region === null
    ? []
    : [
        "# Không có khoá bí mật nào rời cloud: khoá ký nằm trong KMS, dòng kết quả chỉ mang URI và khoá CÔNG KHAI.",
      ]),
  "set -euo pipefail",
  "",
];

/**
 * Dòng kết quả: `jq` dựng JSON của danh tính (`args` là các `--arg`, `fields` là phần thân của object), thêm khoá ký khi
 * script tạo khoá (`key` là biểu thức shell của URI KMS)
 */
const resultLine = (
  args: string,
  fields: string,
  key: string | null,
): string[] => [
  "",
  "# Dán dòng dưới vào mục Đóng gói của UDP",
  key === null
    ? `printf "UDP_BUILD_IDENTITY=%s\\n" "$(jq -nc ${args} '{${fields}}')"`
    : `printf "UDP_BUILD_IDENTITY=%s\\n" "$(jq -nc ${args} --arg key "${key}" --rawfile pub /tmp/udp-sign.pem '{${fields},signing:{key:$key,publicKey:$pub}}')"`,
];

// -------------------------------------------------------------------------------------------- AWS

function awsScript(
  input: IdentityScriptInput,
  registry: Extract<RegistryPush, { kind: "aws-ecr" }> | null,
): string[] {
  const prefix = input.registryEndpoint.split("/").slice(1).join("/");
  const repository = prefix === "" ? input.slug : `${prefix}/${input.slug}`;
  const role = nameOf("udp-build-", input.slug, 64);
  const ci = input.ci;
  const subjects = awsSubjects(input);
  return [
    ...header(
      input,
      "trong AWS CloudShell của tài khoản chạy cụm UDP của project",
    ),
    "ACCOUNT=$(aws sts get-caller-identity --query Account --output text)",
    `ROLE=${role}`,
    ...(input.cloud.region === null
      ? []
      : [
          `REGION=${input.cloud.region}`,
          `KEY_ALIAS=alias/${nameOf("udp-sign-", input.slug, 250)}`,
        ]),
    ...(registry === null
      ? []
      : [
          `REGISTRY_REGION=${registry.region}`,
          `REPOSITORY=${repository}`,
          "",
          "# Repository ECR (ECR không tự tạo khi đẩy; thẻ đổi được — cache và rebase đẩy lại cùng thẻ)",
          'aws ecr describe-repositories --region "$REGISTRY_REGION" --repository-names "$REPOSITORY" >/dev/null 2>&1 ||',
          '  aws ecr create-repository --region "$REGISTRY_REGION" --repository-name "$REPOSITORY" --image-scanning-configuration scanOnPush=true >/dev/null',
        ]),
    "",
    ...(ci.kind === "in-cluster" && input.cluster !== null
      ? [
          "# Nhà cung cấp OIDC của cluster (UDP đã tạo cho IRSA khi dựng EKS)",
          `ISSUER=$(aws eks describe-cluster --region ${input.cluster.region} --name ${input.cluster.providerId} --query cluster.identity.oidc.issuer --output text)`,
          'ISSUER_HOST="${ISSUER#https://}"',
          'PROVIDER_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/$ISSUER_HOST"',
        ]
      : [
          `# Nhà cung cấp OIDC của ${ciLabel(ci)}`,
          `ISSUER_HOST=${awsIssuerHost(ci)}`,
          'PROVIDER_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/$ISSUER_HOST"',
          'if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then',
          '  aws iam create-open-id-connect-provider --url "https://$ISSUER_HOST" --client-id-list sts.amazonaws.com >/dev/null',
          "fi",
          'aws iam add-client-id-to-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" --client-id sts.amazonaws.com 2>/dev/null || true',
        ]),
    "",
    "# Vai trò chỉ tin đúng chủ thể của CI",
    "cat > /tmp/udp-trust.json <<JSON",
    `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"$PROVIDER_ARN"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"$ISSUER_HOST:aud":"sts.amazonaws.com"},"StringLike":{"$ISSUER_HOST:sub":${JSON.stringify(subjects)}}}}]}`,
    "JSON",
    'if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then',
    '  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document file:///tmp/udp-trust.json',
    "else",
    '  aws iam create-role --role-name "$ROLE" --path /udp/ --assume-role-policy-document file:///tmp/udp-trust.json >/dev/null',
    "fi",
    ...(registry === null
      ? []
      : [
          "# Chỉ được đẩy vào đúng repository",
          "cat > /tmp/udp-push.json <<JSON",
          '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},{"Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:BatchGetImage","ecr:CompleteLayerUpload","ecr:DescribeImages","ecr:GetDownloadUrlForLayer","ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart"],"Resource":"arn:aws:ecr:$REGISTRY_REGION:$ACCOUNT:repository/$REPOSITORY"}]}',
          "JSON",
          'aws iam put-role-policy --role-name "$ROLE" --policy-name udp-build-push --policy-document file:///tmp/udp-push.json',
        ]),
    ...(input.cloud.region === null
      ? []
      : [
          "",
          "# Khoá ký (Plan #61): ECDSA P-256 trong KMS; vai trò chỉ được ký và đọc khoá công khai của ĐÚNG khoá này",
          'KEY_ARN=$(aws kms describe-key --region "$REGION" --key-id "$KEY_ALIAS" --query KeyMetadata.Arn --output text 2>/dev/null || true)',
          'if [ -z "$KEY_ARN" ] || [ "$KEY_ARN" = None ]; then',
          `  KEY_ARN=$(aws kms create-key --region "$REGION" --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY --description "UDP: ky image cua ${input.slug}" --tags TagKey=udp.project,TagValue=${input.slug} --query KeyMetadata.Arn --output text)`,
          '  aws kms create-alias --region "$REGION" --alias-name "$KEY_ALIAS" --target-key-id "$KEY_ARN"',
          "fi",
          "cat > /tmp/udp-sign.json <<JSON",
          '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["kms:Sign","kms:GetPublicKey","kms:DescribeKey"],"Resource":"$KEY_ARN"}]}',
          "JSON",
          'aws iam put-role-policy --role-name "$ROLE" --policy-name udp-sign --policy-document file:///tmp/udp-sign.json',
          'aws kms get-public-key --region "$REGION" --key-id "$KEY_ARN" --query PublicKey --output text | base64 -d | openssl pkey -pubin -inform DER -outform PEM > /tmp/udp-sign.pem',
        ]),
    ...resultLine(
      '--arg role "arn:aws:iam::$ACCOUNT:role/udp/$ROLE"',
      'cloud:"aws",roleArn:$role',
      input.cloud.region === null ? null : "awskms:///$KEY_ARN",
    ),
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

function gcpScript(input: IdentityScriptInput, ownRegistry: boolean): string[] {
  // `<location>-docker.pkg.dev/<project>/<repository>`
  const [host, registryProject = "", repository = ""] =
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
    ...header(
      input,
      "trong Cloud Shell của Google Cloud project chạy cụm UDP của project",
    ),
    ...(ownRegistry
      ? [
          `PROJECT=${registryProject}`,
          `LOCATION=${location}`,
          `REPOSITORY=${repository}`,
        ]
      : [
          'PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"',
        ]),
    `POOL=${pool}`,
    `PROVIDER=${provider}`,
    `SA_ID=${sa}`,
    'SA="$SA_ID@$PROJECT.iam.gserviceaccount.com"',
    ...(input.cloud.region === null
      ? []
      : [
          `REGION=${input.cloud.region}`,
          `KEY=${nameOf("udp-sign-", input.slug, 63)}`,
        ]),
    ...(ci.kind === "in-cluster"
      ? [
          "# Cluster mặc định cùng project; khác thì đặt CLUSTER_PROJECT trước khi chạy",
          'CLUSTER_PROJECT="${CLUSTER_PROJECT:-$PROJECT}"',
        ]
      : []),
    'PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format="value(projectNumber)")',
    "",
    "# Pool Workload Identity RIÊNG của project này",
    'gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT" --location global >/dev/null 2>&1 ||',
    `  gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT" --location global --display-name "UDP build ${input.slug}"`,
    "",
    `# Nhà cung cấp OIDC: ${ci.kind === "in-cluster" ? `${ci.tool} trong cluster` : ciLabel(ci)} — chỉ nhận đúng chủ thể này`,
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
    "# Service account của project; pool được mạo danh nó",
    'gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||',
    `  gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" --display-name "UDP build ${input.slug}"`,
    ...(ownRegistry
      ? [
          'gcloud artifacts repositories add-iam-policy-binding "$REPOSITORY" --project "$PROJECT" --location "$LOCATION" --member "serviceAccount:$SA" --role roles/artifactregistry.writer >/dev/null',
        ]
      : []),
    'gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" --role roles/iam.workloadIdentityUser --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/*" >/dev/null',
    ...(input.cloud.region === null
      ? []
      : [
          "",
          "# Khoá ký (Plan #61): EC P-256 trong Cloud KMS; service account chỉ được ký bằng ĐÚNG khoá này",
          'gcloud services enable cloudkms.googleapis.com --project "$PROJECT"',
          'gcloud kms keyrings describe udp --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 ||',
          '  gcloud kms keyrings create udp --location "$REGION" --project "$PROJECT"',
          'gcloud kms keys describe "$KEY" --keyring udp --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 ||',
          '  gcloud kms keys create "$KEY" --keyring udp --location "$REGION" --project "$PROJECT" --purpose asymmetric-signing --default-algorithm ec-sign-p256-sha256',
          'gcloud kms keys add-iam-policy-binding "$KEY" --keyring udp --location "$REGION" --project "$PROJECT" --member "serviceAccount:$SA" --role roles/cloudkms.signerVerifier >/dev/null',
          'gcloud kms keys versions get-public-key 1 --key "$KEY" --keyring udp --location "$REGION" --project "$PROJECT" --output-file /tmp/udp-sign.pem',
        ]),
    ...resultLine(
      '--arg wip "projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER" --arg sa "$SA"',
      'cloud:"gcp",workloadIdentityProvider:$wip,serviceAccount:$sa',
      input.cloud.region === null
        ? null
        : "gcpkms://projects/$PROJECT/locations/$REGION/keyRings/udp/cryptoKeys/$KEY/versions/1",
    ),
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
  registry: Extract<RegistryPush, { kind: "azure-acr" }> | null,
): string[] {
  const name = nameOf("udp-build-", input.slug, 120);
  const ci = input.ci;
  const audience = oidcAudience({ cloud: "azure", clientId: "", tenantId: "" });
  return [
    ...header(
      input,
      "trong Azure Cloud Shell của subscription chạy cụm UDP của project",
    ),
    ...(registry === null
      ? [
          `GROUP=${nameOf("udp-", input.slug, 80)}`,
          `LOCATION=${input.cloud.region ?? ""}`,
          'az group show --name "$GROUP" >/dev/null 2>&1 || az group create --name "$GROUP" --location "$LOCATION" >/dev/null',
        ]
      : [
          `REGISTRY=${registry.registryName}`,
          'ACR_ID=$(az acr show --name "$REGISTRY" --query id --output tsv)',
          'GROUP=$(az acr show --name "$REGISTRY" --query resourceGroup --output tsv)',
          'LOCATION=$(az group show --name "$GROUP" --query location --output tsv)',
        ]),
    `NAME=${name}`,
    // Tên Key Vault toàn cầu: slug + 6 hex băm từ subscription — mỗi subscription một vault của project
    ...(input.cloud.region === null
      ? []
      : [
          `VAULT=${nameOf("udp-", input.slug, 16)}-$(az account show --query id --output tsv | sha256sum | cut -c1-6)`,
        ]),
    "",
    "# Managed identity của project",
    'az identity show --resource-group "$GROUP" --name "$NAME" >/dev/null 2>&1 ||',
    '  az identity create --resource-group "$GROUP" --name "$NAME" >/dev/null',
    'CLIENT_ID=$(az identity show --resource-group "$GROUP" --name "$NAME" --query clientId --output tsv)',
    'PRINCIPAL_ID=$(az identity show --resource-group "$GROUP" --name "$NAME" --query principalId --output tsv)',
    'TENANT_ID=$(az identity show --resource-group "$GROUP" --name "$NAME" --query tenantId --output tsv)',
    "",
    "# Federated credential: Azure chỉ nhận chủ thể KHỚP ĐÚNG — mỗi nhánh một credential",
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
    ...(registry === null
      ? []
      : [
          "",
          "# Quyền đẩy image vào đúng registry",
          'if [ "$(az role assignment list --assignee "$PRINCIPAL_ID" --role AcrPush --scope "$ACR_ID" --query "length(@)" --output tsv)" = "0" ]; then',
          '  az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role AcrPush --scope "$ACR_ID" >/dev/null',
          "fi",
        ]),
    ...(input.cloud.region === null
      ? []
      : [
          "",
          "# Khoá ký (Plan #61): EC P-256 trong Key Vault (RBAC); identity chỉ được dùng ĐÚNG khoá này",
          'az keyvault show --name "$VAULT" >/dev/null 2>&1 ||',
          '  az keyvault create --name "$VAULT" --resource-group "$GROUP" --location "$LOCATION" --enable-rbac-authorization true >/dev/null',
          'VAULT_ID=$(az keyvault show --name "$VAULT" --query id --output tsv)',
          "# Người chạy script cần quyền data plane để tạo khoá; phân quyền mới lan tới Key Vault mất tới vài phút",
          "ME=$(az ad signed-in-user show --query id --output tsv)",
          'az role assignment create --assignee-object-id "$ME" --assignee-principal-type User --role "Key Vault Crypto Officer" --scope "$VAULT_ID" >/dev/null 2>&1 || true',
          "for _ in $(seq 1 30); do",
          '  az keyvault key show --vault-name "$VAULT" --name udp-sign >/dev/null 2>&1 && break',
          '  az keyvault key create --vault-name "$VAULT" --name udp-sign --kty EC --curve P-256 --ops sign verify >/dev/null 2>&1 && break',
          "  sleep 10",
          "done",
          'az keyvault key show --vault-name "$VAULT" --name udp-sign >/dev/null',
          'KEY_SCOPE="$VAULT_ID/keys/udp-sign"',
          'if [ "$(az role assignment list --assignee "$PRINCIPAL_ID" --role "Key Vault Crypto User" --scope "$KEY_SCOPE" --query "length(@)" --output tsv)" = "0" ]; then',
          '  az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role "Key Vault Crypto User" --scope "$KEY_SCOPE" >/dev/null',
          "fi",
          "rm -f /tmp/udp-sign.pem",
          'az keyvault key download --vault-name "$VAULT" --name udp-sign --encoding PEM --file /tmp/udp-sign.pem',
        ]),
    ...resultLine(
      '--arg cid "$CLIENT_ID" --arg tid "$TENANT_ID"',
      'cloud:"azure",clientId:$cid,tenantId:$tid',
      input.cloud.region === null
        ? null
        : "azurekms://$VAULT.vault.azure.net/udp-sign",
    ),
  ];
}
