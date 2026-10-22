import type { ProviderPlan } from "@udp/cloud-adapters";
import { awsPlan } from "@udp/cloud-adapters/aws";
import {
  AZURE_FEDERATION_AUDIENCE,
  azurePlan,
} from "@udp/cloud-adapters/azure";
import { gcpPlan } from "@udp/cloud-adapters/gcp";
import {
  CLOUD_AUTH_KINDS,
  FEDERATED_AUTH_KINDS,
  PROVIDER_OF_AUTH_KIND,
  type CloudAuthKindWire,
  type CloudProviderWire,
} from "@udp/shared-types/cloud-api";
import type { CloudSetupWire } from "@udp/shared-types/wire";
import type { PlatformCapabilities } from "./cloud.platform.js";

/**
 * Dữ liệu màn hình setup (§4.3 "Portal hiển thị sẵn, có nút copy") — THUẦN: từ project,
 * cloud và cấu hình của triển khai ra đúng những khối khách dán vào cloud của họ.
 *
 * Những chỗ chỉ khách biết (`<APP_ID>`, `<PROJECT_NUMBER>`, email service account) để ở
 * dạng `<...>`; mọi thứ UDP biết (principal, ExternalId, issuer, subject, danh sách quyền)
 * được điền sẵn — chép tay một ExternalId 32 ký tự là cách chắc chắn nhất để sai một ký tự.
 */

type Snippet = CloudSetupWire["methods"][number]["snippets"][number];
type Method = CloudSetupWire["methods"][number];

const PLAN_OF: Readonly<Record<CloudProviderWire, ProviderPlan>> = {
  AWS: awsPlan,
  GCP: gcpPlan,
  AZURE: azurePlan,
};

/** Id vai trò dựng sẵn của Azure mà kế hoạch AKS cần — cố định trên mọi tenant */
const NETWORK_CONTRIBUTOR = "4d97b98b-1d4f-4787-a291-c67834d212e7";

export const subjectOf = (projectId: string): string => `project:${projectId}`;

const json = (id: string, value: unknown): Snippet => ({
  id,
  language: "json",
  content: JSON.stringify(value, null, 2),
});
const shell = (id: string, lines: readonly string[]): Snippet => ({
  id,
  language: "shell",
  content: lines.join("\n"),
});

function awsPermissionsPolicy(): Snippet {
  return json("aws-permissions-policy", {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [...awsPlan.requiredPermissions],
        Resource: "*",
      },
    ],
  });
}

function awsSnippets(
  kind: CloudAuthKindWire,
  projectId: string,
  caps: PlatformCapabilities,
): Snippet[] {
  if (kind === "AWS_KEY" || caps.awsRole === null)
    return [awsPermissionsPolicy()];
  return [
    json("aws-trust-policy", {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: caps.awsRole.principalArn },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: {
              "sts:ExternalId": caps.awsRole.externalIdFor(projectId),
            },
          },
        },
      ],
    }),
    awsPermissionsPolicy(),
  ];
}

/** Vai trò tuỳ chỉnh đúng bằng danh sách quyền của kế hoạch GKE — không rộng hơn */
function gcpCustomRole(): Snippet {
  return shell("gcp-custom-role", [
    "gcloud iam roles create udpDeployer --project=<GCP_PROJECT_ID> \\",
    `  --permissions=${gcpPlan.requiredPermissions.join(",")}`,
    "gcloud projects add-iam-policy-binding <GCP_PROJECT_ID> \\",
    "  --member=serviceAccount:<SERVICE_ACCOUNT_EMAIL> \\",
    "  --role=projects/<GCP_PROJECT_ID>/roles/udpDeployer",
  ]);
}

function gcpSnippets(
  kind: CloudAuthKindWire,
  projectId: string,
  caps: PlatformCapabilities,
): Snippet[] {
  if (kind === "GCP_KEY" || caps.oidcIssuer === null) return [gcpCustomRole()];
  const subject = subjectOf(projectId);
  return [
    shell("gcp-workload-identity", [
      "gcloud iam workload-identity-pools create udp-pool --location=global",
      "gcloud iam workload-identity-pools providers create-oidc udp-oidc \\",
      "  --location=global --workload-identity-pool=udp-pool \\",
      `  --issuer-uri=${caps.oidcIssuer} \\`,
      '  --attribute-mapping="google.subject=assertion.sub" \\',
      `  --attribute-condition="assertion.sub=='${subject}'"`,
      "gcloud iam service-accounts add-iam-policy-binding <SERVICE_ACCOUNT_EMAIL> \\",
      "  --role=roles/iam.workloadIdentityUser \\",
      `  --member="principal://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/udp-pool/subject/${subject}"`,
    ]),
    gcpCustomRole(),
  ];
}

