import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { HELM_CHART_PINS } from "@udp/config/helm-charts";
import { writeResult } from "@udp/experiments";
import { parse } from "yaml";
import { createRegistry } from "../src/modules/domain/domain-adapter.registry.js";

/**
 * **chart-values-audit** [Plan #61 61d-3c] — khoá `values` mà adapter đặt có TỒN TẠI trong chart hay không.
 *
 *   pnpm --filter @udp/core-backend measure:chart-values
 *
 * **Vì sao phép đo này tồn tại.** Helm **bỏ qua khoá nó không biết trong im lặng** — không cảnh báo, không lỗi. Đó
 * là chế độ hỏng mà 61d-3a đã trả giá một lần (`vpolExclude` của chart 3.9.x so với `policyExclude` của 3.2.x), và
 * nó tệ hơn một ghim không tải được: ghim hỏng thì job đỏ, còn khoá sai thì chart cài xong và **cấu hình không có
 * tác dụng**. Khi dò bảy ghim chết của 61d-3c tôi thử đối chiếu `values.yaml` thật của hai adapter và cả hai đều
 * lệch, nên câu hỏi "còn bao nhiêu adapter như vậy" phải được trả lời bằng một phép đếm, không bằng cảm giác.
 *
 * **Cách đo, và vì sao nó chỉ dùng interface công khai.** `values` là trường của `HelmAdapterSpec`, không phải
 * thành viên của `DomainAdapter`, nên không gọi trực tiếp được. Nhưng hiệu quả của nó quan sát được: `deploy` ghi
 * một ConfigMap `<release>-values` lên cụm, và cụm giả của bộ hợp đồng ghi lại. Nên phép đo gọi `deploy` đúng như
 * bộ hợp đồng gọi, rồi đọc lại giá trị.
 *
 * Adapter nào `configSchema` không parse được `{}` thì **bỏ qua kèm lý do** — phép đo không tự bịa cấu hình hợp lệ.
 *
 * Cần mạng (tải chart tarball) và một `.env` hợp lệ (nạp registry adapter kéo theo `@udp/config`). Không database,
 * không cụm.
 */

const { values: flags } = parseArgs({
  options: { note: { type: "string" } },
});

/**
 * Binding mà `values` của adapter đọc từ `ctx.resolved`.
 *
 * Không có chúng thì `values` của Spinnaker (`metrics.query`) và Tekton (`registry.oci`) ném, và phép đo bỏ qua
 * đúng hai adapter mà nó cần soi nhất. Danh sách này là phần giao của những capability mà một `values` thực tế đọc
 * — không phải mọi capability của §5.3.
 */
const RESOLVED = {
  "registry.oci": {
    id: "registry.oci" as const,
    version: "1.0.0",
    providedBy: "container_registry:harbor",
    endpoint: "harbor.noi-bo:443/acme",
  },
  "metrics.query": {
    id: "metrics.query" as const,
    version: "2.0.0",
    providedBy: "monitoring:prometheus-grafana",
    endpoint: "http://udp-prometheus.udp-system:9090",
  },
  "logs.sink": {
    id: "logs.sink" as const,
    version: "1.0.0",
    providedBy: "logging:loki",
    endpoint: "http://udp-loki.udp-system:3100",
  },
  "secrets.store": {
    id: "secrets.store" as const,
    version: "1.0.0",
    providedBy: "secrets:vault",
    endpoint: "http://udp-vault.udp-system:8200",
  },
  "traces.sink": {
    id: "traces.sink" as const,
    version: "2.0.0",
    providedBy: "tracing:jaeger",
    endpoint: "http://udp-jaeger.udp-system:4318",
  },
};

/**
 * Bề mặt values của một chart — BA nguồn, và cần cả ba.
 *
 * `top` một mình cho **dương tính giả**: chart `cost-analyzer` 2.4.3 ghi `kubecostProductConfigs` ở values.yaml
 * dưới dạng **chú thích** (dòng 3325: `# kubecostProductConfigs:`) nhưng template thì đọc nó, nên một phép so chỉ
 * dựa vào khoá đã parse sẽ tố oan adapter kubecost. `templateRefs` là nguồn SỰ THẬT ("chart có đọc khoá này
 * không"), và nó vẫn bắt đúng ca thật: template của `spinnaker` 2.2.7 **không** tham chiếu `.Values.kayenta` ở đâu
 * cả.
 */
