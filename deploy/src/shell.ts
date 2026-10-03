import { spawnSync } from "node:child_process";

/** Chạy một lệnh, in thẳng ra màn hình; mã thoát khác 0 ⇒ ném kèm lệnh đã chạy */
export function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} thoát mã ${String(result.status)}`,
    );
  }
}

/** Chạy và lấy stdout; `null` khi lệnh thất bại (dùng để HỎI trạng thái, không để làm) */
export function query(command: string, args: readonly string[]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

/**
 * Lệnh hỏi phiên bản của từng công cụ. `kubectl version` trần hỏi cả API server và thoát mã 1 khi chưa có cụm nào
 * — đúng lúc `deploy:up` hỏi, trước khi dựng cụm; `sudo` không có lệnh con `version`. `docker version` thì CỐ Ý
 * hỏi cả daemon: Docker có mà chưa chạy cũng là "chưa dùng được".
 */
const VERSION_PROBE: Readonly<Record<string, readonly string[]>> = {
  kubectl: ["version", "--client"],
  sudo: ["-V"],
};

/** Công cụ có trên PATH và dùng được không */
export function has(command: string): boolean {
  const probe = VERSION_PROBE[command] ?? ["version"];
  return spawnSync(command, probe, { stdio: "ignore" }).status === 0;
}
