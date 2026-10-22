import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

/**
 * Dựng một kustomization bằng `kubectl kustomize` THẬT và đọc các tài nguyên — dùng chung cho test của overlay
 * kind (Plan #49) và bản phát hành của máy ảo (Plan #52).
 */

export type Json = Record<string, unknown>;

export interface Resource {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: Json;
  data?: Record<string, string>;
}

export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
    configMapKeyRef?: { name: string; key: string };
    fieldRef?: Json;
    resourceFieldRef?: Json;
  };
}

export interface Container {
  name: string;
  image: string;
  command?: string[];
  ports?: { name: string; containerPort: number }[];
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
  env?: EnvVar[];
  readinessProbe?: { httpGet?: { path: string } };
  livenessProbe?: { httpGet?: { path: string } };
  resources?: { requests?: Json; limits?: Json };
}

export interface PodTemplate {
  metadata?: { labels?: Record<string, string> };
  spec: {
    enableServiceLinks?: boolean;
    securityContext?: { runAsNonRoot?: boolean };
    initContainers?: Container[];
    containers: Container[];
  };
}

export function render(dir: string): { docs: Resource[]; text: string } {
  const text = execFileSync("kubectl", ["kustomize", dir], {
    encoding: "utf8",
  });
  return {
    docs: parseAllDocuments(text).map((d) => d.toJS() as Resource),
    text,
  };
}

export const byKind = (docs: readonly Resource[], kind: string): Resource[] =>
  docs.filter((d) => d.kind === kind);

export function named(
  docs: readonly Resource[],
  kind: string,
  name: string,
): Resource {
  const found = docs.find((d) => d.kind === kind && d.metadata.name === name);
  if (found === undefined) throw new Error(`không có ${kind}/${name}`);
  return found;
}

export const workloads = (docs: readonly Resource[]): Resource[] =>
  docs.filter((d) => ["Deployment", "StatefulSet", "Job"].includes(d.kind));

/** Pod template của Deployment/StatefulSet/Job, và của CronJob qua `jobTemplate` */
export function templateOf(r: Resource): PodTemplate {
  const spec = r.spec as {
    template?: PodTemplate;
    jobTemplate?: { spec: { template: PodTemplate } };
  };
  const template = spec.template ?? spec.jobTemplate?.spec.template;
  if (template === undefined)
    throw new Error(`${r.kind} không có pod template`);
  return template;
}

export const containersOf = (r: Resource): Container[] =>
  templateOf(r).spec.containers;

/** Mọi container kể cả init — nơi image và bí mật cũng được tham chiếu */
export const allContainersOf = (r: Resource): Container[] => [
  ...(templateOf(r).spec.initContainers ?? []),
  ...templateOf(r).spec.containers,
];

/** Bốn kind mang pod template trong bản triển khai của UDP — CronJob qua `jobTemplate` */
export const POD_KINDS = ["Deployment", "StatefulSet", "Job", "CronJob"];

export const podWorkloads = (docs: readonly Resource[]): Resource[] =>
  docs.filter((d) => POD_KINDS.includes(d.kind));

interface ServicePort {
  name?: string;
  port: number;
  protocol?: string;
}

/** ClusterIP giữ chỗ: API server cấp lúc tạo Service, manifest không có */
const CLUSTER_IP = "10.96.0.10";

/** Tên biến của kubelet (`makeEnvVariableName`): chữ hoa, `-` thành `_` — áp cho tên Service lẫn tên cổng */
const envNameOf = (name: string): string =>
  name.toUpperCase().replaceAll("-", "_");

/**
 * Biến "service link" của MỘT Service, đúng như `pkg/kubelet/envvars` (v1.34): `<TÊN>_SERVICE_HOST`,
 * `<TÊN>_SERVICE_PORT` (cổng đầu), `<TÊN>_SERVICE_PORT_<TÊN CỔNG>` cho cổng có tên, `<TÊN>_PORT` (URL của cổng đầu), và
 * với MỖI cổng nhóm `<TÊN>_PORT_<số cổng>_<PROTO>` cùng `_PROTO`, `_PORT`, `_ADDR`.
 */
