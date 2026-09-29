import { spawnSync } from "node:child_process";
import { KUBE_CONTEXT, NAMESPACE, SAMPLE_NAMESPACE } from "./cluster.js";
import { VM_KUBECTL_PIN } from "./vm.js";

/**
 * In trạng thái cụm của UDP khi dựng hay E2E đỏ (Plan #50) — bước `if: failure()` của job `kind` và `vm`, và cũng
 * là lệnh đầu tiên nên chạy khi `pnpm deploy:up` (kind) hay `vm-up` (máy ảo, Plan #52) dừng giữa chừng:
 *
 *   pnpm --filter @udp/deploy diagnose                # cụm kind
 *   pnpm --filter @udp/deploy diagnose --target vm    # máy ảo
 *
 * Không bao giờ ném: một lệnh hỏng (cụm chưa có, pod chưa tạo) không được che các lệnh sau. Không in giá trị
 * Secret nào — `describe` chỉ hiện TÊN khoá được tham chiếu.
 */

const at = process.argv.indexOf("--target");
const target = at >= 0 ? process.argv[at + 1] : "kind";
if (target !== "kind" && target !== "vm") {
  throw new Error(`--target là kind hoặc vm, nhận "${String(target)}"`);
}
const pin = target === "vm" ? VM_KUBECTL_PIN : ["--context", KUBE_CONTEXT];

function show(title: string, args: readonly string[]): void {
  console.log(`\n===== ${title} =====`);
  spawnSync("kubectl", [...pin, ...args], { stdio: "inherit" });
}

show("pod", ["get", "pods", "-A", "-o", "wide"]);
show("sự kiện gần nhất", ["get", "events", "-A", "--sort-by=.lastTimestamp"]);
show("pod của UDP", ["describe", "pods", "-n", NAMESPACE]);
show("job udp-migrate", [
  "logs",
  "job/udp-migrate",
  "-n",
  NAMESPACE,
  "--tail=200",
]);
for (const name of [
  "core-backend",
  "flag-service",
  "pd-controller",
  "portal",
  "prometheus",
]) {
  show(name, [
    "logs",
    `deployment/${name}`,
    "-n",
    NAMESPACE,
    "--tail=150",
    "--all-containers",
  ]);
}

if (target === "kind") {
  show("sample-app", [
    "logs",
    "deployment/sample-app",
    "-n",
    SAMPLE_NAMESPACE,
    "--tail=150",
  ]);
} else {
  // Đường vào công khai (QĐ-5): chứng chỉ không cấp được là lỗi hay gặp nhất của một máy mới
  show("ingress, chứng chỉ, thử thách ACME", [
    "get",
    "ingress,certificate,certificaterequest,order,challenge,clusterissuer",
    "-A",
  ]);
  show("chứng chỉ của UDP", ["describe", "certificate", "-n", NAMESPACE]);
  show("traefik", [
    "logs",
    "deployment/traefik",
    "-n",
    "kube-system",
    "--tail=150",
  ]);
  show("cert-manager", [
    "logs",
    "deployment/cert-manager",
    "-n",
    "cert-manager",
    "--tail=150",
  ]);
  show("sao lưu và job", ["get", "cronjob,job", "-n", NAMESPACE]);
}
