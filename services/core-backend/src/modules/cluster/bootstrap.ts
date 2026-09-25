import type { ObjectRef, ResourceQuota } from "@udp/adapter-core";
import { IDENTITY_SERVICE_ACCOUNTS } from "@udp/adapter-core";

/**
 * Bootstrap cluster tenant (ADR-06, §8.1 bước cuối CLUSTER, §12.2) — THUẦN: từ project ra
 * đúng tập đối tượng cần áp. Áp là việc của pha CLUSTER_ACCESS (server-side apply, lặp lại
 * bao nhiêu lần cũng ra cùng trạng thái).
 *
 * Ba ServiceAccount rời nhau trong `udp-system`, quyền đúng bảng §12.2 — API server từ chối
 * thay vì kỷ luật lập trình (I25). Mỗi environment một namespace, chặn ingress mặc định
 * (chỉ cho trong cùng namespace), ResourceQuota theo quota của project, LimitRange để pod
 * không khai tài nguyên vẫn bị giới hạn.
 */

export const SYSTEM_NAMESPACE = "udp-system";

/**
 * Secret kéo image của MỖI namespace environment (Plan #35 QĐ-2) — bootstrap tạo rỗng, nền tảng
 * phân phối khoá vào đó. Tên cố định vì RBAC chỉ mở đúng tên này (`resourceNames`).
 */
export const REGISTRY_PULL_SECRET = "udp-registry-pull";
const EMPTY_DOCKER_CONFIG = Buffer.from(JSON.stringify({ auths: {} })).toString(
  "base64",
);

export interface BootstrapInput {
  projectId: string;
  environments: readonly { name: string; k8sNamespace: string }[];
  quota: ResourceQuota;
}

export interface Manifest {
  ref: ObjectRef;
  body: Record<string, unknown>;
}

interface PolicyRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
  resourceNames?: string[];
}

const RW = ["get", "list", "watch", "create", "update", "patch"];
const READ = ["get", "list", "watch"];

/** `udp-system/udp-workload` ⇒ `udp-workload` */
const saName = (identity: keyof typeof IDENTITY_SERVICE_ACCOUNTS): string =>
  IDENTITY_SERVICE_ACCOUNTS[identity].split("/")[1] ?? identity;

/** §12.2 — trong namespace của environment */
const WORKLOAD_RULES: PolicyRule[] = [
  { apiGroups: ["apps"], resources: ["deployments"], verbs: RW },
  { apiGroups: [""], resources: ["services", "configmaps"], verbs: RW },
  { apiGroups: ["argoproj.io"], resources: ["rollouts"], verbs: RW },
];

/** §12.2 — đường traffic; rollout chỉ ĐỌC và qua subresource, không bao giờ `spec.template` */
const TRAFFIC_RULES: PolicyRule[] = [
  {
    apiGroups: ["networking.istio.io"],
    resources: ["virtualservices"],
    verbs: RW,
  },
  { apiGroups: ["split.smi-spec.io"], resources: ["trafficsplits"], verbs: RW },
  { apiGroups: ["networking.k8s.io"], resources: ["ingresses"], verbs: RW },
  { apiGroups: ["argoproj.io"], resources: ["rollouts"], verbs: READ },
  {
    apiGroups: ["argoproj.io"],
    resources: ["rollouts/promote", "rollouts/abort", "rollouts/retry"],
    verbs: ["update", "patch"],
  },
];

/** Nguồn metrics sống trong `udp-system`: S3 chỉ được proxy tới service ở ĐÓ */
const TRAFFIC_METRICS_RULES: PolicyRule[] = [
  { apiGroups: [""], resources: ["services/proxy"], verbs: ["get"] },
];

/** §12.2 — Helm release, CR của operator trong `udp-system` */
const TOOLING_SYSTEM_RULES: PolicyRule[] = [
  {
    apiGroups: ["helm.toolkit.fluxcd.io"],
    resources: ["helmreleases"],
    verbs: [...RW, "delete"],
  },
  {
    apiGroups: ["source.toolkit.fluxcd.io"],
    resources: ["helmrepositories"],
    verbs: [...RW, "delete"],
  },
  { apiGroups: [""], resources: ["configmaps"], verbs: [...RW, "delete"] },
  /** Khoá của agent (Plan #31 QĐ-5) — chỉ trong namespace của chính SA, đúng §12.2 */
  { apiGroups: [""], resources: ["secrets"], verbs: [...RW, "delete"] },
];

