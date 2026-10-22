/**
 * [v4.12, Plan #61 61d-3c] Toạ độ chart Helm mà UDP ghim — MỘT bảng, như `BUILD_TOOLCHAIN` và `TEST_IMAGES`.
 *
 * **Vì sao ghim rời khỏi tệp adapter.** Cổng canh ghim chart (`pnpm chart:check`) phải đọc được danh sách này trên
 * runner CI, nơi **không có `.env`**. Nạp registry adapter thì không được: `adapter-base/helm.ts` import
 * `envLabelFor` từ gốc `@udp/config`, gốc đó re-export `env`, và `env.ts` chạy `envSchema.safeParse(process.env)`
 * ở mức module rồi **ném** khi thiếu biến. Và không có bản sửa rẻ — 54 tệp dưới `modules/` import từ gốc
 * `@udp/config`, trong đó 9 tệp dùng chính `env`. Đường thứ hai (gắn toạ độ vào adapter rồi đọc lại lúc chạy) cũng
 * vỡ: `createCicdAdapter` trả `{ ...spec.base }`, một object MỚI, nên mọi phép tra theo danh tính object mất Jenkins,
 * Tekton và Drone — và mất theo kiểu **fail open** (không tra được ⇒ coi như không có chart ⇒ "ok").
 *
 * Nên ghim là **dữ liệu**, đọc được mà không khởi động nửa hệ thống. Cái giá: lời khai của một adapter chia hai chỗ
 * — bảng này giữ ghim HIỆN TẠI, còn `upgradesFrom` của adapter giữ ghim LỊCH SỬ (nó thuộc lịch sử version của chính
 * adapter đó, và phải đóng băng).
 *
 * **Một chart = một version.** Khoá của bảng là tên chart, và một cổng khẳng định không tên nào có hai toạ độ: hai
 * bản cert-manager trong một cụm tranh CRD và webhook (xem `adapter-base/cert-manager.ts`). Lúc dựng bảng này, 70
 * tên chart của sản phẩm đã thoả điều đó sẵn.
 *
 * **Version KHÔNG được có hậu tố.** `newerTags` coi hậu tố là phần của danh tính, nên một ghim `0.13.0-rc` sẽ nhận
 * `0.13.2-rc` làm "bản vá" — tự nâng giữa các bản thử nghiệm. `assertChartPins` chặn điều đó.
 *
 * NĂM ghim đã SỬA ở đợt này, mỗi cái đối chiếu `index.yaml` **và** `values.yaml` thật (03/10/2026):
 * `mysql-operator` 2.2.2 ⇒ 2.3.0 (adapter dùng `values: () => ({})` nên không khoá nào phải khớp), `zipkin`
 * 0.3.6 ⇒ 0.7.0 (chart 0.7.0 có đúng `zipkin.storage.type: mem` và `zipkin.extraEnv`), `snyk-monitor`
 * 2.13.1 ⇒ 2.23.26 (ba khoá `clusterName`, `integrationApi`, `monitorSecrets` đều còn), `raw` 0.3.2 ⇒ v0.3.2
 * (lệch tiền tố), và **repo** của `sealed-secrets` (địa chỉ cũ 404 toàn site; địa chỉ đúng CÓ 2.16.1).
 *
 * Cả năm bản cũ **không tải về được**, nên đây là sửa một ghim chưa bao giờ đúng — không phải một lần nâng cấp
 * §8.6, và `adapter_version` không đổi: không cụm nào từng chạy chúng.
 *
 * Ba ghim còn hỏng mà đợt này **không** sửa nằm ở `KNOWN_BROKEN_CHARTS` kèm lý do: cả ba cần đổi `values` hay đổi
 * nguồn chart, và sửa version mà giữ `values` sai là biến một lỗi ỒN thành một lỗi IM LẶNG (Helm bỏ qua khoá nó
 * không biết).
 */

/** Toạ độ một chart Helm; `detectDrift` so `version` với giá trị thật trên cụm */
export interface HelmChartRef {
  name: string;
  /** Version của CHART (không phải appVersion), đúng chuỗi mà `index.yaml` của repo khai */
  version: string;
  repo: string;
  /**
   * [v4.11, Plan #37 QĐ-6] Nguồn KHÔNG phải Helm chart: nhà phát hành chỉ có bundle manifest (Config Connector).
   * Bản ghi release nói thẳng bộ cài áp bundle bằng `kubectl apply` thay vì giả làm một chart. Vắng = Helm chart.
   */
  installer?: "manifest-bundle";
}

