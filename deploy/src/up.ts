import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateSecrets,
  IMAGES,
  imageRef,
  KIND_CLUSTER,
  NAMESPACE,
  SECRET_NAME,
} from "./cluster.js";
import { has, query, run } from "./shell.js";
import { k8sNamespaceFor } from "@udp/config/constants";
import { SEED_IDS, SEED_PROJECT_NAME } from "@udp/db/seed-constants";

/**
 * Dựng UDP trên một cụm `kind` ở máy này — chi phí 0 (Plan #49): không registry, không cloud.
 *
 *   pnpm deploy:up
 *
 * Chạy lại được: cụm và Secret đã có thì giữ nguyên (dữ liệu PostgreSQL sống trên PVC, đổi mật khẩu
 * owner sau lần khởi tạo đầu là khoá mình ra ngoài); image build lại và nạp lại; job migrate chạy lại.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = join(ROOT, "deploy/k8s/overlays/kind");
const KIND_CONFIG = join(ROOT, "deploy/kind/cluster.yaml");
const SERVICES = ["core-backend", "flag-service", "pd-controller"];
/** Namespace env dev của project seed — sample-app chạy ở đó để nhãn `namespace` khớp dữ liệu (§7.4) */
const SAMPLE_NAMESPACE = k8sNamespaceFor(
  SEED_PROJECT_NAME,
  SEED_IDS.project,
  "dev",
);

function requireTools(): void {
  const missing = ["docker", "kind", "kubectl"].filter((tool) => !has(tool));
  if (missing.length > 0) {
    throw new Error(
      `Thiếu hoặc chưa chạy: ${missing.join(", ")} — cần Docker đang chạy, kind và kubectl trên PATH`,
    );
  }
}

function ensureCluster(): void {
  const clusters = (query("kind", ["get", "clusters"]) ?? "").split(/\s+/);
  if (clusters.includes(KIND_CLUSTER)) return;
  run("kind", [
    "create",
    "cluster",
    "--name",
    KIND_CLUSTER,
    "--config",
    KIND_CONFIG,
  ]);
}

function buildAndLoadImages(): void {
  for (const image of IMAGES) {
    const buildArgs = Object.entries(image.args).flatMap(([k, v]) => [
      "--build-arg",
      `${k}=${v}`,
    ]);
    run("docker", [
      "build",
      "-f",
      join(ROOT, image.dockerfile),
      ...buildArgs,
      "-t",
      imageRef(image),
      ROOT,
    ]);
    run("kind", [
      "load",
      "docker-image",
      imageRef(image),
      "--name",
      KIND_CLUSTER,
    ]);
  }
}

/**
 * Secret tạo MỘT lần, qua tệp tạm quyền 0600 — không bao giờ trên dòng lệnh (lộ trong danh sách tiến
 * trình) và không bao giờ trong repo.
 */
function ensureSecret(): void {
  const namespaceYaml = query("kubectl", [
    "create",
    "namespace",
    NAMESPACE,
    "--dry-run=client",
    "-o",
    "yaml",
  ]);
  if (namespaceYaml === null)
    throw new Error("kubectl không dựng được manifest namespace");
  const dir = mkdtempSync(join(tmpdir(), "udp-ns-"));
  try {
    const nsFile = join(dir, "namespace.yaml");
    writeFileSync(nsFile, namespaceYaml);
    run("kubectl", ["apply", "-f", nsFile]);
    if (
      query("kubectl", ["get", "secret", SECRET_NAME, "-n", NAMESPACE]) !== null
    )
      return;
    const envFile = join(dir, "secrets.env");
    const body = Object.entries(generateSecrets())
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    writeFileSync(envFile, `${body}\n`, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    run("kubectl", [
      "create",
      "secret",
      "generic",
      SECRET_NAME,
      "-n",
      NAMESPACE,
      `--from-env-file=${envFile}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function deploy(): void {
  // Job bất biến: xoá lượt cũ để lượt này chạy migrate trên image vừa nạp
  run("kubectl", [
    "delete",
    "job",
    "udp-migrate",
    "-n",
    NAMESPACE,
    "--ignore-not-found",
  ]);
  run("kubectl", ["apply", "-k", OVERLAY]);
  run("kubectl", [
    "rollout",
    "status",
    "statefulset/postgres",
    "-n",
    NAMESPACE,
    "--timeout=300s",
  ]);
  run("kubectl", [
    "wait",
    "--for=condition=complete",
    "job/udp-migrate",
    "-n",
    NAMESPACE,
    "--timeout=600s",
  ]);
  // Service khởi động trước khi role có mật khẩu thì crash-loop với backoff dài — khởi động lại ngay
  run("kubectl", [
    "rollout",
    "restart",
    "-n",
    NAMESPACE,
    ...SERVICES.map((s) => `deployment/${s}`),
  ]);
  for (const name of [...SERVICES, "portal", "prometheus"]) {
    run("kubectl", [
      "rollout",
      "status",
      `deployment/${name}`,
      "-n",
      NAMESPACE,
      "--timeout=300s",
    ]);
  }
  run("kubectl", [
    "rollout",
    "restart",
    "deployment/sample-app",
    "-n",
    SAMPLE_NAMESPACE,
  ]);
  run("kubectl", [
    "rollout",
    "status",
    "deployment/sample-app",
    "-n",
    SAMPLE_NAMESPACE,
    "--timeout=300s",
  ]);
}

requireTools();
ensureCluster();
buildAndLoadImages();
ensureSecret();
deploy();
console.info(`
UDP đã chạy trên kind "${KIND_CLUSTER}":
  Portal     http://localhost:8080   (tài khoản seed: dev@udp.local / udp12345678)
  Service 2  http://localhost:3002   (SDK, OFREP)
  Prometheus kubectl -n ${NAMESPACE} port-forward svc/prometheus 9090:9090
Huỷ cụm: pnpm deploy:down`);