/**
 * §12.2 sửa ở D-P26 (Plan #35): ở namespace environment, `udp-tooling` chỉ đọc và sửa ĐÚNG MỘT
 * Secret — `udp-registry-pull` — không tạo, không liệt kê, không xoá, không Secret nào khác.
 */
const TOOLING_REGISTRY_PULL_VERBS = ["get", "update", "patch"];
const TOOLING_ENV_RULES: PolicyRule[] = [
  {
    apiGroups: [""],
    resources: ["secrets"],
    resourceNames: [REGISTRY_PULL_SECRET],
    verbs: TOOLING_REGISTRY_PULL_VERBS,
  },
];

/** CRD là đối tượng phạm vi cluster — operator của domain cần cài chúng */
const TOOLING_CLUSTER_RULES: PolicyRule[] = [
  {
    apiGroups: ["apiextensions.k8s.io"],
    resources: ["customresourcedefinitions"],
    verbs: RW,
  },
];

const labels = (projectId: string) => ({
  "app.kubernetes.io/managed-by": "udp",
  "udp.project": projectId,
});

function role(namespace: string, name: string, rules: PolicyRule[]): Manifest {
  return {
    ref: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      namespace,
      name,
    },
    body: { metadata: { name, namespace }, rules },
  };
}

function roleBinding(namespace: string, name: string, sa: string): Manifest {
  return {
    ref: {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      namespace,
      name,
    },
    body: {
      metadata: { name, namespace },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
      subjects: [
        { kind: "ServiceAccount", name: sa, namespace: SYSTEM_NAMESPACE },
      ],
    },
  };
}

/** Mọi manifest mang apiVersion/kind trong body — server-side apply đòi chúng */
function withTypeMeta(m: Manifest): Manifest {
  return {
    ref: m.ref,
    body: { apiVersion: m.ref.apiVersion, kind: m.ref.kind, ...m.body },
  };
}