interface ChartSurface {
  /** Khoá cấp 1 parse được từ `values.yaml` */
  top: Set<string>;
  /** Tên (và alias) dependency đã khai — khoá như `minio.*` tới từ sub-chart */
  dependencies: Set<string>;
  /** Khoá cấp 1 mà template tham chiếu qua `.Values.<khoá>` — gồm cả khoá chỉ có trong chú thích của values.yaml */
  templateRefs: Set<string>;
  bytes: number;
}

async function chartSurface(
  name: string,
  version: string,
  repo: string,
): Promise<ChartSurface | { error: string }> {
  const base = repo.replace(/\/+$/, "");
  const index = await fetch(`${base}/index.yaml`);
  if (!index.ok) return { error: `index.yaml HTTP ${String(index.status)}` };
  const text = await index.text();
  /** `urls:` của bản này — Helm cho phép đường dẫn TƯƠNG ĐỐI, phải ghép với repo */
  const at = text.indexOf(`\n    version: ${version}\n`);
  if (at < 0) return { error: `không thấy version ${version} trong index` };
  const before = text.slice(0, at);
  const urlAt = before.lastIndexOf("\n    urls:\n");
  if (urlAt < 0) return { error: "mục không có urls" };
  const raw = (before.slice(urlAt).split("\n")[2] ?? "")
    .trim()
    .replace(/^-\s*/, "");
  const url = raw.startsWith("http") ? raw : `${base}/${raw}`;

  const tgz = await fetch(url);
  if (!tgz.ok)
    return { error: `tarball HTTP ${String(tgz.status)} tại ${url}` };
  const buf = Buffer.from(await tgz.arrayBuffer());

  const dir = mkdtempSync(join(tmpdir(), "udp-chart-"));
  try {
    const tar = gunzipSync(buf);
    const wanted = `${name}/values.yaml`;
    const chartYaml = `${name}/Chart.yaml`;
    const files = untar(tar);
    const valuesText = files.get(wanted);
    if (valuesText === undefined) {
      return {
        error: `tarball không có ${wanted} (có: ${[...files.keys()].slice(0, 3).join(", ")})`,
      };
    }
    const parsed = parse(valuesText) as Record<string, unknown> | null;
    const chart = files.get(chartYaml);
    const meta =
      chart === undefined
        ? null
        : (parse(chart) as {
            dependencies?: { name?: string; alias?: string }[];
          });
    const templateRefs = new Set<string>();
    for (const [path, body] of files) {
      if (!path.includes("/templates/")) continue;
      for (const m of body.matchAll(/\.Values\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        templateRefs.add(m[1] ?? "");
      }
    }
    return {
      top: new Set(Object.keys(parsed ?? {})),
      dependencies: new Set(
        (meta?.dependencies ?? []).flatMap((d) =>
          [d.alias, d.name].filter((x): x is string => x !== undefined),
        ),
      ),
      templateRefs,
      bytes: buf.length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Đọc một tar đã giải nén: chỉ cần tên tệp ⇒ nội dung, không ghi ra đĩa */
function untar(tar: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (name === "") break;
    const size = Number.parseInt(
      tar
        .toString("utf8", off + 124, off + 136)
        .replace(/\0.*$/, "")
        .trim(),
      8,
    );
    const type = tar.toString("utf8", off + 156, off + 157);
    const start = off + 512;
    if (type === "0" || type === "") {
      out.set(name, tar.toString("utf8", start, start + size));
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Mọi đường khoá của một object values, dạng `a.b.c` */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix === "" ? [] : [prefix];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const path = prefix === "" ? k : `${prefix}.${k}`;
    out.push(path, ...keyPaths(v, path));
  }
  return out;
}

interface Row {
  adapter: string;
  release: string;
  chart: string;
  version: string;
  /** Khoá cấp 1 mà adapter đặt nhưng chart KHÔNG khai và cũng không phải tên dependency */
  unknownTopKeys: string[];
  /** Mọi đường khoá adapter đặt — để đọc lại khi cần */
  keys: string[];
  skipped?: string;
}

async function main(): Promise<void> {
  const registry = await createRegistry({
    root: resolve(import.meta.dirname, "../src/modules"),
  });

  const surfaces = new Map<string, ChartSurface | { error: string }>();
  const rows: Row[] = [];

  for (const entry of registry.all()) {
    const adapter = entry.adapter;
    const label = `${adapter.domainType}:${adapter.toolId}`;
    let config: Record<string, unknown>;
    try {
      config = adapter.configSchema.parse({}) as Record<string, unknown>;
    } catch {
      rows.push({
        adapter: label,
        release: "",
        chart: "",
        version: "",
        unknownTopKeys: [],
        keys: [],
        skipped:
          "configSchema không parse được {} — phép đo không bịa cấu hình",
      });
      continue;
    }

    const env = domainContractEnv(
      {
        validConfig: config,
        invalidConfigs: [],
        externalHosts: [],
        quotaDimensions: [],
        ignoredLabelPrefixes: [],
        driftMutations: [],
      },
      { resolved: RESOLVED },
    );
    try {
      const result = await adapter.deploy(env.context(), config);
      if (result.status !== "SUCCESS") {
        rows.push({
          adapter: label,
          release: "",
          chart: "",
          version: "",
          unknownTopKeys: [],
          keys: [],
          skipped: `deploy không SUCCESS: ${String(result.message)}`,
        });
        continue;
      }
    } catch (e) {
      rows.push({
        adapter: label,
        release: "",
        chart: "",
        version: "",
        unknownTopKeys: [],
        keys: [],
        skipped: `deploy ném: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const client = await env.cluster.getClient("tooling");
    for (const write of env.cluster.writes) {
      if (write.ref.kind !== "ConfigMap") continue;
      const name = write.ref.name ?? "";
      if (!name.endsWith("-values")) continue;
      const cm = await client.read<{
        chart?: string;
        chartVersion?: string;
        values?: Record<string, unknown>;
      }>("get", write.ref);
      const chart = cm?.chart ?? "";
      const version = cm?.chartVersion ?? "";
      const pin = HELM_CHART_PINS[chart];
      if (pin === undefined) continue;

      if (!surfaces.has(chart)) {
        surfaces.set(chart, await chartSurface(chart, version, pin.repo));
      }
      const surface = surfaces.get(chart);
      const keys = keyPaths(cm?.values ?? {});
      const tops = [...new Set(keys.map((k) => k.split(".")[0] ?? ""))];
      rows.push({
        adapter: label,
        release: name.replace(/-values$/, ""),
        chart,
        version,
        keys,
        unknownTopKeys:
          surface === undefined || "error" in surface
            ? []
            : tops.filter(
                (t) =>
                  !surface.top.has(t) &&
                  !surface.dependencies.has(t) &&
                  !surface.templateRefs.has(t),
              ),
        ...(surface !== undefined && "error" in surface
          ? { skipped: `không đọc được chart: ${surface.error}` }
          : {}),
      });
    }
  }

  const audited = rows.filter((r) => r.skipped === undefined && r.chart !== "");
  const offenders = audited.filter((r) => r.unknownTopKeys.length > 0);
  const file = writeResult(
    "chart-values",
    "máy dev → repo Helm công khai (tải index + tarball), so khoá in-process",
    {
      charts: Object.keys(HELM_CHART_PINS).length,
      releasesAudited: audited.length,
      skipped: rows.filter((r) => r.skipped !== undefined).length,
      offenders: offenders.map((r) => ({
        adapter: r.adapter,
        release: r.release,
        chart: `${r.chart}@${r.version}`,
        unknownTopKeys: r.unknownTopKeys,
      })),
      rows,
    },
    flags.note,
  );

  console.log(
    `audit ${String(audited.length)} release của ${String(Object.keys(HELM_CHART_PINS).length)} chart; bỏ qua ${String(rows.filter((r) => r.skipped !== undefined).length)}`,
  );
  for (const r of offenders) {
    console.log(
      `  LỆCH  ${r.adapter.padEnd(28)} ${r.chart}@${r.version}  khoá chart không có: ${r.unknownTopKeys.join(", ")}`,
    );
  }
  console.log(file);
  if (offenders.length > 0) process.exitCode = 1;
}

await main();
