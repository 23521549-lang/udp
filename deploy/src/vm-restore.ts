import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { NAMESPACE } from "./cluster.js";
import { pinnedKubectl } from "./install.js";
import { VM_KUBECTL_PIN } from "./vm.js";

/**
 * Khôi phục database của máy ảo từ một bản sao lưu của CronJob `udp-backup` (Plan #52 QĐ-7):
 *
 *   pnpm --filter @udp/deploy vm-restore <tệp .dump>
 *
 * Khôi phục vào một database MỚI trong một transaction, rồi mới hoán đổi tên với database đang dùng — không
 * `pg_restore --clean` trên chính nó: khôi phục hỏng thì database cũ chưa bị đụng tới, và database mới dựng từ
 * `template1` như lần migrate đầu nên không phụ thuộc cách pg_dump đối xử với schema `public`. Bản trước khi khôi
 * phục ở lại dưới tên `udp_before_restore` (lần khôi phục sau thay nó). Ba service hạ về 0 bản trong lúc đó và luôn
 * được dựng lại, kể cả khi khôi phục hỏng. Credential BYOC trong bản dump chỉ giải được nếu Secret mang ĐÚNG KEK cũ
 * (`UDP_KEK_V1` trong `vm.env` trước lần phát hành đầu trên máy mới).
 */

const SERVICES = ["core-backend", "flag-service", "pd-controller"];
const POD = "postgres-0";
const IN_POD = "/tmp/udp-restore.dump";
const LIVE = "udp";
const STAGING = "udp_restore";
const PREVIOUS = "udp_before_restore";

const file = process.argv[2];
if (file === undefined || !existsSync(file)) {
  throw new Error("cần đường dẫn tới một tệp .dump có thật");
}

const kube = pinnedKubectl(VM_KUBECTL_PIN);
/** Lệnh PostgreSQL trong pod, bằng owner qua socket cục bộ */
const inPostgres = (args: readonly string[]): void => {
  kube.run(["exec", "-n", NAMESPACE, POD, "--", ...args]);
};
const scale = (replicas: number): void => {
  kube.run([
    "scale",
    "-n",
    NAMESPACE,
    `--replicas=${String(replicas)}`,
    ...SERVICES.map((s) => `deployment/${s}`),
  ]);
};

/**
 * Chờ tới khi không còn pod nào của ba service. Không dùng `kubectl wait --for=delete`: nó báo lỗi khi pod đã
 * hết TRƯỚC lúc hỏi — đúng ca thường gặp nhất.
 */
function waitServicesStopped(): void {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const pods = kube.ask([
      "get",
      "pods",
      "-n",
      NAMESPACE,
      "-l",
      `app.kubernetes.io/name in (${SERVICES.join(",")})`,
      "-o",
      "name",
    ]);
    if (pods !== null && pods.trim() === "") return;
    if (Date.now() > deadline) {
      throw new Error("service chưa dừng hẳn sau 120 giây — không khôi phục");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
  }
}

scale(0);
try {
  waitServicesStopped();
  kube.run(["cp", resolve(file), `${NAMESPACE}/${POD}:${IN_POD}`]);
  inPostgres(["dropdb", "--username=udp", "--if-exists", STAGING]);
  inPostgres(["createdb", "--username=udp", STAGING]);
  try {
    inPostgres([
      "pg_restore",
      "--single-transaction",
      "--exit-on-error",
      "--username=udp",
      `--dbname=${STAGING}`,
      IN_POD,
    ]);
  } catch (e) {
    kube.ask([
      "exec",
      "-n",
      NAMESPACE,
      POD,
      "--",
      "dropdb",
      "--username=udp",
      "--if-exists",
      STAGING,
    ]);
    throw e;
  }
  inPostgres(["dropdb", "--username=udp", "--if-exists", PREVIOUS]);
  // Hai lần đổi tên trong MỘT câu lệnh — một transaction: không có lúc nào thiếu database `udp`
  inPostgres([
    "psql",
    "--username=udp",
    "--dbname=postgres",
    "--set=ON_ERROR_STOP=1",
    "--command",
    `ALTER DATABASE ${LIVE} RENAME TO ${PREVIOUS}; ALTER DATABASE ${STAGING} RENAME TO ${LIVE};`,
  ]);
} finally {
  kube.ask(["exec", "-n", NAMESPACE, POD, "--", "rm", "-f", IN_POD]);
  scale(1);
  for (const name of SERVICES) {
    kube.run([
      "rollout",
      "status",
      `deployment/${name}`,
      "-n",
      NAMESPACE,
      "--timeout=300s",
    ]);
  }
}
console.info(
  `Đã khôi phục ${file}; database trước đó còn ở "${PREVIOUS}" tới lần khôi phục sau`,
);
