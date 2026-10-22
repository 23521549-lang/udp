import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTERNAL_AUDIENCE,
  INTERNAL_CALLERS,
  type InternalTarget,
} from "@udp/config/constants";
import { envSchema } from "@udp/config/env-schema";
import { SEED_DEV_SERVER_KEY } from "@udp/db/seed-constants";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  generateSecrets,
  HOST_PORTS,
  IMAGES,
  imageRef,
  NAMESPACE,
  SAMPLE_NAMESPACE,
  SECRET_NAME,
} from "../src/cluster.js";
import {
  allContainersOf,
  byKind as byKindIn,
  containersOf,
  effectiveEnv,
  named,
  podWorkloads,
  POD_KINDS,
  render,
  templateOf,
  workloads as workloadsIn,
  type Resource,
} from "./kustomize.js";

/**
 * Plan #49 AC-1, AC-2: overlay `kind` dựng bằng `kubectl kustomize` THẬT rồi kiểm những điều mà một
 * cụm chạy lỗi mới lộ ra — cấu hình mà service từ chối, cổng lệch, probe sai đường, container chạy root,
 * NodePort không ra tới máy, nhãn `namespace` lệch dữ liệu seed. Cụm thật dựng ở CI (Plan #50).
 */

const here = dirname(fileURLToPath(import.meta.url));
const OVERLAY = resolve(here, "../k8s/overlays/kind");

let docs: Resource[];

beforeAll(() => {
  docs = render(OVERLAY).docs;
});

const byKind = (kind: string): Resource[] => byKindIn(docs, kind);
const workloads = (): Resource[] => workloadsIn(docs);
const UDP_SERVICES = ["core-backend", "flag-service", "pd-controller"];

interface RbacRule {
  apiGroups?: string[];
  resources: string[];
  verbs: string[];
}

/** [Plan #67] Quyền duy nhất mà bên nhận `/internal/*` cần thêm */
const TOKEN_REVIEW_RULE: RbacRule = {
  apiGroups: ["authentication.k8s.io"],
  resources: ["tokenreviews"],
  verbs: ["create"],
};

/** Mọi binding có subject là ServiceAccount `udp/<sa>`, và rule của role mà chúng trỏ tới */
function rulesBoundTo(
  rendered: readonly Resource[],
  sa: string,
): { bindings: string[]; rules: RbacRule[] } {
  const bindings = [
    ...byKindIn(rendered, "RoleBinding"),
    ...byKindIn(rendered, "ClusterRoleBinding"),
  ].filter((b) =>
    (
      b as unknown as {
        subjects?: { kind: string; name: string; namespace?: string }[];
      }
    ).subjects?.some(
      (s) =>
        s.kind === "ServiceAccount" &&
        s.name === sa &&
        s.namespace === NAMESPACE,
    ),
  );
  const rules = bindings.flatMap((b) => {
    const ref = (b as unknown as { roleRef: { kind: string; name: string } })
      .roleRef;
    return (
      named(rendered, ref.kind, ref.name) as unknown as {
        rules: RbacRule[];
      }
    ).rules;
  });
  return {
    bindings: bindings.map((b) => `${b.kind}/${b.metadata.name}`),
    rules,
  };
}

