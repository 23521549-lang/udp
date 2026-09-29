import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageSpec } from "./cluster.js";
import { query, run } from "./shell.js";

/**
 * Các bước cài UDP vào một cụm, DÙNG CHUNG cho kind (Plan #49) và máy ảo (Plan #52): hai nơi chạy khác nhau ở
 * kubectl nói với cụm nào và overlay nào, không ở các bước.
 */

/** kubectl đã GHIM đích — context hiện tại của máy có thể là một cụm cloud thật (Plan #50) */
export interface Kube {
  run(args: readonly string[]): void;
  /** Hỏi trạng thái; `null` khi lệnh thất bại */
  ask(args: readonly string[]): string | null;
}

export function pinnedKubectl(pin: readonly string[]): Kube {
  return {
    run: (args) => {
      run("kubectl", [...pin, ...args]);
    },
    ask: (args) => query("kubectl", [...pin, ...args]),
  };
}

/** Thư mục tạm quyền 0700 cho tệp chứa bí mật — không bao giờ qua dòng lệnh (lộ trong danh sách tiến trình) */
function withPrivateDir<T>(prefix: string, use: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePrivate(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function ensureNamespace(kube: Kube, namespace: string): void {
  const yaml = kube.ask([
    "create",
    "namespace",
    namespace,
    "--dry-run=client",
    "-o",
    "yaml",
  ]);
  if (yaml === null)
    throw new Error("kubectl không dựng được manifest namespace");
  withPrivateDir("udp-ns-", (dir) => {
    const file = join(dir, "namespace.yaml");
    writeFileSync(file, yaml);
    kube.run(["apply", "-f", file]);
  });
}

/**
 * Khoá mà sinh lại trên một Secret ĐÃ CÓ là phá dữ liệu: mật khẩu và chuỗi kết nối gắn với dữ liệu PostgreSQL trên
 * PVC (owner đổi mật khẩu là tự khoá mình ra ngoài), KEK gắn với mọi credential đã mã hoá (§4.3). Thiếu một khoá
 * trong số này trên Secret đang chạy là sự cố phải người xử lý, không phải chỗ để sinh bừa.
 */
export const CREATE_ONLY_KEYS: ReadonlySet<string> = new Set([
  "POSTGRES_PASSWORD",
  "UDP_S1_DB_PASSWORD",
  "UDP_S2_DB_PASSWORD",
  "UDP_S3_DB_PASSWORD",
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "DATABASE_URL_S1",
  "DATABASE_URL_S2",
  "DATABASE_URL_S2_DIRECT",
  "DATABASE_URL_S3",
  "DATABASE_URL_S3_DIRECT",
  "UDP_KEK_V1",
]);

/**
 * Khoá cần BỔ SUNG vào một Secret đã có (Plan #52 QĐ-8): đúng những khoá bộ sinh có mà Secret chưa có — một bản
 * phát hành thêm biến mới thì cụm đang chạy nhận nó; khoá đã có không bao giờ bị ghi đè.
 */
export function secretAdditions(
  existing: ReadonlySet<string>,
  generated: Readonly<Record<string, string>>,
): Record<string, string> {
  const missing = Object.keys(generated).filter((key) => !existing.has(key));
  const unsafe = missing.filter((key) => CREATE_ONLY_KEYS.has(key));
  if (unsafe.length > 0) {
    throw new Error(
      `Secret đang chạy thiếu ${unsafe.join(", ")} — sinh lại sẽ khoá database hay làm credential đã mã hoá không giải được; khôi phục các khoá đó bằng tay`,
    );
  }
  return Object.fromEntries(missing.map((key) => [key, generated[key] ?? ""]));
}

/** Tên các khoá của một Secret (không đọc giá trị); `null` khi Secret chưa có */
export function secretKeys(
  kube: Kube,
  namespace: string,
  name: string,
): Set<string> | null {
  const out = kube.ask([
    "get",
    "secret",
    name,
    "-n",
    namespace,
    "-o",
    'go-template={{range $k, $v := .data}}{{$k}}{{"\\n"}}{{end}}',
  ]);
  if (out === null) return null;
  return new Set(out.split("\n").filter((line) => line !== ""));
}

/**
 * Secret sinh MỘT lần; các lần sau chỉ bổ sung khoá thiếu (`secretAdditions`). Giá trị đi qua tệp tạm 0600.
 */
export function ensureSecret(
  kube: Kube,
  namespace: string,
  name: string,
  generate: () => Record<string, string>,
): void {
  const existing = secretKeys(kube, namespace, name);
  withPrivateDir("udp-secret-", (dir) => {
    if (existing === null) {
      const file = join(dir, "secrets.env");
      const body = Object.entries(generate())
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      writePrivate(file, `${body}\n`);
      kube.run([
        "create",
        "secret",
        "generic",
        name,
        "-n",
        namespace,
        `--from-env-file=${file}`,
      ]);
      return;
    }
    const additions = secretAdditions(existing, generate());
    if (Object.keys(additions).length === 0) return;
    const file = join(dir, "patch.json");
    writePrivate(file, JSON.stringify({ stringData: additions }));
    kube.run([
      "patch",
      "secret",
      name,
      "-n",
      namespace,
      "--type",
      "merge",
      "--patch-file",
      file,
    ]);
  });
}

/**
 * Secret mà người vận hành đổi được (URL sao lưu): áp lại TOÀN BỘ mỗi lần. Server-side apply — không để lại
 * annotation `last-applied-configuration` chứa giá trị.
 */
export function applySecret(
  kube: Kube,
  namespace: string,
  name: string,
  values: Readonly<Record<string, string>>,
): void {
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name, namespace },
    type: "Opaque",
    data: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [
        k,
        Buffer.from(v, "utf8").toString("base64"),
      ]),
    ),
  };
  withPrivateDir("udp-secret-", (dir) => {
    const file = join(dir, "secret.json");
    writePrivate(file, JSON.stringify(manifest));
    kube.run([
      "apply",
      "--server-side",
      "--force-conflicts",
      "--field-manager=udp-deploy",
      "-f",
      file,
    ]);
  });
}

