import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envSchema } from "@udp/config/env-schema";
import { flaggerGatePath } from "@udp/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  generateSecrets,
  imageRefWithTag,
  NAMESPACE,
  SECRET_NAME,
} from "../src/cluster.js";
import {
  BACKUP_SECRET,
  backupSecretValues,
  generateVmSecrets,
  issuerName,
  OIDC_PATH,
  parseVmSettings,
  PLACEHOLDER_HOST,
  PUBLIC_ROUTES,
  publicOrigin,
  recoveryMismatches,
  releaseKustomization,
  releaseTag,
  TLS_SECRET,
  VM_IMAGES,
  type VmSettings,
} from "../src/vm.js";
import {
  allContainersOf,
  byKind,
  named,
  render,
  templateOf,
  workloads,
  type Resource,
} from "./kustomize.js";

/**
 * Plan #52 AC-1, AC-2 — bản phát hành của máy ảo dựng bằng `kubectl kustomize` THẬT từ overlay `vm` và
 * `releaseKustomization`, rồi kiểm những điều mà chỉ một máy công khai chạy lỗi mới lộ ra: cấu hình mà service từ
 * chối, một đường nội bộ ra Internet, giá trị giữ chỗ còn sót, chứng chỉ cho sai host, bản sao lưu không có quyền.
 * Cụm thật dựng ở job `vm` của CI.
 */

const here = dirname(fileURLToPath(import.meta.url));
const K8S = resolve(here, "../k8s");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SETTINGS_TEXT = [
  "UDP_PUBLIC_HOST=udp-demo.duckdns.org",
  "ACME_EMAIL=ops@example.com",
  "UDP_BACKUP_UPLOAD_URL=https://objectstorage.ap-singapore-1.oraclecloud.com/p/tok/n/ns/b/udp-backup/o/",
].join("\n");
const settings = parseVmSettings(SETTINGS_TEXT);

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const posix = (path: string): string => path.replaceAll("\\", "/");

function renderRelease(s: VmSettings): { docs: Resource[]; text: string } {
  const dir = mkdtempSync(join(K8S, ".release-"));
  tempDirs.push(dir);
  const kustomization = releaseKustomization({
    sha: SHA,
    settings: s,
    overlay: posix(relative(dir, join(K8S, "overlays/vm"))),
    selfSignedComponent: posix(
      relative(dir, join(K8S, "components/self-signed-tls")),
    ),
  });
  writeFileSync(
    join(dir, "kustomization.yaml"),
    JSON.stringify(kustomization, null, 2),
  );
  return render(dir);
}

/** Env thật của container đầu: `envFrom` theo thứ tự, rồi `env` đè lên (luật của Kubernetes) */
function effectiveEnv(
  docs: readonly Resource[],
  deployment: string,
  secrets: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Record<string, string> {
  const [container] = allContainersOf(named(docs, "Deployment", deployment));
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
    if (e.value !== undefined) env[e.name] = e.value;
  }
  return env;
}

interface IngressSpec {
  ingressClassName: string;
  tls: { hosts: string[]; secretName: string }[];
  rules: {
    host: string;
    http: {
      paths: {
        path: string;
        pathType: string;
        backend: { service: { name: string; port: { name: string } } };
      }[];
    };
  }[];
}

const ingressOf = (docs: readonly Resource[]): Resource =>
  named(docs, "Ingress", "udp");
const ingressSpec = (docs: readonly Resource[]): IngressSpec =>
  ingressOf(docs).spec as unknown as IngressSpec;

/** Service nhận một đường theo luật `Prefix` của Ingress: tiền tố khớp theo phần tử, dài nhất thắng */
function routeFor(docs: readonly Resource[], path: string): string {
  const paths = ingressSpec(docs).rules[0]?.http.paths ?? [];
  const matches = paths.filter(
    (p) => p.path === "/" || path === p.path || path.startsWith(`${p.path}/`),
  );
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.backend.service.name ?? "(không route)";
}