describe("overlay kind (Plan #49)", () => {
  /**
   * [Plan #63] Env THẬT của từng pod (`effectiveEnv` — ConfigMap, Secret, `env`, rồi biến service link của kubelet),
   * không phải ConfigMap + Secret ghép tay: bản ghép tay xanh trong khi pod thật nhận `CORE_BACKEND_PORT=tcp://…`.
   */
  it("env thật của từng service (ConfigMap, Secret sinh ra, biến của kubelet) qua CHÍNH schema env", () => {
    const secrets = { [SECRET_NAME]: generateSecrets() };
    // [Plan #67] Job `udp-migrate` (`sync-catalog`, `seed`) nạp cùng schema - luật production chạm cả nó
    const parsers = [
      ...UDP_SERVICES.map((name) => ["Deployment", name] as const),
      ["Job", "udp-migrate"] as const,
    ];
    for (const [kind, name] of parsers) {
      const parsed = envSchema.safeParse(
        effectiveEnv(docs, name, secrets, kind),
      );
      expect(
        parsed.success
          ? []
          : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        name,
      ).toEqual([]);
    }
  });

  it("mọi pod tắt biến service link; đủ tám workload, không kind nào khác mang pod template", () => {
    const pods = podWorkloads(docs);
    expect(pods.map((w) => `${w.kind}/${w.metadata.name}`).sort()).toEqual([
      "Deployment/core-backend",
      "Deployment/flag-service",
      "Deployment/pd-controller",
      "Deployment/portal",
      "Deployment/prometheus",
      "Deployment/sample-app",
      "Job/udp-migrate",
      "StatefulSet/postgres",
    ]);
    for (const w of pods) {
      expect(templateOf(w).spec.enableServiceLinks, w.metadata.name).toBe(
        false,
      );
    }
    const templated = docs.filter((d) => {
      const spec = d.spec as
        { template?: unknown; jobTemplate?: unknown } | undefined;
      return spec?.template !== undefined || spec?.jobTemplate !== undefined;
    });
    expect(templated.filter((d) => !POD_KINDS.includes(d.kind))).toEqual([]);
  });

  /**
   * Mô hình đúng hai chiều của kubelet: cờ tắt thì Service CÙNG namespace không sinh biến nào, nhưng Service
   * `kubernetes` vẫn được tiêm — `platform-probe.ts` của Service 1 đọc `KUBERNETES_SERVICE_HOST` để biết nó đang
   * chạy trong pod.
   */
  it("cờ tắt chỉ tắt biến của Service trong namespace; biến của Service kubernetes vẫn có", () => {
    const env = effectiveEnv(docs, "core-backend", {
      [SECRET_NAME]: generateSecrets(),
    });
    // `<SERVICE>_SERVICE_HOST` chỉ do kubelet sinh — ConfigMap của UDP dùng `*_URL`, không khoá nào như thế
    expect(
      Object.keys(env).filter((key) => key.endsWith("_SERVICE_HOST")),
    ).toEqual(["KUBERNETES_SERVICE_HOST"]);
    expect(env["KUBERNETES_SERVICE_PORT"]).toBe("443");
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

  it("[Plan #53] Service 1 chạy bằng ServiceAccount riêng với quyền CHỈ-ĐỌC — không verb ghi, không secret", () => {
    const s1 = workloads().find((w) => w.metadata.name === "core-backend");
    expect(
      (templateOf(s1 as Resource).spec as { serviceAccountName?: string })
        .serviceAccountName,
    ).toBe("core-backend");
    expect(
      byKind("ServiceAccount").map(
        (s) => `${s.metadata.namespace ?? ""}/${s.metadata.name}`,
      ),
    ).toContain(`${NAMESPACE}/core-backend`);

    // [Plan #67] Theo SUBJECT, không theo tên: một binding tên bất kỳ cấp thêm quyền cho Service 1 cũng phải lộ ra ở đây
    const bound = rulesBoundTo(docs, "core-backend");
    expect(bound.bindings.sort()).toEqual([
      "ClusterRoleBinding/udp-core-backend-node-read",
      "ClusterRoleBinding/udp-internal-token-review",
      "RoleBinding/core-backend-platform-read",
    ]);
    const isTokenReview = (rule: RbacRule) =>
      JSON.stringify(rule) === JSON.stringify(TOKEN_REVIEW_RULE);
    // Chỉ đọc, cộng đúng một quyền ghi: `tokenreviews: create` - một câu hỏi tới API server, không đổi trạng thái cụm
    expect(bound.rules.filter(isTokenReview)).toHaveLength(1);
    for (const rule of bound.rules.filter((r) => !isTokenReview(r))) {
      expect(rule.verbs.filter((v) => !["get", "list"].includes(v))).toEqual(
        [],
      );
      expect(rule.resources).not.toContain("secrets");
      expect(rule.resources.some((r) => r.includes("/"))).toBe(false);
    }
    const config = byKind("ConfigMap").find((c) =>
      c.metadata.name.startsWith("udp-config-"),
    );
    expect(config?.data?.["UDP_RELEASE"]).toBe("local");
    // [Plan #64] Postgres kèm cụm không có SSL — adapter tắt TLS ở chế độ này.
    expect(config?.data?.["UDP_DB_TLS_MODE"]).toBe("disable");
  });

  it("mọi tài nguyên của UDP nằm trong namespace udp", () => {
    const outside = docs.filter(
      (d) =>
        ![
          "Namespace",
          "ClusterRole",
          "ClusterRoleBinding",
          "ValidatingAdmissionPolicy",
          "ValidatingAdmissionPolicyBinding",
        ].includes(d.kind) &&
        d.metadata.namespace !== NAMESPACE &&
        d.metadata.name !== "sample-app",
    );
    expect(outside.map((d) => `${d.kind}/${d.metadata.name}`)).toEqual([]);
  });
});

/**
 * [Plan #65] Chỉ client của database mới tới được PostgreSQL trong cụm.
 *
 * Postgres kèm cụm không có TLS (`UDP_DB_TLS_MODE=disable`, Plan #64), nên NetworkPolicy `postgres-clients` là lớp
 * giữa mật khẩu role và một pod bất kỳ trong cụm. Bốn cách nó hỏng mà cụm vẫn chạy bình thường, và ô bắt từng cái:
 *
 *  - Một peer mở toang (`podSelector: {}`) hay một policy THỨ HAI chọn postgres - NetworkPolicy cộng dồn, nên chỉ
 *    soi `postgres-clients` là không đủ: ô hình dạng so cả policy bằng `toStrictEqual` và đòi đúng một policy chọn
 *    pod postgres; ô đối chứng chứng minh cổng bắt được cả hai.
 *  - Selector hay cổng lệch pod thật (policy chọn 0 pod là không chặn gì): lấy nhãn và `containerPort` từ chính
 *    StatefulSet.
 *  - Một workload mới nối database mà quên policy: trên k3s và kind nó không bao giờ nối được, và chỉ lộ trên cụm.
 *    Danh sách client dựng lại từ chuỗi kết nối trong manifest đã dựng, không từ một danh sách chép tay.
 *  - Nhãn thừa trong policy: một lối vào không ai dùng.
 *
 * Overlay `vm` dựng trần (không qua `releaseKustomization`): lớp phát hành chỉ ghim image và cấu hình, không thêm
 * workload hay policy nào.
 */
const DB_CLIENT_LABEL = "app.kubernetes.io/name";

interface LabelSelector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values: string[] }[];
}