/** Build một image của UDP từ gốc repo — cùng lệnh cho kind (tag `local`) và máy ảo (tag theo commit) */
export function buildImage(root: string, image: ImageSpec, ref: string): void {
  const buildArgs = Object.entries(image.args).flatMap(([k, v]) => [
    "--build-arg",
    `${k}=${v}`,
  ]);
  run("docker", [
    "build",
    "-f",
    join(root, image.dockerfile),
    ...buildArgs,
    "-t",
    ref,
    root,
  ]);
}

/** Deployment ngoài namespace chính mà lần cài phải khởi động lại và chờ (sample-app của kind) */
export interface ExtraDeployment {
  namespace: string;
  name: string;
}

export interface InstallPlan {
  namespace: string;
  /** Thư mục kustomization để `kubectl apply -k` */
  kustomization: string;
  /** Deployment chạy mã UDP — khởi động lại sau migrate */
  services: readonly string[];
  /** Deployment khác của namespace chính phải sẵn sàng */
  alsoReady: readonly string[];
  extra: readonly ExtraDeployment[];
}

export function install(kube: Kube, plan: InstallPlan): void {
  const { namespace } = plan;
  // Job bất biến: xoá lượt cũ để lượt này chạy migrate trên image vừa nạp
  kube.run([
    "delete",
    "job",
    "udp-migrate",
    "-n",
    namespace,
    "--ignore-not-found",
  ]);
  kube.run(["apply", "-k", plan.kustomization]);
  kube.run([
    "rollout",
    "status",
    "statefulset/postgres",
    "-n",
    namespace,
    "--timeout=300s",
  ]);
  kube.run([
    "wait",
    "--for=condition=complete",
    "job/udp-migrate",
    "-n",
    namespace,
    "--timeout=600s",
  ]);
  // Service khởi động trước khi role có mật khẩu (hay trước migration mới) thì crash-loop với backoff dài
  kube.run([
    "rollout",
    "restart",
    "-n",
    namespace,
    ...plan.services.map((s) => `deployment/${s}`),
  ]);
  for (const name of [...plan.services, ...plan.alsoReady]) {
    kube.run([
      "rollout",
      "status",
      `deployment/${name}`,
      "-n",
      namespace,
      "--timeout=300s",
    ]);
  }
  for (const d of plan.extra) {
    kube.run(["rollout", "restart", `deployment/${d.name}`, "-n", d.namespace]);
    kube.run([
      "rollout",
      "status",
      `deployment/${d.name}`,
      "-n",
      d.namespace,
      "--timeout=300s",
    ]);
  }
}
