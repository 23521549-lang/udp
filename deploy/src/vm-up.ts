import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  imageRefWithTag,
  NAMESPACE,
  SECRET_NAME,
  type ImageSpec,
} from "./cluster.js";
import {
  applySecret,
  buildImage,
  ensureNamespace,
  ensureSecret,
  install,
  pinnedKubectl,
  type Kube,
} from "./install.js";
import { has, query, run } from "./shell.js";
import {
  BACKUP_SECRET,
  backupSecretValues,
  generateVmSecrets,
  publicOrigin,
  readVmSettings,
  recoveryMismatches,
  releaseKustomization,
  releaseTag,
  VM_IMAGES,
  VM_KUBECTL_PIN,
  VM_SETTINGS_PATH,
  type VmSettings,
} from "./vm.js";

/**
 * Một bản phát hành UDP trên máy ảo công khai (Plan #52) — chạy TRÊN máy ảo, từ thư mục mã nguồn của commit:
 *
 *   pnpm --filter @udp/deploy vm-up --release <sha 40 ký tự>
 *
 * (`deploy/vm/release.sh` gọi nó; workflow `Deploy` gọi release.sh qua SSH.) Build image arm64 tại chỗ, nạp vào
 * containerd của k3s với tag của commit (QĐ-3), bổ sung Secret (QĐ-8), sinh bản phát hành từ `~/udp/vm.env` (QĐ-4)
 * rồi áp, chạy migrate và chờ sẵn sàng — cùng các bước với kind (`install.ts`).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RELEASE_DIR = join(ROOT, "deploy/k8s/release");
const OVERLAY = join(ROOT, "deploy/k8s/overlays/vm");
const COMPONENTS = join(ROOT, "deploy/k8s/components");
const SERVICES = ["core-backend", "flag-service", "pd-controller"];

function releaseSha(argv: readonly string[]): string {
  const at = argv.indexOf("--release");
  const sha = at >= 0 ? argv[at + 1] : undefined;
  if (sha === undefined) {
    throw new Error(
      "thiếu --release <sha> — bản phát hành gắn với đúng một commit",
    );
  }
  return sha;
}

function requireHost(kube: Kube): void {
  const missing = ["docker", "kubectl", "sudo"].filter((tool) => !has(tool));
  if (missing.length > 0) {
    throw new Error(
      `Thiếu ${missing.join(", ")} — máy chưa qua deploy/vm/bootstrap.sh`,
    );
  }
  if (query("sudo", ["-n", "k3s", "--version"]) === null) {
    throw new Error(
      "không gọi được `sudo -n k3s` — cần k3s (bootstrap.sh) và sudo không mật khẩu để nạp image",
    );
  }
  if (kube.ask(["get", "crd", "clusterissuers.cert-manager.io"]) === null) {
    throw new Error(
      "cụm chưa có cert-manager hay kubeconfig udp-vm — chạy lại deploy/vm/bootstrap.sh",
    );
  }
}

/** `docker build` arm64 tại chỗ → containerd của k3s; bản trong kho Docker xoá đi, cache build giữ lại */
function buildAndImport(images: readonly ImageSpec[], tag: string): void {
  for (const image of images) {
    const ref = imageRefWithTag(image, tag);
    buildImage(ROOT, image, ref);
    // `ref` chỉ gồm hằng và tag hex đã kiểm (`releaseTag`) — an toàn trong chuỗi lệnh
    run("bash", [
      "-o",
      "pipefail",
      "-c",
      `docker save ${ref} | sudo -n k3s ctr -n k8s.io images import -`,
    ]);
    run("docker", ["image", "rm", ref]);
  }
}

function checkRecovery(kube: Kube, settings: VmSettings): void {
  const mismatched = recoveryMismatches(settings, (key) => {
    const b64 = kube.ask([
      "get",
      "secret",
      SECRET_NAME,
      "-n",
      NAMESPACE,
      "-o",
      `jsonpath={.data.${key}}`,
    ]);
    return b64 === null || b64 === ""
      ? null
      : Buffer.from(b64, "base64").toString("utf8");
  });
  if (mismatched.length > 0) {
    throw new Error(
      `${VM_SETTINGS_PATH} đặt ${mismatched.join(", ")} KHÁC giá trị của cụm đang chạy — Secret không bao giờ bị ghi đè; bỏ các dòng đó, hoặc dựng cụm mới để khôi phục`,
    );
  }
}

function writeRelease(sha: string, settings: VmSettings): string {
  mkdirSync(RELEASE_DIR, { recursive: true });
  const kustomization = releaseKustomization({
    sha,
    settings,
    overlay: relative(RELEASE_DIR, OVERLAY).replaceAll("\\", "/"),
    components: relative(RELEASE_DIR, COMPONENTS).replaceAll("\\", "/"),
  });
  writeFileSync(
    join(RELEASE_DIR, "kustomization.yaml"),
    `${JSON.stringify(kustomization, null, 2)}\n`,
  );
  return RELEASE_DIR;
}

const sha = releaseSha(process.argv);
const tag = releaseTag(sha);
const settings = readVmSettings();
const kube = pinnedKubectl(VM_KUBECTL_PIN);

requireHost(kube);
checkRecovery(kube, settings);
buildAndImport(VM_IMAGES, tag);
ensureNamespace(kube, NAMESPACE);
ensureSecret(kube, NAMESPACE, SECRET_NAME, () => generateVmSecrets(settings));
applySecret(kube, NAMESPACE, BACKUP_SECRET, backupSecretValues(settings));
install(kube, {
  namespace: NAMESPACE,
  kustomization: writeRelease(sha, settings),
  services: SERVICES,
  alsoReady: ["portal", "prometheus"],
  extra: [],
});
console.info(`
UDP ${tag} đã chạy: ${publicOrigin(settings)}
  Chứng chỉ:  kubectl ${VM_KUBECTL_PIN.join(" ")} -n ${NAMESPACE} get certificate
  Chẩn đoán:  pnpm --filter @udp/deploy diagnose --target vm`);