interface PostgresPolicy {
  podSelector?: LabelSelector;
  policyTypes?: string[];
  ingress?: {
    from?: {
      podSelector?: LabelSelector;
      namespaceSelector?: unknown;
      ipBlock?: unknown;
    }[];
    ports?: { port: number | string; protocol?: string }[];
  }[];
}

const OVERLAYS = {
  kind: OVERLAY,
  vm: resolve(here, "../k8s/overlays/vm"),
} as const;
const built: Record<keyof typeof OVERLAYS, Resource[]> = { kind: [], vm: [] };

/**
 * Nhãn của mọi workload có container mang chuỗi kết nối: `envFrom` secret của UDP, biến `DATABASE_URL*`, hoặc biến
 * đọc khoá `DATABASE_URL*` của một secret. Pod postgres đọc `POSTGRES_PASSWORD` nên không bị tính nhầm là client.
 */
function dbClientLabels(rendered: readonly Resource[]): string[] {
  const labels = new Set<string>();
  for (const workload of podWorkloads(rendered)) {
    const usesDb = allContainersOf(workload).some(
      (c) =>
        (c.envFrom ?? []).some((e) => e.secretRef?.name === SECRET_NAME) ||
        (c.env ?? []).some(
          (v) =>
            v.name.startsWith("DATABASE_URL") ||
            (v.valueFrom?.secretKeyRef?.key.startsWith("DATABASE_URL") ??
              false),
        ),
    );
    if (!usesDb) continue;
    const label = templateOf(workload).metadata?.labels?.[DB_CLIENT_LABEL];
    if (label === undefined) {
      throw new Error(
        `${workload.kind}/${workload.metadata.name} nối database mà pod không có nhãn ${DB_CLIENT_LABEL}`,
      );
    }
    labels.add(label);
  }
  return [...labels].sort();
}

function postgresPodOf(rendered: readonly Resource[]): {
  labels: Record<string, string>;
  port: number;
} {
  const sets = byKindIn(rendered, "StatefulSet").filter(
    (s) => s.metadata.name === "postgres",
  );
  expect(sets, "đúng một StatefulSet postgres").toHaveLength(1);
  const template = templateOf(sets[0] as Resource);
  const port = template.spec.containers
    .flatMap((c) => c.ports ?? [])
    .find((p) => p.name === "postgres")?.containerPort;
  expect(port, "cổng tên `postgres` của container").toBeDefined();
  return { labels: template.metadata?.labels ?? {}, port: port as number };
}

/**
 * Policy có chọn pod mang các nhãn này không. `matchExpressions` không tự đánh giá ở đây: coi như CÓ chọn, để ô hình
 * dạng soi nó thay vì để nó lọt qua vì "không khớp".
 */
function selects(
  selector: LabelSelector | undefined,
  labels: Record<string, string>,
): boolean {
  if ((selector?.matchExpressions ?? []).length > 0) return true;
  return Object.entries(selector?.matchLabels ?? {}).every(
    ([k, v]) => labels[k] === v,
  );
}

function postgresPolicyOf(rendered: readonly Resource[]): PostgresPolicy {
  const pod = postgresPodOf(rendered);
  const touching = byKindIn(rendered, "NetworkPolicy").filter((p) =>
    selects((p.spec as PostgresPolicy).podSelector, pod.labels),
  );
  expect(
    touching.map((p) => p.metadata.name),
    "NetworkPolicy chọn pod postgres (chúng cộng dồn: mỗi cái là một lối vào)",
  ).toEqual(["postgres-clients"]);
  return (touching[0] as Resource).spec as PostgresPolicy;
}