export const HELM_CHART_PINS: Readonly<Record<string, HelmChartRef>> = {
  /** gitops-adapter/argo-cd/index.ts:36 */
  "argo-cd": {
    name: "argo-cd",
    version: "7.6.12",
    repo: "https://argoproj.github.io/argo-helm",
  },
  /** progressive-delivery-adapter/argo-rollouts/index.ts:55 */
  "argo-rollouts": {
    name: "argo-rollouts",
    version: "2.37.7",
    repo: "https://argoproj.github.io/argo-helm",
  },
  /** artifact-registry-adapter/artifactory/index.ts:42 */
  "artifactory-oss": {
    name: "artifactory-oss",
    version: "107.90.10",
    repo: "https://charts.jfrog.io",
  },
  /** infra-adapter/aso/index.ts:52 */
  "azure-service-operator": {
    name: "azure-service-operator",
    version: "2.11.0",
    repo: "https://raw.githubusercontent.com/Azure/azure-service-operator/main/v2/charts",
  },
  /** service-mesh-adapter/istio/index.ts:35 */
  base: {
    name: "base",
    version: "1.23.2",
    repo: "https://istio-release.storage.googleapis.com/charts",
  },
  /** adapter-base/cert-manager.ts:11 */
  "cert-manager": {
    name: "cert-manager",
    version: "v1.16.1",
    repo: "https://charts.jetstack.io",
  },
  /** database-adapter/cloudnative-pg/index.ts:37 */
  "cloudnative-pg": {
    name: "cloudnative-pg",
    version: "0.22.1",
    repo: "https://cloudnative-pg.github.io/charts",
  },
  /** database-adapter/mongodb/index.ts:43 */
  "community-operator": {
    name: "community-operator",
    version: "0.11.0",
    repo: "https://mongodb.github.io/helm-charts",
  },
  /** infra-adapter/config-connector/index.ts:37 */
  "configconnector-operator": {
    name: "configconnector-operator",
    version: "1.125.0",
    repo: "gs://configconnector-operator",
    installer: "manifest-bundle",
  },
  /** service-mesh-adapter/consul-connect/index.ts:32 */
  consul: {
    name: "consul",
    version: "1.5.3",
    repo: "https://helm.releases.hashicorp.com",
  },
  /** cost-adapter/kubecost/index.ts:38 */
  "cost-analyzer": {
    name: "cost-analyzer",
    version: "2.4.3",
    repo: "https://kubecost.github.io/cost-analyzer/",
  },
  /** infra-adapter/crossplane/index.ts:38 */
  crossplane: {
    name: "crossplane",
    version: "1.17.1",
    repo: "https://charts.crossplane.io/stable",
  },
  /** secrets-adapter/azure-key-vault/index.ts:35 */
  "csi-secrets-store-provider-azure": {
    name: "csi-secrets-store-provider-azure",
    version: "1.6.0",
    repo: "https://azure.github.io/secrets-store-csi-driver-provider-azure/charts",
  },
  /** logging-adapter/datadog-logs/index.ts:35 */
  datadog: {
    name: "datadog",
    version: "3.69.3",
    repo: "https://helm.datadoghq.com",
  },
  /** cicd-adapter/drone/index.ts:88 */
  drone: {
    name: "drone",
    version: "0.6.5",
    repo: "https://charts.drone.io",
  },
  /** cicd-adapter/drone/index.ts:118 */
  "drone-runner-kube": {
    name: "drone-runner-kube",
    version: "0.1.10",
    repo: "https://charts.drone.io",
  },
  /** infra-adapter/ack/index.ts:60 */
  "dynamodb-chart": {
    name: "dynamodb-chart",
    version: "1.2.15",
    repo: "oci://public.ecr.aws/aws-controllers-k8s",
  },
  /** monitoring-adapter/dynatrace/index.ts:52 */
  "dynatrace-operator": {
    name: "dynatrace-operator",
    version: "1.3.2",
    repo: "https://raw.githubusercontent.com/Dynatrace/dynatrace-operator/main/config/helm/repos/stable",
  },
  /** logging-adapter/elk/index.ts:38 */
  "eck-operator": {
    name: "eck-operator",
    version: "2.14.0",
    repo: "https://helm.elastic.co",
  },
  /** logging-adapter/elk/index.ts:47 */
  "eck-stack": {
    name: "eck-stack",
    version: "0.12.1",
    repo: "https://helm.elastic.co",
  },
  /** secrets-adapter/external-secrets/index.ts:32 */
  "external-secrets": {
    name: "external-secrets",
    version: "0.10.4",
    repo: "https://charts.external-secrets.io",
  },
  /** security-adapter/falco/index.ts:42 */
  falco: {
    name: "falco",
    version: "4.8.3",
    repo: "https://falcosecurity.github.io/charts",
  },
  /** progressive-delivery-adapter/flagger/index.ts:58 */
  flagger: {
    name: "flagger",
    version: "1.38.0",
    repo: "https://flagger.app",
  },
  /** logging-adapter/fluent-bit/index.ts:38 (+1 chỗ nữa) */
  "fluent-bit": {
    name: "fluent-bit",
    version: "0.47.10",
    repo: "https://fluent.github.io/helm-charts",
  },
  /** logging-adapter/fluentd/index.ts:34 */
  fluentd: {
    name: "fluentd",
    version: "0.5.2",
    repo: "https://fluent.github.io/helm-charts",
  },
  /** gitops-adapter/flux/index.ts:36 */
  flux2: {
    name: "flux2",
    version: "2.14.0",
    repo: "https://fluxcd-community.github.io/helm-charts",
  },
  /** gitops-adapter/flux/index.ts:60 */
  "flux2-sync": {
    name: "flux2-sync",
    version: "1.10.0",
    repo: "https://fluxcd-community.github.io/helm-charts",
  },
  /** policy-adapter/gatekeeper/index.ts:32 */
  gatekeeper: {
    name: "gatekeeper",
    version: "3.17.1",
    repo: "https://open-policy-agent.github.io/gatekeeper/charts",
  },
  /** service-mesh-adapter/istio/index.ts:59 */
  gateway: {
    name: "gateway",
    version: "1.23.2",
    repo: "https://istio-release.storage.googleapis.com/charts",
  },
  /** logging-adapter/loki/index.ts:96 */
  grafana: {
    name: "grafana",
    version: "8.5.2",
    repo: "https://grafana.github.io/helm-charts",
  },
  /** container-registry-adapter/harbor/index.ts:58 */
  harbor: {
    name: "harbor",
    version: "1.15.1",
    repo: "https://helm.goharbor.io",
  },
  /** ingress-adapter/nginx/index.ts:34 */
  "ingress-nginx": {
    name: "ingress-nginx",
    version: "4.11.2",
    repo: "https://kubernetes.github.io/ingress-nginx",
  },
  /** service-mesh-adapter/istio/index.ts:44 */
  istiod: {
    name: "istiod",
    version: "1.23.2",
    repo: "https://istio-release.storage.googleapis.com/charts",
  },
  /** tracing-adapter/jaeger/index.ts:31 */
  jaeger: {
    name: "jaeger",
    version: "3.4.1",
    repo: "https://jaegertracing.github.io/helm-charts",
  },
  /** cicd-adapter/jenkins/index.ts:74 */
  jenkins: {
    name: "jenkins",
    version: "5.7.2",
    repo: "https://charts.jenkins.io",
  },
  /** monitoring-adapter/grafana-cloud/index.ts:47 */
  "k8s-monitoring": {
    name: "k8s-monitoring",
    version: "1.6.14",
    repo: "https://grafana.github.io/helm-charts",
  },
  /** database-adapter/k8ssandra/index.ts:39 */
  "k8ssandra-operator": {
    name: "k8ssandra-operator",
    version: "1.20.2",
    repo: "https://helm.k8ssandra.io/stable",
  },
  /** security-adapter/aqua/index.ts:31 */
  "kube-enforcer": {
    name: "kube-enforcer",
    version: "2022.4.46",
    repo: "https://helm.aquasec.com",
  },
  /** monitoring-adapter/prometheus-grafana/index.ts:57 */
  "kube-prometheus-stack": {
    name: "kube-prometheus-stack",
    version: "65.1.1",
    repo: "https://prometheus-community.github.io/helm-charts",
  },
  /** service-mesh-adapter/kuma/index.ts:30 */
  kuma: {
    name: "kuma",
    version: "2.8.3",
    repo: "https://kumahq.github.io/charts",
  },
  /** policy-adapter/kyverno/index.ts:126 */
  kyverno: {
    name: "kyverno",
    version: "3.9.1",
    repo: "https://kyverno.github.io/kyverno/",
  },
  /** policy-adapter/kyverno/index.ts:135 */
  "kyverno-policies": {
    name: "kyverno-policies",
    version: "3.9.1",
    repo: "https://kyverno.github.io/kyverno/",
  },
  /** service-mesh-adapter/linkerd/index.ts:60 */
  "linkerd-control-plane": {
    name: "linkerd-control-plane",
    version: "1.16.11",
    repo: "https://helm.linkerd.io/stable",
  },
  /** service-mesh-adapter/linkerd/index.ts:43 */
  "linkerd-crds": {
    name: "linkerd-crds",
    version: "1.8.0",
    repo: "https://helm.linkerd.io/stable",
  },
  /** logging-adapter/loki/index.ts:37 */
  loki: {
    name: "loki",
    version: "6.16.0",
    repo: "https://grafana.github.io/helm-charts",
  },
  /** database-adapter/mysql/index.ts:42 */
  "mysql-operator": {
    name: "mysql-operator",
    version: "2.3.0",
    repo: "https://mysql.github.io/mysql-operator/",
  },
  /** artifact-registry-adapter/nexus/index.ts:44 */
  "nexus-repository-manager": {
    name: "nexus-repository-manager",
    version: "64.2.0",
    repo: "https://sonatype.github.io/helm3-charts/",
  },
  /** monitoring-adapter/newrelic/index.ts:64 */
  "nri-bundle": {
    name: "nri-bundle",
    version: "5.0.94",
    repo: "https://helm-charts.newrelic.com",
  },
  /** cost-adapter/opencost/index.ts:38 */
  opencost: {
    name: "opencost",
    version: "1.42.3",
    repo: "https://opencost.github.io/opencost-helm-chart",
  },
  /** logging-adapter/opensearch/index.ts:51 */
  opensearch: {
    name: "opensearch",
    version: "2.26.0",
    repo: "https://opensearch-project.github.io/helm-charts",
  },
  /** logging-adapter/opensearch/index.ts:72 */
  "opensearch-dashboards": {
    name: "opensearch-dashboards",
    version: "2.24.0",
    repo: "https://opensearch-project.github.io/helm-charts",
  },
  /** database-adapter/minio/index.ts:60 */
  operator: {
    name: "operator",
    version: "6.0.4",
    repo: "https://operator.min.io",
  },
  /** logging-adapter/loki/index.ts:85 */
  promtail: {
    name: "promtail",
    version: "6.16.6",
    repo: "https://grafana.github.io/helm-charts",
  },
  /** adapter-base/packaging/build-namespace.ts:114 (+6 chỗ nữa) */
  raw: {
    name: "raw",
    version: "v0.3.2",
    repo: "https://dysnix.github.io/charts",
  },
  /** infra-adapter/ack/index.ts:55 */
  "rds-chart": {
    name: "rds-chart",
    version: "1.4.7",
    repo: "oci://public.ecr.aws/aws-controllers-k8s",
  },
  /** database-adapter/redis/index.ts:42 */
  "redis-operator": {
    name: "redis-operator",
    version: "0.18.3",
    repo: "https://ot-container-kit.github.io/helm-charts/",
  },
  /** infra-adapter/ack/index.ts:47 */
  "s3-chart": {
    name: "s3-chart",
    version: "1.0.14",
    repo: "oci://public.ecr.aws/aws-controllers-k8s",
  },
  /** secrets-adapter/sealed-secrets/index.ts:31 */
  "sealed-secrets": {
    name: "sealed-secrets",
    version: "2.16.1",
    repo: "https://bitnami.github.io/sealed-secrets",
  },
  /** secrets-adapter/aws-secrets-manager/index.ts:34 (+1 chỗ nữa) */
  "secrets-store-csi-driver": {
    name: "secrets-store-csi-driver",
    version: "1.4.5",
    repo: "https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts",
  },
  /** secrets-adapter/aws-secrets-manager/index.ts:51 */
  "secrets-store-csi-driver-provider-aws": {
    name: "secrets-store-csi-driver-provider-aws",
    version: "0.3.9",
    repo: "https://aws.github.io/secrets-store-csi-driver-provider-aws",
  },
  /** secrets-adapter/gcp-secret-manager/index.ts:52 */
  "secrets-store-csi-driver-provider-gcp": {
    name: "secrets-store-csi-driver-provider-gcp",
    version: "1.6.0",
    repo: "https://googlecloudplatform.github.io/secrets-store-csi-driver-provider-gcp",
  },
  /** security-adapter/snyk/index.ts:37 */
  "snyk-monitor": {
    name: "snyk-monitor",
    version: "2.23.26",
    repo: "https://snyk.github.io/kubernetes-monitor/",
  },
  /** progressive-delivery-adapter/spinnaker/index.ts:55 */
  spinnaker: {
    name: "spinnaker",
    version: "2.2.24",
    repo: "https://helmcharts.opsmx.com",
  },
  /** logging-adapter/splunk/index.ts:46 */
  "splunk-otel-collector": {
    name: "splunk-otel-collector",
    version: "0.110.0",
    repo: "https://signalfx.github.io/splunk-otel-collector-chart",
  },
  /** cicd-adapter/tekton/index.ts:83 */
  "tekton-pipeline": {
    name: "tekton-pipeline",
    version: "1.1.4",
    repo: "https://cdfoundation.github.io/tekton-helm-chart",
  },
  /** tracing-adapter/tempo/index.ts:30 */
  tempo: {
    name: "tempo",
    version: "1.10.3",
    repo: "https://grafana.github.io/helm-charts",
  },
  /** ingress-adapter/traefik/index.ts:30 */
  traefik: {
    name: "traefik",
    version: "32.1.0",
    repo: "https://traefik.github.io/charts",
  },
  /** security-adapter/trivy/index.ts:40 */
  "trivy-operator": {
    name: "trivy-operator",
    version: "0.24.1",
    repo: "https://aquasecurity.github.io/helm-charts/",
  },
  /** secrets-adapter/vault/index.ts:34 */
  vault: {
    name: "vault",
    version: "0.28.1",
    repo: "https://helm.releases.hashicorp.com",
  },
  /** monitoring-adapter/victoria-metrics/index.ts:39 */
  "victoria-metrics-k8s-stack": {
    name: "victoria-metrics-k8s-stack",
    version: "0.25.17",
    repo: "https://victoriametrics.github.io/helm-charts",
  },
  /** tracing-adapter/zipkin/index.ts:32 */
  zipkin: {
    name: "zipkin",
    version: "0.7.0",
    repo: "https://openzipkin.github.io/zipkin",
  },
};

