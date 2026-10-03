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
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
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