function allowedLabels(policy: PostgresPolicy): string[] {
  return (policy.ingress ?? [])
    .flatMap((rule) => rule.from ?? [])
    .flatMap((peer) => peer.podSelector?.matchExpressions ?? [])
    .flatMap((e) => e.values)
    .sort();
}

function expectPolicyShape(rendered: readonly Resource[]): void {
  const pod = postgresPodOf(rendered);
  const policy = postgresPolicyOf(rendered);
  expect(policy).toStrictEqual({
    podSelector: {
      matchLabels: { [DB_CLIENT_LABEL]: pod.labels[DB_CLIENT_LABEL] },
    },
    policyTypes: ["Ingress"],
    ingress: [
      {
        from: [
          {
            podSelector: {
              matchExpressions: [
                {
                  key: DB_CLIENT_LABEL,
                  operator: "In",
                  values: expect.any(Array) as unknown,
                },
              ],
            },
          },
        ],
        ports: [{ port: pod.port, protocol: "TCP" }],
      },
    ],
  });
  const values = allowedLabels(policy);
  expect(values.length).toBeGreaterThan(0);
  expect(new Set(values).size, "không nhãn lặp").toBe(values.length);
}

describe("NetworkPolicy của PostgreSQL (Plan #65)", () => {
  beforeAll(() => {
    built.kind = render(OVERLAYS.kind).docs;
    built.vm = render(OVERLAYS.vm).docs;
  });

  for (const name of ["kind", "vm"] as const) {
    it(`${name}: đúng một policy chọn postgres, một peer podSelector theo danh sách, đúng cổng của container`, () => {
      expectPolicyShape(built[name]);
    });

    it(`${name}: mọi workload mang chuỗi kết nối đều được policy cho qua`, () => {
      const allowed = new Set(allowedLabels(postgresPolicyOf(built[name])));
      const clients = dbClientLabels(built[name]);
      expect(clients.length).toBeGreaterThan(0);
      expect(clients.filter((c) => !allowed.has(c))).toEqual([]);
    });
  }

  it("không nhãn thừa: mỗi nhãn được phép là một client thật ở overlay vm (overlay đủ nhất)", () => {
    expect(allowedLabels(postgresPolicyOf(built.vm))).toEqual(
      dbClientLabels(built.vm),
    );
  });

  it("đối chứng của chính cổng: peer mở toang và policy thứ hai đều bị bắt", () => {
    const policy = byKindIn(built.vm, "NetworkPolicy").find(
      (p) => p.metadata.name === "postgres-clients",
    ) as Resource;
    const wideOpen = structuredClone(policy);
    (wideOpen.spec as PostgresPolicy).ingress?.[0]?.from?.push({
      podSelector: {},
    });
    const withWideOpen = built.vm.map((r) => (r === policy ? wideOpen : r));
    expect(() => {
      expectPolicyShape(withWideOpen);
    }).toThrow();

    const second: Resource = {
      ...policy,
      metadata: { ...policy.metadata, name: "allow-all" },
      spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{}] },
    };
    expect(() => postgresPolicyOf([...built.vm, second])).toThrow();
  });
});

/**
 * [Plan #66] Cổng nội bộ của Service 1 và Service 2 - chỉ bên gọi thật tới được.
 *
 * Năm cách nó hỏng mà cụm vẫn chạy, và ô bắt từng cái:
 *
 *  - Service nội bộ đổi sang NodePort, hay một Service công khai mang thêm cổng nội bộ: cổng lộ ra IP của node.
 *  - Cổng của Service, `containerPort` tên `internal` và `*_INTERNAL_PORT` trong ConfigMap lệch nhau: chốt
 *    `internalPortOnly` đọc cổng PHÍA POD, nên lệch là `/internal` 404 ở mọi bên gọi.
 *  - `*_URL` trỏ cổng công khai: mọi lời gọi nội bộ 404.
 *  - Luật 1 của policy có `from` (chặn Traefik, NodePort, Prometheus), hay luật 2 lệch bên gọi thật. Bên gọi dựng từ
 *    MÃ: service nào đọc `env.CORE_BACKEND_URL`/`env.FLAG_SERVICE_URL` - không từ một danh sách chép tay.
 *  - Tên Service sinh biến service link trùng khoá cấu hình (`core-backend-internal` ⇒ `CORE_BACKEND_INTERNAL_PORT`):
 *    hôm nay `enableServiceLinks: false` che nó, ô này không để nó phụ thuộc vào một cờ.
 */