describe("vm.env (Plan #52 QĐ-4)", () => {
  it("tệp tối thiểu đọc được; issuer mặc định là Let's Encrypt thật", () => {
    expect(settings.TLS_ISSUER).toBe("letsencrypt");
    expect(publicOrigin(settings)).toBe("https://udp-demo.duckdns.org");
  });

  it("từ chối host có scheme, cổng, chữ hoa, dấu chấm cuối, một nhãn, hay còn là giá trị giữ chỗ", () => {
    for (const host of [
      "https://udp.example.com",
      "udp.example.com:443",
      "UDP.example.com",
      "udp.example.com.",
      "localhost",
      PLACEHOLDER_HOST,
    ]) {
      expect(
        () =>
          parseVmSettings(SETTINGS_TEXT.replace("udp-demo.duckdns.org", host)),
        host,
      ).toThrow("UDP_PUBLIC_HOST");
    }
  });

  it("từ chối đích sao lưu không kết thúc bằng `/` hay không phải http(s), và tên biến gõ sai", () => {
    expect(() => parseVmSettings(SETTINGS_TEXT.replace(/o\/$/, "o"))).toThrow(
      "UDP_BACKUP_UPLOAD_URL",
    );
    expect(() =>
      parseVmSettings(
        SETTINGS_TEXT.replace("https://objectstorage", "ftp://objectstorage"),
      ),
    ).toThrow("UDP_BACKUP_UPLOAD_URL");
    expect(() =>
      parseVmSettings(`${SETTINGS_TEXT}\nTLS_ISSUR=self-signed`),
    ).toThrow();
  });

  it("khoá khôi phục phải đúng dạng mà service đòi — KEK sai độ dài bị chặn TRƯỚC khi vào Secret", () => {
    expect(() => parseVmSettings(`${SETTINGS_TEXT}\nUDP_KEK_V1=AAAA`)).toThrow(
      "UDP_KEK_V1",
    );
  });
});

describe("releaseTag (Plan #52 QĐ-3)", () => {
  it("12 ký tự đầu của SHA đầy đủ; từ chối SHA rút gọn, chữ hoa hay không phải hex", () => {
    expect(releaseTag(SHA)).toBe("0123456789ab");
    for (const bad of [
      SHA.slice(0, 12),
      SHA.toUpperCase(),
      `${SHA.slice(1)}g`,
    ]) {
      expect(() => releaseTag(bad), bad).toThrow("SHA");
    }
  });
});

describe("bí mật của máy ảo (Plan #52 QĐ-7, QĐ-8)", () => {
  it("bộ của #49 cộng khoá ký OIDC; khoá khôi phục trong vm.env thay khoá sinh mới", () => {
    const fresh = generateVmSecrets(settings);
    expect(Object.keys(fresh).sort()).toEqual(
      [...Object.keys(generateSecrets()), "UDP_OIDC_SIGNING_KEY"].sort(),
    );
    const kek = Buffer.alloc(32, 7).toString("base64");
    const recovered = generateVmSecrets(
      parseVmSettings(`${SETTINGS_TEXT}\nUDP_KEK_V1=${kek}`),
    );
    expect(recovered["UDP_KEK_V1"]).toBe(kek);
  });

  it("khoá khôi phục KHÁC Secret đang chạy được báo ra; trùng hay chưa có thì im", () => {
    const kek = Buffer.alloc(32, 7).toString("base64");
    const withKek = parseVmSettings(`${SETTINGS_TEXT}\nUDP_KEK_V1=${kek}`);
    expect(recoveryMismatches(settings, () => "khác")).toEqual([]);
    expect(recoveryMismatches(withKek, () => null)).toEqual([]);
    expect(recoveryMismatches(withKek, () => kek)).toEqual([]);
    expect(recoveryMismatches(withKek, () => "khác")).toEqual(["UDP_KEK_V1"]);
  });
});

