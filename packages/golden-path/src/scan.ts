import {
  BUILDPACKS_LANGUAGES,
  type BuildLanguage,
} from "@udp/shared-types/build";
import {
  goldenPathFiles,
  isGoldenPathRuntime,
  PROVIDER_PUBLIC_NAME,
  type GoldenPathFile,
} from "./render.js";

/**
 * Quét một repo có sẵn (§11.2 Import Existing Repo) — Plan #48 QĐ-5.
 *
 * Hàm THUẦN trên một `RepoSource` (liệt kê + đọc): nguồn mạng (GitHub, GitLab) ở Service 1, test dùng
 * nguồn trong bộ nhớ. Tám bước của §11.2 thành các phát hiện `ok | missing | unknown`, mỗi phát hiện
 * thiếu kèm đề xuất — CHỈ phát hiện và đề xuất, không bao giờ sửa mã của developer.
 *
 * `unknown` là trung thực, không phải lỗi: repo lớn hơn trần đọc, hay manifest nằm ở repo khác (GitOps),
 * thì "không thấy" không có nghĩa là "không có".
 */

export interface RepoSource {
  /** Mọi đường dẫn tệp (posix, không "/" đầu) — đã cắt theo trần của nguồn */
  list(): Promise<readonly string[]>;
  /** Nội dung UTF-8, hoặc `undefined` khi không đọc được hay quá lớn */
  read(path: string): Promise<string | undefined>;
  /** Nguồn đã phải cắt danh sách (repo lớn hơn trần) */
  readonly truncated: boolean;
}

export type FindingStatus = "ok" | "missing" | "unknown";

export type FindingId =
  | "runtime"
  | "dockerfile"
  | "metrics-endpoint"
  | "openfeature"
  | "udp-provider"
  | "udp-middleware"
  | "service-version"
  | "pipeline";

export interface ScanSuggestion {
  text: string;
  /** Tệp mẫu (Golden Path) — developer chép nếu muốn, UDP không ghi vào repo */
  file?: GoldenPathFile;
}

export interface ScanFinding {
  id: FindingId;
  status: FindingStatus;
  /** Điều đã thấy hay còn thiếu — một câu */
  detail: string;
  /** Tệp làm bằng chứng */
  evidence: string[];
  suggestion?: ScanSuggestion;
}

export interface RepoScan {
  /** `nodejs` | `python` | `java` | `go` | `dotnet` | `ruby` | `php` | `rust` | `static` | `null` */
  runtime: string | null;
  /**
   * [Plan #61 QĐ-10] Ngôn ngữ cho đóng gói và bước test — như `runtime` nhưng tách Maven với Gradle. `null` khi không
   * nhận diện được.
   */
  language: BuildLanguage | null;
  framework: string | null;
  /** Id tool CI/CD như adapter của UDP: `github-actions`, `gitlab-ci`, … */
  cicdTool: string | null;
  findings: ScanFinding[];
  /** Có provider UDP VÀ middleware đo — hai điều kiện C1 phát hiện được từ mã (§6.6) */
  flagLevelReady: boolean;
  truncated: boolean;
}

/** Trần đọc: tệp manifest, CI, Kubernetes và mã nguồn cộng lại */
export const SCAN_LIMITS = {
  maxReads: 60,
  maxManifests: 20,
  maxSources: 30,
} as const;

const SKIP_DIR =
  /(^|\/)(node_modules|dist|build|out|vendor|\.venv|venv|__pycache__|\.git|coverage|target)\//;

const CICD_FILES: [RegExp, string][] = [
  [/^\.github\/workflows\/[^/]+\.ya?ml$/, "github-actions"],
  [/^\.gitlab-ci\.ya?ml$/, "gitlab-ci"],
  [/^\.circleci\/config\.ya?ml$/, "circleci"],
  [/(^|\/)Jenkinsfile$/, "jenkins"],
  [/^\.drone\.ya?ml$/, "drone"],
  [/^\.?tekton\/.+\.ya?ml$/, "tekton"],
];