export function bootstrapManifests(input: BootstrapInput): Manifest[] {
  const meta = labels(input.projectId);
  const workload = saName("workload");
  const traffic = saName("traffic");
  const tooling = saName("tooling");
  const out: Manifest[] = [
    {
      ref: { apiVersion: "v1", kind: "Namespace", name: SYSTEM_NAMESPACE },
      body: { metadata: { name: SYSTEM_NAMESPACE, labels: meta } },
    },
    ...[workload, traffic, tooling].map((name): Manifest => ({
      ref: {
        apiVersion: "v1",
        kind: "ServiceAccount",
        namespace: SYSTEM_NAMESPACE,
        name,
      },
      body: { metadata: { name, namespace: SYSTEM_NAMESPACE, labels: meta } },
    })),
    role(SYSTEM_NAMESPACE, tooling, TOOLING_SYSTEM_RULES),
    roleBinding(SYSTEM_NAMESPACE, tooling, tooling),
    role(SYSTEM_NAMESPACE, `${traffic}-metrics`, TRAFFIC_METRICS_RULES),
    roleBinding(SYSTEM_NAMESPACE, `${traffic}-metrics`, traffic),
    {
      ref: {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRole",
        name: `${tooling}-crd`,
      },
      body: {
        metadata: { name: `${tooling}-crd`, labels: meta },
        rules: TOOLING_CLUSTER_RULES,
      },
    },
    {
      ref: {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRoleBinding",
        name: `${tooling}-crd`,
      },
      body: {
        metadata: { name: `${tooling}-crd`, labels: meta },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: `${tooling}-crd`,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: tooling,
            namespace: SYSTEM_NAMESPACE,
          },
        ],
      },
    },
  ];

  for (const env of input.environments) {
    const ns = env.k8sNamespace;
    out.push(
      {
        ref: { apiVersion: "v1", kind: "Namespace", name: ns },
        body: {
          metadata: {
            name: ns,
            labels: { ...meta, "udp.environment": env.name },
          },
        },
      },
      {
        ref: {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          namespace: ns,
          name: "udp-default-deny-ingress",
        },
        body: {
          metadata: { name: "udp-default-deny-ingress", namespace: ns },
          spec: {
            podSelector: {},
            policyTypes: ["Ingress"],
            // Chỉ pod trong CÙNG namespace — environment này không nghe environment khác
            ingress: [{ from: [{ podSelector: {} }] }],
          },
        },
      },
      {
        ref: {
          apiVersion: "v1",
          kind: "ResourceQuota",
          namespace: ns,
          name: "udp-quota",
        },
        body: {
          metadata: { name: "udp-quota", namespace: ns },
          spec: {
            hard: {
              "services.loadbalancers": String(input.quota.maxLoadBalancers),
              "requests.storage": `${String(input.quota.maxStorageGb)}Gi`,
            },
          },
        },
      },
      {
        ref: {
          apiVersion: "v1",
          kind: "LimitRange",
          namespace: ns,
          name: "udp-defaults",
        },
        body: {
          metadata: { name: "udp-defaults", namespace: ns },
          spec: {
            limits: [
              {
                type: "Container",
                defaultRequest: { cpu: "100m", memory: "128Mi" },
                default: { cpu: "500m", memory: "512Mi" },
              },
            ],
          },
        },
      },
      role(ns, workload, WORKLOAD_RULES),
      roleBinding(ns, workload, workload),
      role(ns, traffic, TRAFFIC_RULES),
      roleBinding(ns, traffic, traffic),
      {
        ref: {
          apiVersion: "v1",
          kind: "Secret",
          namespace: ns,
          name: REGISTRY_PULL_SECRET,
        },
        body: {
          metadata: { name: REGISTRY_PULL_SECRET, namespace: ns, labels: meta },
          type: "kubernetes.io/dockerconfigjson",
          data: { ".dockerconfigjson": EMPTY_DOCKER_CONFIG },
        },
      },
      role(ns, `${tooling}-registry-pull`, TOOLING_ENV_RULES),
      roleBinding(ns, `${tooling}-registry-pull`, tooling),
    );
  }
  return out.map(withTypeMeta);
}

/** Verb và resource mà KHÔNG SA nào của UDP được có (§12.2 cột "cố tình không được phép") */
const FORBIDDEN_VERBS = ["*", "escalate", "bind", "impersonate"];
const FORBIDDEN_RESOURCES = ["*", "pods/exec", "pods/attach"];

/** Mọi vi phạm quy tắc §12.2 trong các Role/ClusterRole — rỗng là đạt */
export function rbacProblems(manifests: readonly Manifest[]): string[] {
  const problems: string[] = [];
  for (const m of manifests) {
    if (m.ref.kind !== "Role" && m.ref.kind !== "ClusterRole") continue;
    const rules = (m.body.rules ?? []) as PolicyRule[];
    // §12.2: "không `secrets` ngoài namespace của mình" — ba SA sống trong udp-system
    const ownNamespace =
      m.ref.kind === "Role" && m.ref.namespace === SYSTEM_NAMESPACE;
    /** Ngoại lệ DUY NHẤT (D-P26): đúng `udp-registry-pull`, chỉ đọc/sửa, trong một Role */
    const registryPullOnly = (r: PolicyRule): boolean =>
      m.ref.kind === "Role" &&
      r.resourceNames?.length === 1 &&
      r.resourceNames[0] === REGISTRY_PULL_SECRET &&
      r.verbs.every((v) => TOOLING_REGISTRY_PULL_VERBS.includes(v));
    for (const r of rules) {
      for (const v of r.verbs) {
        if (FORBIDDEN_VERBS.includes(v))
          problems.push(`${String(m.ref.name)}: verb ${v}`);
      }
      for (const res of r.resources) {
        if (
          FORBIDDEN_RESOURCES.includes(res) ||
          (res === "secrets" && !ownNamespace && !registryPullOnly(r))
        ) {
          problems.push(`${String(m.ref.name)}: resource ${res}`);
        }
      }
      if (r.apiGroups.includes("*"))
        problems.push(`${String(m.ref.name)}: apiGroup *`);
    }
  }
  return problems;
}