function linkVariablesOf(
  service: string,
  ports: readonly ServicePort[],
): Record<string, string> {
  const [first] = ports;
  if (first === undefined) return {};
  const name = envNameOf(service);
  const url = (p: ServicePort): string =>
    `${(p.protocol ?? "TCP").toLowerCase()}://${CLUSTER_IP}:${String(p.port)}`;
  const env: Record<string, string> = {
    [`${name}_SERVICE_HOST`]: CLUSTER_IP,
    [`${name}_SERVICE_PORT`]: String(first.port),
    [`${name}_PORT`]: url(first),
  };
  for (const port of ports) {
    if (port.name !== undefined) {
      env[`${name}_SERVICE_PORT_${envNameOf(port.name)}`] = String(port.port);
    }
    const protocol = port.protocol ?? "TCP";
    const prefix = `${name}_PORT_${String(port.port)}_${protocol}`;
    env[prefix] = url(port);
    env[`${prefix}_PROTO`] = protocol.toLowerCase();
    env[`${prefix}_PORT`] = String(port.port);
    env[`${prefix}_ADDR`] = CLUSTER_IP;
  }
  return env;
}

/** Service `kubernetes` của namespace default: kubelet tiêm biến của nó BẤT KỂ `enableServiceLinks` */
const MASTER_SERVICE_ENV = linkVariablesOf("kubernetes", [
  { name: "https", port: 443 },
]);

/** Biến service link của mọi Service CÙNG namespace có ClusterIP (headless và ExternalName không sinh biến nào) */
function serviceLinkEnv(
  docs: readonly Resource[],
  namespace: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const service of byKind(docs, "Service")) {
    if (service.metadata.namespace !== namespace) continue;
    const spec = service.spec as {
      type?: string;
      clusterIP?: string;
      ports?: ServicePort[];
    };
    if (spec.clusterIP === "None" || spec.type === "ExternalName") continue;
    Object.assign(
      env,
      linkVariablesOf(service.metadata.name, spec.ports ?? []),
    );
  }
  return env;
}

type Secrets = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Giá trị của một mục `env` có `valueFrom`: Secret và ConfigMap tra được; thứ do kubelet điền thì giữ chỗ */
function valueFromOf(
  docs: readonly Resource[],
  e: EnvVar,
  secrets: Secrets,
): string {
  const secret = e.valueFrom?.secretKeyRef;
  if (secret !== undefined) {
    return (
      secrets[secret.name]?.[secret.key] ??
      `<secret ${secret.name}/${secret.key}>`
    );
  }
  const config = e.valueFrom?.configMapKeyRef;
  if (config !== undefined) {
    return named(docs, "ConfigMap", config.name).data?.[config.key] ?? "";
  }
  return `<${e.name} do kubelet điền>`;
}

/**
 * [Plan #63 QĐ-5] Env THẬT của container chính của một Deployment, theo đúng thứ tự của kubelet
 * (`kubelet_pods.go`, `makeEnvironmentVariables`): `envFrom` theo thứ tự; MỌI mục `env` đè lên và chiếm khoá (kể cả
 * `valueFrom`); rồi biến service link lấp những khoá CHƯA có — của mọi Service cùng namespace khi pod không tắt
 * `enableServiceLinks`, và của Service `kubernetes` bất kể cờ.
 *
 * Bản trước (của `vm.test.ts`) dừng ở bước hai, nên test xanh trong khi pod thật nhận `CORE_BACKEND_PORT=tcp://…` từ
 * Service `core-backend` và chết ở `@udp/config` (lượt CI 37154337078, job `vm`).
 */
export function effectiveEnv(
  docs: readonly Resource[],
  deployment: string,
  secrets: Secrets,
  /** [Plan #67] Job `udp-migrate` cũng parse env bằng `@udp/config` */
  kind: "Deployment" | "Job" = "Deployment",
): Record<string, string> {
  const workload = named(docs, kind, deployment);
  const [container] = containersOf(workload);
  const env: Record<string, string> = {};
  for (const ref of container?.envFrom ?? []) {
    if (ref.configMapRef !== undefined) {
      Object.assign(env, named(docs, "ConfigMap", ref.configMapRef.name).data);
    }
    if (ref.secretRef !== undefined) {
      Object.assign(env, secrets[ref.secretRef.name]);
    }
  }
  for (const e of container?.env ?? []) {
    env[e.name] = e.value ?? valueFromOf(docs, e, secrets);
  }
  const links = {
    ...(templateOf(workload).spec.enableServiceLinks === false
      ? {}
      : serviceLinkEnv(docs, workload.metadata.namespace)),
    ...MASTER_SERVICE_ENV,
  };
  for (const [key, value] of Object.entries(links)) {
    env[key] ??= value;
  }
  return env;
}