describe("bản phát hành vm — Let's Encrypt (Plan #52 AC-1)", () => {
  let docs: Resource[];
  let text: string;
  const secrets: Record<string, Record<string, string>> = {
    [SECRET_NAME]: generateVmSecrets(settings),
    [BACKUP_SECRET]: backupSecretValues(settings),
  };
  const host = settings.UDP_PUBLIC_HOST;
  const origin = publicOrigin(settings);

  beforeAll(() => {
    ({ docs, text } = renderRelease(settings));
  });

  it("không còn giá trị giữ chỗ nào", () => {
    expect(text).not.toContain(PLACEHOLDER_HOST);
  });

  it("cấu hình TỪNG service qua CHÍNH envSchema, với URL công khai của máy", () => {
    for (const name of ["core-backend", "flag-service", "pd-controller"]) {
      const parsed = envSchema.safeParse(effectiveEnv(docs, name, secrets));
      expect(
        parsed.success
          ? []
          : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        name,
      ).toEqual([]);
    }
    const s1 = effectiveEnv(docs, "core-backend", secrets);
    expect(s1["CORS_ORIGIN"]).toBe(origin);
    expect(s1["COOKIE_SECURE"]).toBe("true");
    expect(s1["UDP_OIDC_ISSUER"]).toBe(`${origin}${OIDC_PATH}`);
    expect(s1["PD_CONTROLLER_WEBHOOK_URL"]).toBe(origin);
    expect(s1["MANAGED_CLOUDS"]).toBe("");
  });

  it("số proxy tin cậy đúng đường của từng service: S1 sau Traefik + nginx, S2 sau Traefik", () => {
    expect(
      effectiveEnv(docs, "core-backend", secrets)["TRUST_PROXY_HOPS"],
    ).toBe("2");
    expect(
      effectiveEnv(docs, "flag-service", secrets)["TRUST_PROXY_HOPS"],
    ).toBe("1");
  });

  it("image của UDP đúng bộ của máy ảo với tag của commit; image ngoài đều ghim phiên bản", () => {
    const images = [...workloads(docs), ...byKind(docs, "CronJob")]
      .flatMap(allContainersOf)
      .map((c) => c.image);
    expect(new Set(images.filter((i) => i.startsWith("udp/")))).toEqual(
      new Set(VM_IMAGES.map((i) => imageRefWithTag(i, releaseTag(SHA)))),
    );
    for (const image of images) {
      expect(image, image).toMatch(/:[^:/]+$/);
      expect(image, image).not.toMatch(/:latest$/);
    }
  });

  it("không dữ liệu demo trên máy công khai: không seed, không sample-app, không namespace nào khác", () => {
    const migrate = allContainersOf(named(docs, "Job", "udp-migrate"))[0];
    expect(migrate?.env?.find((e) => e.name === "UDP_SEED")?.value).toBe(
      "false",
    );
    expect(docs.some((d) => d.metadata.name === "sample-app")).toBe(false);
    expect(byKind(docs, "Namespace").map((n) => n.metadata.name)).toEqual([
      NAMESPACE,
    ]);
  });

  it("Ingress: đúng host, TLS cho host đó bằng issuer đã chọn, đúng bảng route công khai", () => {
    const spec = ingressSpec(docs);
    expect(spec.ingressClassName).toBe("traefik");
    expect(spec.rules.map((r) => r.host)).toEqual([host]);
    expect(spec.tls).toEqual([{ hosts: [host], secretName: TLS_SECRET }]);
    const issuer =
      ingressOf(docs).metadata.annotations?.["cert-manager.io/cluster-issuer"];
    expect(issuer).toBe(issuerName("letsencrypt"));
    expect(
      byKind(docs, "ClusterIssuer").some((i) => i.metadata.name === issuer),
    ).toBe(true);
    const routes = (spec.rules[0]?.http.paths ?? []).map((p) => ({
      prefix: p.path,
      service: p.backend.service.name,
      pathType: p.pathType,
    }));
    const key = (r: { prefix: string }): string => r.prefix;
    expect([...routes].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      [...PUBLIC_ROUTES]
        .map((r) => ({ ...r, pathType: "Prefix" }))
        .sort((a, b) => key(a).localeCompare(key(b))),
    );
  });

  it("mỗi backend của Ingress là một Service có thật với cổng mang đúng tên", () => {
    for (const p of ingressSpec(docs).rules[0]?.http.paths ?? []) {
      const service = named(docs, "Service", p.backend.service.name);
      const ports = (service.spec as { ports: { name: string }[] }).ports;
      expect(
        ports.some((port) => port.name === p.backend.service.port.name),
        p.path,
      ).toBe(true);
    }
  });

  it("đường công khai tới đúng service; đường nội bộ, số đo và probe KHÔNG tới service nào ngoài Portal", () => {
    const issuerPath = new URL(
      effectiveEnv(docs, "core-backend", secrets)["UDP_OIDC_ISSUER"] ?? "",
    ).pathname;
    const expected: Record<string, string> = {
      "/api/v1/auth/login": "portal",
      "/sdk/config": "flag-service",
      "/sdk/stream": "flag-service",
      "/ofrep/v1/evaluate/flags/checkout": "flag-service",
      // Hậu tố cố định của OpenID Discovery §4 sau issuer mà S1 phục vụ
      [`${issuerPath}/.well-known/openid-configuration`]: "core-backend",
      // Đường mà S1 ghi vào Canary của Flagger (packages/http/src/flagger-gate.ts)
      [flaggerGatePath("session-1", "confirm-promotion")]: "pd-controller",
      "/internal/flags": "portal",
      "/internal/clusters/x/token": "portal",
      "/metrics": "portal",
      "/healthz": "portal",
      "/readyz": "portal",
      "/sdkx": "portal",
    };
    for (const [path, service] of Object.entries(expected)) {
      expect(routeFor(docs, path), path).toBe(service);
    }
  });

  it("HTTP chuyển sang HTTPS bằng Middleware có thật mà annotation trỏ tới", () => {
    const ref =
      ingressOf(docs).metadata.annotations?.[
        "traefik.ingress.kubernetes.io/router.middlewares"
      ] ?? "";
    const middleware = named(docs, "Middleware", "redirect-https");
    expect(ref).toBe(
      `${middleware.metadata.namespace ?? ""}-${middleware.metadata.name}@kubernetescrd`,
    );
    expect(
      (middleware.spec as { redirectScheme: { scheme: string } }).redirectScheme
        .scheme,
    ).toBe("https");
  });

  it("issuer ACME mang email của máy; bản phát hành Let's Encrypt không kèm CA tự ký", () => {
    const acme = byKind(docs, "ClusterIssuer").filter(
      (i) => i.metadata.labels?.["udp.io/acme"] === "true",
    );
    expect(acme.map((i) => i.metadata.name).sort()).toEqual([
      "udp-letsencrypt",
      "udp-letsencrypt-staging",
    ]);
    for (const issuer of acme) {
      expect(
        (issuer.spec as { acme: { email: string } }).acme.email,
        issuer.metadata.name,
      ).toBe(settings.ACME_EMAIL);
      expect(issuer.metadata.namespace).toBeUndefined();
    }
    expect(
      byKind(docs, "ClusterIssuer").some(
        (i) => i.metadata.name === issuerName("self-signed"),
      ),
    ).toBe(false);
  });

  it("Traefik giữ IP của khách (externalTrafficPolicy Local) — rate limit đếm theo IP", () => {
    const config = named(docs, "HelmChartConfig", "traefik");
    expect(config.metadata.namespace).toBe("kube-system");
    const values = parse(
      (config.spec as { valuesContent: string }).valuesContent,
    ) as { service: { spec: { externalTrafficPolicy: string } } };
    expect(values.service.spec.externalTrafficPolicy).toBe("Local");
  });

  it("sao lưu: hằng ngày, không chồng lượt, không root, pg_dump CÙNG bản với server, bí mật có thật", () => {
    const cron = named(docs, "CronJob", "udp-backup");
    const spec = cron.spec as { schedule: string; concurrencyPolicy: string };
    expect(spec.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(spec.concurrencyPolicy).toBe("Forbid");
    expect(templateOf(cron).spec.securityContext?.runAsNonRoot).toBe(true);
    const [dump, upload] = allContainersOf(cron);
    const server = allContainersOf(named(docs, "StatefulSet", "postgres"))[0];
    expect(dump?.image).toBe(server?.image);
    expect(upload?.command?.join(" ")).toContain("${UDP_BACKUP_UPLOAD_URL}");
    for (const c of allContainersOf(cron)) {
      for (const e of c.env ?? []) {
        const ref = e.valueFrom?.secretKeyRef;
        if (ref === undefined) continue;
        expect(
          Object.keys(secrets[ref.name] ?? {}),
          `${ref.name}/${ref.key}`,
        ).toContain(ref.key);
      }
    }
  });

  it("mọi container kể cả init có request/limit; pod của UDP và của sao lưu không chạy root", () => {
    for (const w of [...workloads(docs), ...byKind(docs, "CronJob")]) {
      for (const c of allContainersOf(w)) {
        const where = `${w.metadata.name}/${c.name}`;
        expect(c.resources?.requests, where).toBeDefined();
        expect(c.resources?.limits, where).toBeDefined();
      }
      const ours = allContainersOf(w).some(
        (c) => c.image.startsWith("udp/") || w.kind === "CronJob",
      );
      if (ours) {
        expect(
          templateOf(w).spec.securityContext?.runAsNonRoot,
          w.metadata.name,
        ).toBe(true);
      }
    }
  });

  it("PostgreSQL có chỗ cho dữ liệu sống lâu", () => {
    const templates = (
      named(docs, "StatefulSet", "postgres").spec as {
        volumeClaimTemplates: {
          spec: { resources: { requests: { storage: string } } };
        }[];
      }
    ).volumeClaimTemplates;
    expect(templates[0]?.spec.resources.requests.storage).toBe("20Gi");
  });

  it("tài nguyên có namespace đều ở udp, trừ cấu hình Traefik của k3s", () => {
    const clusterScoped = [
      "Namespace",
      "ClusterRole",
      "ClusterRoleBinding",
      "ClusterIssuer",
    ];
    const outside = docs.filter(
      (d) =>
        !clusterScoped.includes(d.kind) &&
        d.kind !== "HelmChartConfig" &&
        d.metadata.namespace !== NAMESPACE,
    );
    expect(outside.map((d) => `${d.kind}/${d.metadata.name}`)).toEqual([]);
  });
});

describe("bản phát hành vm — CA tự ký của lượt CI (Plan #52 QĐ-11)", () => {
  it("chỉ khi được chọn: CA tự ký có mặt và Ingress xin chứng chỉ từ nó", () => {
    const selfSigned = parseVmSettings(
      `${SETTINGS_TEXT}\nTLS_ISSUER=self-signed`,
    );
    const { docs } = renderRelease(selfSigned);
    expect(
      ingressOf(docs).metadata.annotations?.["cert-manager.io/cluster-issuer"],
    ).toBe(issuerName("self-signed"));
    expect(
      byKind(docs, "ClusterIssuer").some(
        (i) => i.metadata.name === issuerName("self-signed"),
      ),
    ).toBe(true);
    const ca = named(docs, "Certificate", "udp-self-signed-ca");
    expect(ca.metadata.namespace).toBe("cert-manager");
    expect((ca.spec as { isCA: boolean }).isCA).toBe(true);
  });

  it("kustomization của bản phát hành chỉ kèm component khi được chọn", () => {
    const input = {
      sha: SHA,
      overlay: "../overlays/vm",
      selfSignedComponent: "../components/self-signed-tls",
    };
    expect(
      releaseKustomization({ ...input, settings })["components"],
    ).toBeUndefined();
    expect(
      releaseKustomization({
        ...input,
        settings: { ...settings, TLS_ISSUER: "self-signed" },
      })["components"],
    ).toEqual(["../components/self-signed-tls"]);
  });
});
