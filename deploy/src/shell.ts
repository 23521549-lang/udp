import { spawn, spawnSync } from "node:child_process";

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

/**
 * Như `run`, nhưng KHÔNG chặn event loop trong lúc chờ.
 *
 * Dùng khi chính tiến trình đang chờ còn phải phục vụ thứ gì đó - một server trong tiến trình
 * test chẳng hạn. `run` (spawnSync) đứng yên cả tiến trình: Plan #64 64f, bồn nhận sao lưu của
 * E2E máy ảo không đọc được upload suốt 300 giây `kubectl wait`, job sao lưu không bao giờ
 * xong, curl thoát 56 khi bồn đóng.
 *
 * - `spawn` gọi TRONG executor: lỗi đồng bộ (`EINVAL` khi gọi `.cmd` trên Windows) thành reject.
 * - Nghe `error`: lệnh không tồn tại phát `error` rồi `close`, KHÔNG phát `exit`.
 * - Không `shell`: đường `node.exe` trên Windows có dấu cách.
 * - Lệnh phải TỰ có hạn (`--timeout` của kubectl…): runner test không có tín hiệu huỷ để
 *   truyền xuống, nên hết giờ test thì con vẫn chạy tới hạn của chính nó.
 */
export function runAsync(
  command: string,
  args: readonly string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const how =
        signal === null ? `thoát mã ${String(code)}` : `bị tín hiệu ${signal}`;
      reject(new Error(`${command} ${args.join(" ")} ${how}`));
    });
  });
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
