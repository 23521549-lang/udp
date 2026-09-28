import { spawnSync } from "node:child_process";
import { KUBE_CONTEXT, NAMESPACE, SAMPLE_NAMESPACE } from "./cluster.js";

/**
 * In trạng thái cụm kind của UDP khi dựng hay E2E đỏ (Plan #50) — bước `if: failure()` của job `kind`, và cũng
 * là lệnh đầu tiên nên chạy ở máy khi `pnpm deploy:up` dừng giữa chừng:
 *
 *   pnpm --filter @udp/deploy diagnose
 *
 * Không bao giờ ném: một lệnh hỏng (cụm chưa có, pod chưa tạo) không được che các lệnh sau. Không in giá trị
 * Secret nào — `describe` chỉ hiện TÊN khoá được tham chiếu.
 */

function show(title: string, args: readonly string[]): void {
  console.log(`\n===== ${title} =====`);
  spawnSync("kubectl", ["--context", KUBE_CONTEXT, ...args], {
    stdio: "inherit",
  });
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
show("sample-app", [
  "logs",
  "deployment/sample-app",
  "-n",
  SAMPLE_NAMESPACE,
  "--tail=150",
]);