export type HelmChartName = keyof typeof HELM_CHART_PINS;

/** Toạ độ của một chart đã ghim; tên lạ ⇒ ném (không im lặng trả `undefined` vào `HelmRelease`) */
export function helmChart(name: string): HelmChartRef {
  const pin = HELM_CHART_PINS[name];
  if (pin === undefined) {
    throw new Error(
      `chart "${name}" không có trong HELM_CHART_PINS — thêm nó vào packages/config/src/helm-charts.ts`,
    );
  }
  return pin;
}

/** Hậu tố phiên bản (`-rc`, `-beta.0`): `newerTags` coi nó là danh tính nên ghim có hậu tố tự nâng giữa các bản thử */
const SUFFIXED = /^v?\d+(?:\.\d+)*-/;

/**
 * Hai bất biến của bảng, kiểm lúc nạp chứ không lúc review: không hai tên cùng toạ độ chart khác nhau (khoá đã là
 * tên nên điều này đúng theo kiến tạo — phép kiểm còn lại là `name` của giá trị phải BẰNG khoá), và không version
 * nào có hậu tố.
 */
export function assertChartPins(
  pins: Readonly<Record<string, HelmChartRef>> = HELM_CHART_PINS,
): void {
  for (const [key, pin] of Object.entries(pins)) {
    if (pin.name !== key) {
      throw new Error(
        `HELM_CHART_PINS: khoá "${key}" mang chart tên "${pin.name}"`,
      );
    }
    if (SUFFIXED.test(pin.version)) {
      throw new Error(
        `HELM_CHART_PINS["${key}"]: version "${pin.version}" có hậu tố — ghim bản thử nghiệm sẽ tự nâng sang bản thử khác`,
      );
    }
  }
}
