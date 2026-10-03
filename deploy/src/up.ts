import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateSecrets,
  HOST_PORTS,
  IMAGES,
  imageRef,
  KIND_CLUSTER,
  KUBE_CONTEXT,
  NAMESPACE,
  SAMPLE_NAMESPACE,
  SECRET_NAME,
} from "./cluster.js";
import {
  buildImage,
  ensureNamespace,
  ensureSecret,
  install,
  pinnedKubectl,
} from "./install.js";
import { has, query, run } from "./shell.js";
import { SEED_DEV_PASSWORD, SEED_OWNER_EMAIL } from "@udp/db/seed-constants";

/**
 * Dựng UDP trên một cụm `kind` ở máy này — chi phí 0 (Plan #49): không registry, không cloud.
 *
 *   pnpm deploy:up
 *
 * Chạy lại được: cụm đã có thì giữ nguyên; Secret đã có thì giữ mọi khoá cũ, chỉ bổ sung khoá mới (dữ liệu
 * PostgreSQL sống trên PVC, đổi mật khẩu owner sau lần khởi tạo đầu là khoá mình ra ngoài — `install.ts`);
 * image build lại và nạp lại; job migrate chạy lại.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = join(ROOT, "deploy/k8s/overlays/kind");
const KIND_CONFIG = join(ROOT, "deploy/kind/cluster.yaml");
const SERVICES = ["core-backend", "flag-service", "pd-controller"];

/** kubectl luôn nói với ĐÚNG cụm kind của UDP, bất kể context hiện tại của máy */
const kube = pinnedKubectl(["--context", KUBE_CONTEXT]);

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
    buildImage(ROOT, image, imageRef(image));
    run("kind", [
      "load",
      "docker-image",
      imageRef(image),
      "--name",
      KIND_CLUSTER,
    ]);
  }
}

requireTools();
ensureCluster();
buildAndLoadImages();
ensureNamespace(kube, NAMESPACE);
ensureSecret(kube, NAMESPACE, SECRET_NAME, generateSecrets);
install(kube, {
  namespace: NAMESPACE,
  kustomization: OVERLAY,
  services: SERVICES,
  alsoReady: ["portal", "prometheus"],
  extra: [{ namespace: SAMPLE_NAMESPACE, name: "sample-app" }],
});
console.info(`
UDP đã chạy trên kind "${KIND_CLUSTER}":
  Portal     http://localhost:${String(HOST_PORTS.portal)}   (tài khoản seed: ${SEED_OWNER_EMAIL} / ${SEED_DEV_PASSWORD})
  Service 2  http://localhost:${String(HOST_PORTS.flagService)}   (SDK, OFREP)
  Prometheus kubectl --context ${KUBE_CONTEXT} -n ${NAMESPACE} port-forward svc/prometheus 9090:9090
Huỷ cụm: pnpm deploy:down`);