const SERVICES_SRC = resolve(here, "../../services");

interface Exposed {
  name: string;
  urlKey: string;
  publicPort: number;
  internalPortKey: string;
}

const EXPOSED: readonly Exposed[] = [
  {
    name: "core-backend",
    urlKey: "CORE_BACKEND_URL",
    publicPort: 3001,
    internalPortKey: "CORE_BACKEND_INTERNAL_PORT",
  },
  {
    name: "flag-service",
    urlKey: "FLAG_SERVICE_URL",
    publicPort: 3002,
    internalPortKey: "FLAG_SERVICE_INTERNAL_PORT",
  },
];

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Service (theo tên thư mục, cũng là nhãn `app.kubernetes.io/name`) có mã đọc `env.<urlKey>` - trừ chính nó */
function callersOf(target: Exposed): string[] {
  return readdirSync(SERVICES_SRC)
    .filter((dir) => dir !== target.name)
    .filter((dir) =>
      tsFilesUnder(join(SERVICES_SRC, dir, "src")).some((file) =>
        readFileSync(file, "utf8").includes(`env.${target.urlKey}`),
      ),
    )
    .sort();
}

function configOf(rendered: readonly Resource[]): Record<string, string> {
  const config = byKindIn(rendered, "ConfigMap").find((c) =>
    c.metadata.name.startsWith("udp-config"),
  );
  return config?.data ?? {};
}

interface ServicePortSpec {
  name?: string;
  port: number;
  targetPort?: number | string;
  nodePort?: number;
}

describe("cổng nội bộ của Service 1 và Service 2 (Plan #66)", () => {
  const overlays = {
    kind: OVERLAY,
    vm: resolve(here, "../k8s/overlays/vm"),
  } as const;
  const rendered: Record<keyof typeof overlays, Resource[]> = {
    kind: [],
    vm: [],
  };
  beforeAll(() => {
    rendered.kind = render(overlays.kind).docs;
    rendered.vm = render(overlays.vm).docs;
  });

  it("bên gọi dựng từ mã: Service 1 ← Service 3; Service 2 ← Service 1, Service 3", () => {
    expect(callersOf(EXPOSED[0] as Exposed)).toEqual(["pd-controller"]);
    expect(callersOf(EXPOSED[1] as Exposed)).toEqual([
      "core-backend",
      "pd-controller",
    ]);
  });

  for (const name of ["kind", "vm"] as const) {
    for (const target of EXPOSED) {
      it(`${name}: ${target.name} - Service nội bộ ClusterIP, cổng khớp containerPort và ConfigMap, URL trỏ nó`, () => {
        const docs = rendered[name];
        const config = configOf(docs);
        const internalPort = Number(config[target.internalPortKey]);
        expect(internalPort).toBeGreaterThan(0);
        expect(internalPort).not.toBe(target.publicPort);

        const service = named(docs, "Service", `internal-${target.name}`);
        const spec = service.spec as {
          type?: string;
          ports: ServicePortSpec[];
        };
        expect(spec.type ?? "ClusterIP").toBe("ClusterIP");
        expect(spec.ports).toEqual([
          { name: "internal", port: internalPort, targetPort: "internal" },
        ]);

        const [container] = containersOf(
          named(docs, "Deployment", target.name),
        );
        expect(
          container?.ports?.find((p) => p.name === "internal")?.containerPort,
        ).toBe(internalPort);
        expect(config[target.urlKey]).toBe(
          `http://internal-${target.name}:${String(internalPort)}`,
        );
      });

      it(`${name}: ${target.name} - luật 1 mở cổng công khai cho mọi nguồn, luật 2 mở cổng nội bộ chỉ cho bên gọi`, () => {
        const docs = rendered[name];
        const internalPort = Number(configOf(docs)[target.internalPortKey]);
        const policies = byKindIn(docs, "NetworkPolicy").filter(
          (p) =>
            (p.spec as PostgresPolicy).podSelector?.matchLabels?.[
              DB_CLIENT_LABEL
            ] === target.name,
        );
        expect(policies.map((p) => p.metadata.name)).toEqual([
          `${target.name}-ingress`,
        ]);
        expect((policies[0] as Resource).spec).toStrictEqual({
          podSelector: { matchLabels: { [DB_CLIENT_LABEL]: target.name } },
          policyTypes: ["Ingress"],
          ingress: [
            { ports: [{ port: target.publicPort, protocol: "TCP" }] },
            {
              from: [
                {
                  podSelector: {
                    matchExpressions: [
                      {
                        key: DB_CLIENT_LABEL,
                        operator: "In",
                        values: callersOf(target),
                      },
                    ],
                  },
                },
              ],
              ports: [{ port: internalPort, protocol: "TCP" }],
            },
          ],
        });
      });
    }

    it(`${name}: không Service NodePort hay LoadBalancer nào mang cổng nội bộ`, () => {
      const docs = rendered[name];
      const config = configOf(docs);
      const internalPorts = EXPOSED.map((t) =>
        Number(config[t.internalPortKey]),
      );
      const leaks = byKindIn(docs, "Service").flatMap((s) => {
        const spec = s.spec as { type?: string; ports?: ServicePortSpec[] };
        if (spec.type !== "NodePort" && spec.type !== "LoadBalancer") return [];
        return (spec.ports ?? [])
          .filter(
            (p) =>
              p.targetPort === "internal" ||
              internalPorts.includes(p.port) ||
              internalPorts.includes(Number(p.targetPort)),
          )
          .map((p) => `${s.metadata.name}:${String(p.port)}`);
      });
      expect(leaks).toEqual([]);
    });

    it(`${name}: tên Service nội bộ không sinh biến service link trùng khoá cấu hình`, () => {
      // Chỉ Service mới của đợt này: `core-backend` ⇒ `CORE_BACKEND_PORT` là va chạm có từ trước, Plan #63 chặn nó
      // bằng `enableServiceLinks: false` ở mọi pod và có cổng riêng cho cờ đó.
      const inner = envSchema.innerType();
      const keys = new Set(
        Object.keys((inner as unknown as { shape: object }).shape),
      );
      const internalServices = byKindIn(rendered[name], "Service").filter((s) =>
        s.metadata.name.startsWith("internal-"),
      );
      expect(internalServices).toHaveLength(EXPOSED.length);
      const clashes = internalServices.flatMap((s) => {
        const prefix = s.metadata.name.toUpperCase().replace(/-/g, "_");
        return [
          `${prefix}_PORT`,
          `${prefix}_SERVICE_HOST`,
          `${prefix}_SERVICE_PORT`,
        ].filter((k) => keys.has(k));
      });
      expect(clashes).toEqual([]);
    });
  }
});

