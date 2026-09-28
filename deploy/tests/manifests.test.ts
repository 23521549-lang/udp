import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envSchema } from "@udp/config/env-schema";
import { SEED_DEV_SERVER_KEY } from "@udp/db/seed-constants";
import { beforeAll, describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import {
  generateSecrets,
  HOST_PORTS,
  IMAGES,
  imageRef,
  NAMESPACE,
  SAMPLE_NAMESPACE,
  SECRET_NAME,
} from "../src/cluster.js";

/**
 * Plan #49 AC-1, AC-2: overlay `kind` dựng bằng `kubectl kustomize` THẬT rồi kiểm những điều mà một
 * cụm chạy lỗi mới lộ ra — cấu hình mà service từ chối, cổng lệch, probe sai đường, container chạy root,
 * NodePort không ra tới máy, nhãn `namespace` lệch dữ liệu seed. Cụm thật dựng ở CI (Plan #50).
 */

const here = dirname(fileURLToPath(import.meta.url));
const OVERLAY = resolve(here, "../k8s/overlays/kind");

type Json = Record<string, unknown>;
interface Resource {
  kind: string;
  metadata: { name: string; namespace?: string };
  spec?: Json;
  data?: Record<string, string>;
}
interface Container {
  name: string;
  image: string;
  ports?: { name: string; containerPort: number }[];
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[];
  env?: {
    name: string;
    value?: string;
    valueFrom?: { secretKeyRef?: { name: string; key: string } };
  }[];
  readinessProbe?: { httpGet?: { path: string } };
  livenessProbe?: { httpGet?: { path: string } };
  resources?: { requests?: Json; limits?: Json };
}
interface PodTemplate {
  spec: {
    securityContext?: { runAsNonRoot?: boolean };
    containers: Container[];
  };
}

let docs: Resource[];

beforeAll(() => {
  const rendered = execFileSync("kubectl", ["kustomize", OVERLAY], {
    encoding: "utf8",
  });
  docs = parseAllDocuments(rendered).map((d) => d.toJS() as Resource);
});

const byKind = (kind: string): Resource[] =>
  docs.filter((d) => d.kind === kind);
const workloads = (): Resource[] =>
  docs.filter((d) => ["Deployment", "StatefulSet", "Job"].includes(d.kind));
const templateOf = (r: Resource): PodTemplate =>
  (r.spec as { template: PodTemplate }).template;
const containersOf = (r: Resource): Container[] =>
  templateOf(r).spec.containers;
const UDP_SERVICES = ["core-backend", "flag-service", "pd-controller"];

describe("overlay kind (Plan #49)", () => {
  it("cấu hình trong cụm (ConfigMap + secret sinh ra) qua CHÍNH schema env của mọi service", () => {
    const config = byKind("ConfigMap").find((c) =>
      c.metadata.name.startsWith("udp-config-"),
    );
    expect(config?.data).toBeDefined();
    const parsed = envSchema.safeParse({
      ...config?.data,
      ...generateSecrets(),
    });
    expect(
      parsed.success
        ? []
        : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ).toEqual([]);
  });

  it("image của UDP đúng tập build với tag local — không image nào phải kéo từ registry", () => {
    const ours = workloads()
      .flatMap(containersOf)
      .map((c) => c.image)
      .filter((image) => image.startsWith("udp/"));
    expect(new Set(ours)).toEqual(new Set(IMAGES.map(imageRef)));
  });

  it("S1/S2/S3 nhận cấu hình và bí mật; mọi khoá Secret được tham chiếu đều do script sinh", () => {
    const secretKeys = new Set(Object.keys(generateSecrets()));
    for (const name of UDP_SERVICES) {
      const deployment = byKind("Deployment").find(
        (d) => d.metadata.name === name,
      );
      const refs = containersOf(deployment as Resource)[0]?.envFrom ?? [];
      expect(
        refs.some((r) => r.configMapRef?.name.startsWith("udp-config-")),
        name,
      ).toBe(true);
      expect(
        refs.some((r) => r.secretRef?.name === SECRET_NAME),
        name,
      ).toBe(true);
    }
    const referenced = workloads()
      .flatMap(containersOf)
      .flatMap((c) => c.env ?? [])
      .map((e) => e.valueFrom?.secretKeyRef)
      .filter((ref) => ref !== undefined);
    for (const ref of referenced) {
      expect(ref.name).toBe(SECRET_NAME);
      expect(secretKeys.has(ref.key), ref.key).toBe(true);
    }
  });

  it("probe đúng đường của service; không container nào của UDP chạy root; mọi container có request/limit", () => {
    for (const name of UDP_SERVICES) {
      const c = containersOf(
        byKind("Deployment").find((d) => d.metadata.name === name) as Resource,
      )[0];
      expect(c?.readinessProbe?.httpGet?.path, name).toBe("/readyz");
      expect(c?.livenessProbe?.httpGet?.path, name).toBe("/healthz");
    }
    for (const w of workloads()) {
      for (const c of containersOf(w)) {
        expect(
          c.resources?.requests,
          `${w.metadata.name}/${c.name}`,
        ).toBeDefined();
        expect(
          c.resources?.limits,
          `${w.metadata.name}/${c.name}`,
        ).toBeDefined();
      }
      if (containersOf(w).some((c) => c.image.startsWith("udp/"))) {
        expect(
          templateOf(w).spec.securityContext?.runAsNonRoot,
          w.metadata.name,
        ).toBe(true);
      }
    }
  });

  it("cổng Service trỏ vào một cổng CÓ THẬT của container được chọn", () => {
    for (const service of byKind("Service")) {
      const spec = service.spec as {
        selector: Record<string, string>;
        ports: { targetPort: string | number }[];
      };
      const target = workloads().find((w) => {
        const labels = (
          w.spec as {
            template: { metadata: { labels: Record<string, string> } };
          }
        ).template.metadata.labels;
        return (
          w.metadata.namespace === service.metadata.namespace &&
          Object.entries(spec.selector).every(([k, v]) => labels[k] === v)
        );
      });
      expect(target, service.metadata.name).toBeDefined();
      const ports = containersOf(target as Resource).flatMap(
        (c) => c.ports ?? [],
      );
      for (const p of spec.ports) {
        expect(
          ports.some(
            (cp) =>
              cp.name === p.targetPort || cp.containerPort === p.targetPort,
          ),
          `${service.metadata.name} → ${String(p.targetPort)}`,
        ).toBe(true);
      }
    }
  });

  it("NodePort của Portal và Service 2 ra tới máy qua extraPortMappings của kind", () => {
    const cluster = parse(
      readFileSync(resolve(here, "../kind/cluster.yaml"), "utf8"),
    ) as {
      nodes: {
        extraPortMappings?: { containerPort: number; hostPort: number }[];
      }[];
    };
    const mapped = new Map(
      cluster.nodes
        .flatMap((n) => n.extraPortMappings ?? [])
        .map((m) => [m.containerPort, m.hostPort]),
    );
    const nodePorts = byKind("Service").flatMap((s) =>
      (s.spec as { ports: { nodePort?: number }[] }).ports
        .map((p) => p.nodePort)
        .filter((p): p is number => p !== undefined)
        .map((p) => [s.metadata.name, p] as const),
    );
    expect(nodePorts.map(([name]) => name).sort()).toEqual([
      "flag-service",
      "portal",
    ]);
    // E2E và E9 gọi đúng cổng máy này — lệch là "connection refused" ở CI, không phải test đỏ ở đây
    expect(
      Object.fromEntries(nodePorts.map(([name, p]) => [name, mapped.get(p)])),
    ).toEqual({
      portal: HOST_PORTS.portal,
      "flag-service": HOST_PORTS.flagService,
    });
  });

  it("sample-app ở ĐÚNG namespace env dev của seed, và Prometheus gắn nhãn namespace từ pod", () => {
    const sample = byKind("Deployment").find(
      (d) => d.metadata.name === "sample-app",
    );
    expect(sample?.metadata.namespace).toBe(SAMPLE_NAMESPACE);
    // Key lệch seed ⇒ sample-app nhận 401 và không bao giờ có nhãn `ff` — E2E và E5 cùng đổ
    expect(
      containersOf(sample as Resource)[0]?.env?.find(
        (e) => e.name === "UDP_SDK_KEY",
      )?.value,
    ).toBe(SEED_DEV_SERVER_KEY);
    const promConfig = byKind("ConfigMap").find(
      (c) => c.metadata.name === "prometheus-config",
    );
    const prom = parse(promConfig?.data?.["prometheus.yml"] ?? "") as {
      scrape_configs: {
        job_name: string;
        relabel_configs?: { source_labels?: string[]; target_label?: string }[];
      }[];
    };
    const pods = prom.scrape_configs.find(
      (j) => j.job_name === "kubernetes-pods",
    );
    expect(
      pods?.relabel_configs?.some(
        (r) =>
          r.source_labels?.includes("__meta_kubernetes_namespace") &&
          r.target_label === "namespace",
      ),
    ).toBe(true);
  });

  it("mọi tài nguyên của UDP nằm trong namespace udp", () => {
    const outside = docs.filter(
      (d) =>
        !["Namespace", "ClusterRole", "ClusterRoleBinding"].includes(d.kind) &&
        d.metadata.namespace !== NAMESPACE &&
        d.metadata.name !== "sample-app",
    );
    expect(outside.map((d) => `${d.kind}/${d.metadata.name}`)).toEqual([]);
  });
});