const NODE_FRAMEWORKS: [string, string][] = [
  ["@nestjs/core", "nestjs"],
  ["fastify", "fastify"],
  ["koa", "koa"],
  ["hono", "hono"],
  ["express", "express"],
];
const PYTHON_FRAMEWORKS: [RegExp, string][] = [
  [/(^|[\s"'[,])fastapi\b/im, "fastapi"],
  [/(^|[\s"'[,])flask\b/im, "flask"],
  [/(^|[\s"'[,])django\b/im, "django"],
  [/(^|[\s"'[,])starlette\b/im, "starlette"],
];

const PYTHON_MANIFEST =
  /^(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg)$/;
const JAVA_MANIFEST = /^(pom\.xml|build\.gradle(\.kts)?)$/;

/**
 * [Plan #61 QĐ-10] Ngôn ngữ khác — xét SAU Node.js, Python, Java (thứ tự cũ giữ nguyên: repo hỗn hợp không đổi kết
 * quả). Chỉ tệp ở thư mục nông (`maxDepth` phần đường dẫn): đó là thứ Buildpacks đọc. .NET thường để project ở
 * `src/<Tên>/<Tên>.csproj`.
 */
const OTHER_LANGUAGES: [RegExp, BuildLanguage, number][] = [
  [/^go\.mod$/, "go", 2],
  [/\.(csproj|fsproj|sln)$/, "dotnet", 3],
  [/^Gemfile$/, "ruby", 2],
  [/^composer\.json$/, "php", 2],
  [/^Cargo\.toml$/, "rust", 2],
];
const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)(\.[^/]+)?$/;
const K8S_MANIFEST = /\.ya?ml$/;
const SOURCE = /\.(ts|tsx|js|mjs|cjs|py)$/;
const ENTRY =
  /(^|\/)(index|main|app|server|telemetry|__init__)\.(ts|js|mjs|py)$/;

interface Evidence {
  runtime: string | null;
  language: BuildLanguage | null;
  framework: string | null;
  /** Nội dung đã đọc theo đường dẫn */
  texts: Map<string, string>;
  /** Tên phụ thuộc (Node) hoặc văn bản manifest gộp (Python/Java) */
  nodeDeps: Set<string>;
  manifestText: string;
  manifestPaths: string[];
  sourcesComplete: boolean;
}

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);
const depth = (path: string): number => path.split("/").length;
const byDepth = (a: string, b: string): number =>
  depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0);

function nodeDependencies(text: string | undefined): Set<string> {
  if (text === undefined) return new Set();
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const names = ["dependencies", "devDependencies"].flatMap((k) => {
      const deps = json[k];
      return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
    });
    return new Set(names);
  } catch {
    return new Set();
  }
}

async function readAll(
  source: RepoSource,
  paths: readonly string[],
  texts: Map<string, string>,
): Promise<void> {
  for (const path of paths) {
    if (texts.size >= SCAN_LIMITS.maxReads) return;
    if (texts.has(path)) continue;
    const text = await source.read(path);
    if (text !== undefined) texts.set(path, text);
  }
}

async function gatherEvidence(
  source: RepoSource,
  paths: readonly string[],
): Promise<Evidence> {
  const texts = new Map<string, string>();
  const visible = paths.filter((p) => !SKIP_DIR.test(p)).sort(byDepth);

  const nodeManifest = visible.find((p) => baseName(p) === "package.json");
  const pythonManifests = visible.filter((p) =>
    PYTHON_MANIFEST.test(baseName(p)),
  );
  const javaManifests = visible.filter((p) => JAVA_MANIFEST.test(baseName(p)));
  const manifestPaths = [
    ...(nodeManifest === undefined ? [] : [nodeManifest]),
    ...pythonManifests,
    ...javaManifests,
  ].slice(0, SCAN_LIMITS.maxManifests);
  await readAll(source, manifestPaths, texts);

  const nodeDeps = nodeDependencies(
    nodeManifest === undefined ? undefined : texts.get(nodeManifest),
  );
  const manifestText = [...pythonManifests, ...javaManifests]
    .map((p) => texts.get(p) ?? "")
    .join("\n");

  let runtime: string | null = null;
  let language: BuildLanguage | null = null;
  let framework: string | null = null;
  if (nodeManifest !== undefined) {
    runtime = "nodejs";
    language = "nodejs";
    framework = NODE_FRAMEWORKS.find(([dep]) => nodeDeps.has(dep))?.[1] ?? null;
  } else if (pythonManifests.length > 0) {
    runtime = "python";
    language = "python";
    framework =
      PYTHON_FRAMEWORKS.find(([re]) => re.test(manifestText))?.[1] ?? null;
  } else if (javaManifests.length > 0) {
    runtime = "java";
    // Maven và Gradle có lệnh test khác nhau; repo có cả hai thì theo tệp nông nhất
    language = javaManifests[0]?.endsWith("pom.xml")
      ? "java-maven"
      : "java-gradle";
    framework = /spring-boot/.test(manifestText) ? "spring-boot" : null;
  } else {
    const other = OTHER_LANGUAGES.find(([re, , maxDepth]) =>
      visible.some((p) => re.test(baseName(p)) && depth(p) <= maxDepth),
    );
    if (other !== undefined) {
      language = other[1];
      runtime = other[1];
    } else if (visible.includes("index.html")) {
      // Trang tĩnh: chỉ HTML ở gốc, không tệp của ngôn ngữ nào
      language = "static";
      runtime = "static";
    }
  }

  const sources = visible.filter(
    (p) => SOURCE.test(p) && !/(^|\/)tests?\//.test(p),
  );
  const ordered = [
    ...sources.filter((p) => ENTRY.test(p)),
    ...sources.filter((p) => !ENTRY.test(p)),
  ].slice(0, SCAN_LIMITS.maxSources);
  const k8s = visible.filter(
    (p) => K8S_MANIFEST.test(p) && !CICD_FILES.some(([re]) => re.test(p)),
  );
  const cicd = visible.filter((p) => CICD_FILES.some(([re]) => re.test(p)));
  await readAll(
    source,
    [...cicd, ...k8s.slice(0, SCAN_LIMITS.maxManifests), ...ordered],
    texts,
  );

  return {
    runtime,
    language,
    framework,
    texts,
    nodeDeps,
    manifestText,
    manifestPaths,
    sourcesComplete:
      !source.truncated &&
      sources.length <= SCAN_LIMITS.maxSources &&
      ordered.every((p) => texts.has(p)),
  };
}

/** Phụ thuộc theo runtime: tên gói Node, hoặc mẫu trong manifest Python/Java */
function hasDependency(
  ev: Evidence,
  node: readonly string[],
  other: RegExp,
): boolean {
  return ev.runtime === "nodejs"
    ? node.some((d) => ev.nodeDeps.has(d))
    : other.test(ev.manifestText);
}

/** Tệp mã nguồn đã đọc có chứa một trong các định danh */
function sourcesMentioning(ev: Evidence, names: RegExp): string[] {
  return [...ev.texts]
    .filter(([path, text]) => SOURCE.test(path) && names.test(text))
    .map(([path]) => path);
}

/** Project mà đề xuất sinh cho — tệp mẫu mang đúng tên workload và registry của nó */
export interface ScanContext {
  slug: string;
  registryRef: string | null;
}

const ANY_PROJECT: ScanContext = { slug: "your-service", registryRef: null };

function templateFile(
  runtime: string | null,
  path: string,
  context: ScanContext,
): GoldenPathFile | undefined {
  if (runtime === null || !isGoldenPathRuntime(runtime)) return undefined;
  return goldenPathFiles({ runtime, ...context }).find((f) => f.path === path);
}

const SNIPPET_PATH: Record<string, string> = {
  nodejs: "src/app.ts",
  python: "app/main.py",
};

function finding(
  id: FindingId,
  ok: boolean,
  okDetail: string,
  missingDetail: string,
  evidence: string[],
  suggestion: ScanSuggestion,
  unknown = false,
): ScanFinding {
  if (ok) return { id, status: "ok", detail: okDetail, evidence };
  return {
    id,
    status: unknown ? "unknown" : "missing",
    detail: missingDetail,
    evidence,
    suggestion,
  };
}

/** Quét repo theo tám bước của §11.2 */
export async function scanRepository(
  source: RepoSource,
  context: ScanContext = ANY_PROJECT,
): Promise<RepoScan> {
  const paths = await source.list();
  const ev = await gatherEvidence(source, paths);
  const runtime = ev.runtime;
  const snippet = runtime === null ? undefined : SNIPPET_PATH[runtime];
  const snippetFile =
    snippet === undefined ? undefined : templateFile(runtime, snippet, context);

  const dockerfiles = paths.filter(
    (p) => !SKIP_DIR.test(p) && DOCKERFILE.test(p),
  );
  const cicdPaths = paths.filter((p) => CICD_FILES.some(([re]) => re.test(p)));
  const cicdTool =
    CICD_FILES.find(([re]) => cicdPaths.some((p) => re.test(p)))?.[1] ?? null;
  const workloads = [...ev.texts].filter(
    ([path, text]) =>
      K8S_MANIFEST.test(path) &&
      /kind:\s*(Deployment|Rollout|StatefulSet)\b/.test(text),
  );

  const providerPaths = sourcesMentioning(ev, /\bUDPFeatureFlagProvider\b/);
  const middlewarePaths = sourcesMentioning(
    ev,
    /\b(udpMetricsMiddleware|UDPMetricsMiddleware|UDPMetricsWSGIMiddleware)\b/,
  );
  /**
   * [Plan #62 62d-8] HAI tên cho một gói, và cả hai đều phải nhận ra được: khách cài từ npm có
   * `PROVIDER_PUBLIC_NAME` trong `dependencies`, còn cây sinh trước đợt này (hay một repo nội bộ) còn tên trong kho.
   * Chỉ nhận một tên là một sai ÂM im lặng: báo "chưa dùng SDK" cho MỌI khách thật, và `flagLevelReady` chặn
   * họ tạo rollout mức flag.
   */
  const hasProviderDep = hasDependency(
    ev,
    [["@udp", "openfeature-provider"].join("/"), PROVIDER_PUBLIC_NAME],
    /udp-openfeature/i,
  );
  const versionPaths = workloads
    .filter(([, text]) =>
      /OTEL_RESOURCE_ATTRIBUTES[\s\S]{0,200}service\.version/.test(text),
    )
    .map(([path]) => path);
  const notifyPaths = cicdPaths.filter(
    (p) => ev.texts.get(p)?.includes("UDP_WEBHOOK_URL") === true,
  );

  const findings: ScanFinding[] = [
    runtime === null
      ? {
          id: "runtime",
          status: "missing",
          detail:
            "Không nhận diện được ngôn ngữ: không thấy package.json, requirements.txt, pyproject.toml, pom.xml, build.gradle, go.mod, *.csproj, Gemfile, composer.json, Cargo.toml hay index.html ở gốc",
          evidence: [],
          suggestion: {
            text: "Golden Path hỗ trợ Node.js và Python (§16); runtime khác cần tích hợp tay",
          },
        }
      : {
          id: "runtime",
          status: "ok",
          detail: `Runtime ${runtime}${ev.framework === null ? "" : ` (${ev.framework})`}`,
          evidence: ev.manifestPaths,
        },
    packagingFinding(ev.language, runtime, dockerfiles, context),
    finding(
      "metrics-endpoint",
      hasDependency(
        ev,
        [
          "prom-client",
          "express-prom-bundle",
          "@opentelemetry/exporter-prometheus",
        ],
        /prometheus[-_](client|fastapi-instrumentator)|starlette[-_]exporter|micrometer-registry-prometheus/i,
      ),
      "Có thư viện Prometheus client: endpoint /metrics",
      "Chưa có Prometheus client: UDP không đọc được metric của ứng dụng",
      ev.manifestPaths,
      {
        text: "Thêm Prometheus client và route /metrics như Golden Path",
        ...optionalFile(snippetFile),
      },
    ),
    finding(
      "openfeature",
      hasDependency(
        ev,
        ["@openfeature/server-sdk"],
        /openfeature[-_]sdk|dev\.openfeature/i,
      ),
      "Có OpenFeature SDK",
      "Chưa có OpenFeature SDK",
      ev.manifestPaths,
      { text: "Thêm OpenFeature SDK rồi đánh giá flag qua client của nó" },
    ),
    finding(
      "udp-provider",
      hasProviderDep && (providerPaths.length > 0 || !ev.sourcesComplete),
      "Dùng UDPFeatureFlagProvider (hook nhãn ff tự gắn)",
      hasProviderDep
        ? "Có gói provider UDP nhưng không thấy UDPFeatureFlagProvider trong mã đã đọc"
        : "Chưa dùng UDPFeatureFlagProvider: rollout mức flag không tách được nhánh",
      providerPaths,
      {
        text: "Đặt UDPFeatureFlagProvider làm provider của OpenFeature (hook nhãn ff tự gắn)",
        ...optionalFile(
          templateFile(
            runtime,
            runtime === "python" ? "app/telemetry.py" : "src/telemetry.ts",
            context,
          ),
        ),
      },
    ),
    finding(
      "udp-middleware",
      middlewarePaths.length > 0,
      "Có middleware đo của UDP (nhãn ff)",
      "Chưa có middleware đo của UDP: metric không có nhãn ff, rollout mức flag bị chặn (§8.5)",
      middlewarePaths,
      {
        text: "Đăng ký middleware đo của UDP TRƯỚC mọi route nghiệp vụ",
        ...optionalFile(snippetFile),
      },
      !ev.sourcesComplete,
    ),
    finding(
      "service-version",
      versionPaths.length > 0,
      "Manifest đặt service.version qua OTEL_RESOURCE_ATTRIBUTES",
      workloads.length === 0
        ? "Không thấy manifest Kubernetes trong repo (có thể nằm ở repo GitOps)"
        : "Manifest không đặt service.version: canary SERVICE_LEVEL không phân biệt được version",
      versionPaths.length > 0 ? versionPaths : workloads.map(([p]) => p),
      {
        text: "Đặt OTEL_SERVICE_NAME và OTEL_RESOURCE_ATTRIBUTES=service.version=… như manifest Golden Path",
        ...optionalFile(
          templateFile(runtime ?? "nodejs", "k8s/deployment.yaml", context),
        ),
      },
      workloads.length === 0,
    ),
    finding(
      "pipeline",
      notifyPaths.length > 0,
      "Pipeline đã báo deploy về UDP",
      cicdTool === null
        ? "Không nhận diện được công cụ CI/CD"
        : `Pipeline ${cicdTool} chưa báo deploy về UDP: DORA và luồng áp image không có dữ liệu`,
      notifyPaths.length > 0 ? notifyPaths : cicdPaths,
      {
        text: "Dùng pipeline mà UDP sinh cho công cụ CI/CD của project (bước cuối ký và báo deploy)",
      },
    ),
  ];

  return {
    runtime,
    language: ev.language,
    framework: ev.framework,
    cicdTool,
    findings,
    flagLevelReady:
      findings.find((f) => f.id === "udp-provider")?.status === "ok" &&
      findings.find((f) => f.id === "udp-middleware")?.status === "ok",
    truncated: source.truncated,
  };
}

/**
 * [Plan #61 QĐ-4, QĐ-10] Đóng gói được không — id `dockerfile` giữ nguyên (lần quét đã lưu vẫn đọc được). Có Dockerfile
 * ⇒ build bằng nó. Không có mà Buildpacks biết ngôn ngữ ⇒ UDP build bằng Buildpacks, Dockerfile Golden Path chỉ là
 * lựa chọn (muốn tự quyết image nền). Còn lại (Rust, không rõ) ⇒ thiếu: cần Dockerfile.
 */
function packagingFinding(
  language: BuildLanguage | null,
  runtime: string | null,
  dockerfiles: string[],
  context: ScanContext,
): ScanFinding {
  const template = templateFile(runtime, "Dockerfile", context);
  if (dockerfiles.length > 0) {
    return {
      id: "dockerfile",
      status: "ok",
      detail: "Có Dockerfile: UDP build image bằng Dockerfile (BuildKit)",
      evidence: dockerfiles,
    };
  }
  if (language !== null && BUILDPACKS_LANGUAGES.includes(language)) {
    return {
      id: "dockerfile",
      status: "ok",
      detail: `Không có Dockerfile: UDP build image bằng Buildpacks (${language})`,
      evidence: [],
      ...(template === undefined
        ? {}
        : {
            suggestion: {
              text: "Muốn tự quyết image nền: thêm Dockerfile nhiều tầng của Golden Path",
              file: template,
            },
          }),
    };
  }
  return {
    id: "dockerfile",
    status: "missing",
    detail:
      language === null
        ? "Chưa có Dockerfile và không nhận diện được ngôn ngữ: Buildpacks không build được"
        : `Chưa có Dockerfile và Buildpacks không build được ${language}`,
    evidence: [],
    suggestion: {
      text: "Thêm Dockerfile ở gốc repo (hay khai đường Dockerfile trong mục Đóng gói)",
    },
  };
}

function optionalFile(file: GoldenPathFile | undefined): {
  file?: GoldenPathFile;
} {
  return file === undefined ? {} : { file };
}