/**
 * [Plan #67] Danh tính bên gọi `/internal/*`: token chiếu của ServiceAccount, `TokenReview`, và policy khoá ba
 * ServiceAccount. Cách nó hỏng mà cụm vẫn chạy, và ô bắt từng cái:
 *
 *  - `INTERNAL_CALLERS` (bên nhận đòi ai) lệch bên gọi thật trong mã, hay lệch volume `projected` (bên gọi mang token
 *    cho đích nào): lời gọi hợp lệ bị 401, hoặc một token thừa nằm trong pod không cần nó.
 *  - Audience trong manifest lệch `INTERNAL_AUDIENCE`: mọi lời gọi 401.
 *  - Quyền `tokenreviews` rộng ra (thêm subject, thêm verb, `system:auth-delegator`).
 *  - Policy bị bỏ, đổi sang `Warn`, hay quên một loại workload hoặc subresource: danh tính lại thành "ai tạo được pod".
 *  - Một workload khác đặt tên bắt đầu bằng tiền tố của ba Deployment: luật `exec` theo tên pod chặn nhầm nó.
 */
const TARGETS = Object.keys(INTERNAL_AUDIENCE) as InternalTarget[];
const CALLER_SERVICES = ["core-backend", "flag-service", "pd-controller"];

interface ProjectedSource {
  serviceAccountToken?: {
    audience?: string;
    expirationSeconds?: number;
    path: string;
  };
}

interface IdentityPodSpec {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  hostNetwork?: boolean;
  volumes?: {
    name: string;
    projected?: { sources: ProjectedSource[] };
    hostPath?: unknown;
  }[];
  containers: {
    volumeMounts?: { name: string; mountPath: string }[];
    securityContext?: { privileged?: boolean };
  }[];
}

const podSpecOf = (r: Resource): IdentityPodSpec =>
  templateOf(r).spec as unknown as IdentityPodSpec;

/** Các đích mà `service` gọi, theo `INTERNAL_CALLERS` */
const targetsCalledBy = (service: string): InternalTarget[] =>
  TARGETS.filter((t) => INTERNAL_CALLERS[t].includes(service));

