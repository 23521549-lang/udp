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

/** Công cụ có trên PATH không */
export function has(command: string): boolean {
  return spawnSync(command, ["version"], { stdio: "ignore" }).status === 0;
}