/**
 * Ba vai trò trên ĐÚNG resource group khách tạo (§4.3: UDP không bao giờ có quyền
 * subscription). Quyền gán vai trò bị giới hạn ở Network Contributor bằng điều kiện ABAC —
 * đủ cho step `identity-network` của kế hoạch AKS, không hơn.
 */
function azureRoleAssignments(): string[] {
  const scope =
    "/subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<RESOURCE_GROUP>";
  return [
    `az role assignment create --assignee <APP_ID> --role Contributor --scope ${scope}`,
    `az role assignment create --assignee <APP_ID> --role "Azure Kubernetes Service RBAC Cluster Admin" --scope ${scope}`,
    `az role assignment create --assignee <APP_ID> --role "Role Based Access Control Administrator" --scope ${scope} \\`,
    `  --condition "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${NETWORK_CONTRIBUTOR}}))" \\`,
    "  --condition-version 2.0",
  ];
}

function azureSnippets(
  kind: CloudAuthKindWire,
  projectId: string,
  caps: PlatformCapabilities,
): Snippet[] {
  if (kind === "AZURE_SECRET" || caps.oidcIssuer === null) {
    return [
      shell("azure-app-secret", [
        "az ad app create --display-name udp-deployer",
        "az ad sp create --id <APP_ID>",
        "az ad app credential reset --id <APP_ID>",
        ...azureRoleAssignments(),
      ]),
    ];
  }
  const credential = {
    name: "udp-project",
    issuer: caps.oidcIssuer,
    subject: subjectOf(projectId),
    audiences: [AZURE_FEDERATION_AUDIENCE],
  };
  return [
    shell("azure-federated-credential", [
      "az ad app create --display-name udp-deployer",
      "az ad sp create --id <APP_ID>",
      `az ad app federated-credential create --id <APP_ID> --parameters '${JSON.stringify(credential)}'`,
      ...azureRoleAssignments(),
    ]),
  ];
}

const SNIPPETS_OF: Readonly<
  Record<
    CloudProviderWire,
    (
      kind: CloudAuthKindWire,
      projectId: string,
      caps: PlatformCapabilities,
    ) => Snippet[]
  >
> = { AWS: awsSnippets, GCP: gcpSnippets, AZURE: azureSnippets };

/** Cơ chế federation dùng được khi triển khai này đã bật phía UDP của nó */
export function unavailableReason(
  kind: CloudAuthKindWire,
  caps: PlatformCapabilities,
): Method["unavailableReason"] {
  if (kind === "AWS_ROLE" && caps.awsRole === null)
    return "aws-federation-disabled";
  if (
    (kind === "GCP_WIF" || kind === "AZURE_FEDERATED") &&
    caps.oidcIssuer === null
  ) {
    return "oidc-issuer-disabled";
  }
  return null;
}

/** Đích MANAGED của một cloud trong tài khoản của UDP; `null` = cloud đó không nhận MANAGED */
export function managedTargetOf(
  provider: CloudProviderWire,
  caps: PlatformCapabilities,
): object | null {
  return {
    AWS: caps.managed.aws,
    GCP: caps.managed.gcp,
    AZURE: caps.managed.azure,
  }[provider];
}

export function buildSetup(
  provider: CloudProviderWire,
  projectId: string,
  caps: PlatformCapabilities,
): CloudSetupWire {
  const plan = PLAN_OF[provider];
  const methods = CLOUD_AUTH_KINDS.filter(
    (kind) => PROVIDER_OF_AUTH_KIND[kind] === provider,
  ).map((kind): Method => {
    const reason = unavailableReason(kind, caps);
    return {
      authKind: kind,
      federated: FEDERATED_AUTH_KINDS.includes(kind),
      available: reason === null,
      unavailableReason: reason,
      snippets: SNIPPETS_OF[provider](kind, projectId, caps),
    };
  });
  const managed = managedTargetOf(provider, caps) !== null;
  return {
    provider,
    subject: subjectOf(projectId),
    methods,
    managed: {
      available: managed,
      unavailableReason: managed ? null : "managed-disabled",
    },
    requiredPermissions: [...plan.requiredPermissions],
    docUrl: plan.docUrl,
  };
}
