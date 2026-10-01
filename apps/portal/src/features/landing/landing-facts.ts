import type { KnownDomainType } from "../domain/domain-info.messages";

/**
 * [Plan #59] Sự thật mà trang giới thiệu nói ra: chỉ thứ đếm được trong mã, không con số marketing nào.
 *
 * `LANDING_TOOLS` là BẢN SOI của registry adapter ở Service 1 (thư mục `*-adapter/<tool>` của core-backend, công bố qua
 * `GET /domains/catalog`). Trang công khai chưa đăng nhập nên không gọi được API đó; test `landing.test.tsx` đối chiếu
 * danh sách này với catalog golden của Service 1, nên thêm hay bỏ một công cụ mà quên trang là đỏ.
 */
export const LANDING_TOOLS = {
  CICD: [
    "github-actions",
    "gitlab-ci",
    "jenkins",
    "circleci",
    "tekton",
    "drone",
  ],
  CONTAINER_REGISTRY: [
    "ghcr",
    "ecr",
    "gcp-artifact-registry",
    "acr",
    "docker-hub",
    "harbor",
  ],
  ARTIFACT_REGISTRY: ["github-packages", "artifactory", "nexus"],
  GITOPS: ["argo-cd", "flux"],
  PROGRESSIVE_DELIVERY: ["argo-rollouts", "flagger", "spinnaker"],
  INGRESS: ["nginx", "traefik"],
  SERVICE_MESH: ["istio", "linkerd", "consul-connect", "kuma"],
  DATABASE: [
    "cloudnative-pg",
    "mysql",
    "mongodb",
    "redis",
    "k8ssandra",
    "minio",
  ],
  SECRETS: [
    "vault",
    "external-secrets",
    "sealed-secrets",
    "aws-secrets-manager",
    "gcp-secret-manager",
    "azure-key-vault",
  ],
  MONITORING: [
    "prometheus-grafana",
    "victoria-metrics",
    "grafana-cloud",
    "datadog",
    "newrelic",
    "dynatrace",
  ],
  LOGGING: [
    "loki",
    "fluent-bit",
    "fluentd",
    "elk",
    "opensearch",
    "datadog-logs",
    "splunk",
  ],
  TRACING: ["tempo", "jaeger", "zipkin"],
  SECURITY: ["trivy", "grype", "checkov", "falco", "zap", "snyk", "aqua"],
  POLICY: ["kyverno", "gatekeeper"],
  COST: ["opencost", "kubecost"],
  INFRA: [
    "terraform",
    "pulumi",
    "crossplane",
    "ansible",
    "ack",
    "config-connector",
    "aso",
  ],
} as const satisfies Record<KnownDomainType, readonly string[]>;

export const DOMAIN_COUNT = Object.keys(LANDING_TOOLS).length;
export const TOOL_COUNT = Object.values(LANDING_TOOLS).reduce(
  (n, tools) => n + tools.length,
  0,
);

/**
 * Trần tài nguyên mặc định của mỗi project — BẢN SOI của `DEFAULT_RESOURCE_QUOTA` (packages/config/src/constants.ts),
 * thứ Service 1 cưỡng chế ở mọi lời gọi adapter để một vòng lặp lỗi không tiêu tiền thật của khách. Portal không phụ
 * thuộc `@udp/config`; test đọc tệp hằng số và so từng số.
 */
export const SAFETY_QUOTA = {
  maxNodes: 3,
  maxDatabases: 2,
  maxStorageGb: 50,
  maxLoadBalancers: 3,
} as const;