describe("danh tính bên gọi /internal (Plan #67)", () => {
  const overlays = {
    kind: OVERLAY,
    vm: resolve(here, "../k8s/overlays/vm"),
  } as const;
  const rendered: Record<keyof typeof overlays, Resource[]> = {
    kind: [],
    vm: [],
  };
  beforeAll(() => {
    rendered.kind = render(overlays.kind).docs;
    rendered.vm = render(overlays.vm).docs;
  });

  it("INTERNAL_CALLERS khớp bên gọi dựng từ mã (cùng tập với NetworkPolicy của Plan #66)", () => {
    for (const target of EXPOSED) {
      expect(
        [...INTERNAL_CALLERS[target.name as InternalTarget]].sort(),
      ).toEqual(callersOf(target));
    }
    expect(EXPOSED.map((e) => e.name).sort()).toEqual([...TARGETS].sort());
  });

  for (const name of ["kind", "vm"] as const) {
    it(`${name}: mỗi service chạy bằng ServiceAccount cùng tên; Service 3 không gắn token mặc định`, () => {
      const accounts = byKindIn(rendered[name], "ServiceAccount").map(
        (a) => a.metadata.name,
      );
      for (const service of CALLER_SERVICES) {
        const spec = podSpecOf(named(rendered[name], "Deployment", service));
        expect(spec.serviceAccountName, service).toBe(service);
        expect(accounts).toContain(service);
        // Bên nhận gọi TokenReview bằng token mặc định; Service 3 không gọi API server của cụm UDP
        expect(spec.automountServiceAccountToken, service).toBe(
          service === "pd-controller" ? false : undefined,
        );
      }
    });

    it(`${name}: volume projected mang đúng token cho đúng đích, đúng audience, gắn ở INTERNAL_TOKEN_DIR`, () => {
      const config = configOf(rendered[name]);
      expect(config["INTERNAL_AUTH_MODE"]).toBe("token-review");
      const dir = config["INTERNAL_TOKEN_DIR"];
      for (const service of CALLER_SERVICES) {
        const spec = podSpecOf(named(rendered[name], "Deployment", service));
        const volume = spec.volumes?.find((v) => v.name === "internal-token");
        const expected = targetsCalledBy(service).map((t) => ({
          path: t,
          audience: INTERNAL_AUDIENCE[t],
        }));
        if (expected.length === 0) {
          expect(volume, service).toBeUndefined();
          continue;
        }
        const sources = (volume?.projected?.sources ?? []).map((s) => ({
          path: s.serviceAccountToken?.path,
          audience: s.serviceAccountToken?.audience,
        }));
        expect(sources, service).toEqual(expected);
        for (const s of volume?.projected?.sources ?? []) {
          // Tối thiểu của API server; kubelet xoay ở 80%
          expect(
            s.serviceAccountToken?.expirationSeconds,
          ).toBeGreaterThanOrEqual(600);
        }
        const mounts = spec.containers.flatMap((c) =>
          (c.volumeMounts ?? []).filter((m) => m.name === "internal-token"),
        );
        expect(
          mounts.map((m) => m.mountPath),
          service,
        ).toEqual([dir]);
      }
    });

    it(`${name}: tokenreviews chỉ ở một ClusterRole, đúng một verb, chỉ buộc vào bên nhận`, () => {
      const grants = [
        ...byKindIn(rendered[name], "Role"),
        ...byKindIn(rendered[name], "ClusterRole"),
      ].filter((r) =>
        (r as unknown as { rules: RbacRule[] }).rules.some(
          (rule) =>
            rule.resources.includes("tokenreviews") ||
            rule.resources.includes("*"),
        ),
      );
      expect(grants.map((r) => `${r.kind}/${r.metadata.name}`)).toEqual([
        "ClusterRole/udp-internal-token-review",
      ]);
      expect(
        (grants[0] as unknown as { rules: RbacRule[] }).rules,
      ).toStrictEqual([TOKEN_REVIEW_RULE]);
      const subjects = (
        named(
          rendered[name],
          "ClusterRoleBinding",
          "udp-internal-token-review",
        ) as unknown as { subjects: { name: string; namespace: string }[] }
      ).subjects;
      expect(subjects.map((x) => `${x.namespace}/${x.name}`).sort()).toEqual(
        TARGETS.map((t) => `${NAMESPACE}/${t}`).sort(),
      );
      for (const service of CALLER_SERVICES) {
        const has = rulesBoundTo(rendered[name], service).rules.some(
          (r) => JSON.stringify(r) === JSON.stringify(TOKEN_REVIEW_RULE),
        );
        expect(has, service).toBe(TARGETS.includes(service as InternalTarget));
      }
    });

    it(`${name}: ValidatingAdmissionPolicy khoá ba ServiceAccount - Deny, Fail, đủ loại workload và subresource`, () => {
      const policy = named(
        rendered[name],
        "ValidatingAdmissionPolicy",
        "udp-internal-identity",
      ) as unknown as {
        spec: {
          failurePolicy: string;
          matchConstraints: {
            namespaceSelector: { matchLabels: Record<string, string> };
            resourceRules: { resources: string[]; operations: string[] }[];
          };
          variables: { name: string; expression: string }[];
          validations: { expression: string }[];
        };
      };
      expect(policy.spec.failurePolicy).toBe("Fail");
      expect(
        policy.spec.matchConstraints.namespaceSelector.matchLabels,
      ).toEqual({ "kubernetes.io/metadata.name": NAMESPACE });
      const ops = new Map<string, string[]>();
      for (const rule of policy.spec.matchConstraints.resourceRules) {
        for (const r of rule.resources) ops.set(r, rule.operations);
      }
      const required: Record<string, string[]> = {
        pods: ["CREATE", "UPDATE"],
        replicationcontrollers: ["CREATE", "UPDATE"],
        "pods/exec": ["CONNECT"],
        "pods/attach": ["CONNECT"],
        "pods/ephemeralcontainers": ["UPDATE"],
        "serviceaccounts/token": ["CREATE"],
        serviceaccounts: ["DELETE"],
        configmaps: ["CREATE", "UPDATE", "DELETE"],
        secrets: ["CREATE", "UPDATE", "DELETE"],
        services: ["CREATE", "UPDATE", "DELETE"],
        deployments: ["CREATE", "UPDATE"],
        replicasets: ["CREATE", "UPDATE"],
        statefulsets: ["CREATE", "UPDATE"],
        daemonsets: ["CREATE", "UPDATE"],
        jobs: ["CREATE", "UPDATE"],
        cronjobs: ["CREATE", "UPDATE"],
        endpointslices: ["CREATE", "UPDATE", "DELETE"],
      };
      for (const [resource, operations] of Object.entries(required)) {
        expect([...(ops.get(resource) ?? [])].sort(), resource).toEqual(
          [...operations].sort(),
        );
      }
      const protectedNames = policy.spec.variables.find(
        (v) => v.name === "protected",
      )?.expression;
      expect(
        JSON.parse((protectedNames ?? "").replace(/'/g, '"')) as string[],
      ).toEqual(CALLER_SERVICES);
      expect(policy.spec.validations.length).toBeGreaterThanOrEqual(10);

      // Trường VẮNG MẶT khi rỗng (`subResource`, `name`) phải đọc qua `request.?`: truy cập thẳng là lỗi "no such key",
      // và với failurePolicy Fail thì lỗi là từ chối - lượt CI đầu của Plan #67 chặn cert-manager và job-controller
      const expressions = [
        ...policy.spec.variables.map((v) => v.expression),
        ...policy.spec.validations.map((v) => v.expression),
      ].join("\n");
      const direct = new Set(
        [...expressions.matchAll(/\brequest\.(\w+)/g)].map((m) => m[1]),
      );
      expect([...direct].sort()).toEqual(
        ["kind", "operation", "resource", "userInfo"].filter((f) =>
          direct.has(f),
        ),
      );
      expect(expressions).not.toMatch(/userInfo\.groups/);

      const binding = named(
        rendered[name],
        "ValidatingAdmissionPolicyBinding",
        "udp-internal-identity",
      ) as unknown as {
        spec: { policyName: string; validationActions: string[] };
      };
      expect(binding.spec).toEqual({
        policyName: "udp-internal-identity",
        validationActions: ["Deny"],
      });
    });

    it(`${name}: không workload nào khác mang tên bắt đầu bằng tiền tố của ba Deployment (luật exec theo tên pod)`, () => {
      const clash = podWorkloads(rendered[name]).filter(
        (w) =>
          !(
            w.kind === "Deployment" && CALLER_SERVICES.includes(w.metadata.name)
          ) && CALLER_SERVICES.some((p) => w.metadata.name.startsWith(`${p}-`)),
      );
      expect(clash.map((w) => `${w.kind}/${w.metadata.name}`)).toEqual([]);
    });

    it(`${name}: namespace udp cưỡng chế Pod Security baseline, và mọi pod của UDP qua được nó`, () => {
      expect(
        named(rendered[name], "Namespace", NAMESPACE).metadata.labels?.[
          "pod-security.kubernetes.io/enforce"
        ],
      ).toBe("baseline");
      const breaking = podWorkloads(rendered[name])
        .filter((w) => (w.metadata.namespace ?? NAMESPACE) === NAMESPACE)
        .filter((w) => {
          const spec = podSpecOf(w);
          return (
            spec.hostNetwork === true ||
            (spec.volumes ?? []).some((v) => v.hostPath !== undefined) ||
            spec.containers.some((c) => c.securityContext?.privileged === true)
          );
        });
      expect(breaking.map((w) => `${w.kind}/${w.metadata.name}`)).toEqual([]);
    });
  }
});
