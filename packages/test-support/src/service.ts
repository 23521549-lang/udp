import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./net.js";

/**
 * Dựng một service THẬT bằng tiến trình con cho test của service khác — hôm nay
 * Service 2 cho test của Service 1 (`track` lúc tạo rollout) và Service 3
 * (PATCH/ untrack) [v4.4: chuyển từ helper của S3 vào package dùng chung].
 *
 * Vì sao không import `createApp()` của S2: đó là import xuyên service — ranh
 * giới mà kiến trúc giữ (service chỉ gặp nhau qua HTTP và database) — và cũng
 * không phải cách hai service gặp nhau ngoài đời. Qua HTTP thật, `If-Match`, `X-Internal-Secret`, 412 và
 * fencing của S2 đều được kiểm như một hộp đen.
 *
 * Đo 12/09/2026: S2 boot ~4 giây, giữ 2 backend (pool + LISTEN) trên pooler và
 * pooler còn giữ chúng ~10 giây sau khi tiến trình chết — nên dựng MỘT lần cho
 * cả file test, không mỗi `it`. Trên Windows `kill()` là TerminateProcess, handler
 * tắt êm của S2 không chạy; chấp nhận được cho test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = resolve(here, "../../../services");

export interface RunningService {
  baseUrl: string;
  stop(): Promise<void>;
  /**
   * [v4.7] Dựng lại sau `stop()` trên CÙNG cổng, cùng env — client đang giữ
   * `baseUrl` (provider, I34) thấy một khoảng chết do test quyết định độ dài.
   * Service đang chạy thì không làm gì.
   */
  start(): Promise<void>;
  /** [v4.7] `stop()` rồi `start()` — một lần mất kết nối ngắn nhất có thể */
  restart(): Promise<void>;
}

export interface ServiceSpec {
  /** Tên thư mục dưới `services/` */
  dir: string;
  /** Biến môi trường chọn cổng của service đó */
  portEnv: string;
}

export interface StartOptions {
  /** [v4.7] Biến môi trường ghi đè `.env` (dotenv không ghi đè biến đã có) */
  env?: Readonly<Record<string, string>>;
  /** Cổng cố định; mặc định một cổng rảnh */
  port?: number;
}

export const FLAG_SERVICE: ServiceSpec = {
  dir: "flag-service",
  portEnv: "FLAG_SERVICE_PORT",
};

export function startFlagService(
  options: StartOptions = {},
): Promise<RunningService> {
  return startService(FLAG_SERVICE, options);
}

const BOOT_DEADLINE_MS = 40_000;

/** Bị giết bằng tín hiệu thì `exitCode` vẫn null — chỉ `signalCode` được đặt */
const exited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Một tiến trình con đã lên (`/healthz` 200), hoặc ném kèm output của nó */
async function launch(
  spec: ServiceSpec,
  port: number,
  env: Readonly<Record<string, string>>,
): Promise<ChildProcess> {
  const deadline = Date.now() + BOOT_DEADLINE_MS;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  for (;;) {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--import", "tsx", "src/index.ts"],
      {
        cwd: resolve(SERVICES_DIR, spec.dir),
        env: {
          ...process.env,
          LOG_LEVEL: "warn",
          ...env,
          [spec.portEnv]: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    for (;;) {
      if (exited(child)) break;
      try {
        const res = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) return child;
      } catch {
        // chưa lên
      }
      if (Date.now() > deadline) {
        child.kill();
        throw new Error(
          `${spec.dir} không lên trong ${String(BOOT_DEADLINE_MS / 1000)}s:\n${output}`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    // Cổng của tiến trình trước chưa được hệ điều hành trả lại (restart cùng
    // cổng) — thử lại trong hạn; mọi lỗi khác là lỗi thật
    if (!output.includes("EADDRINUSE") || Date.now() > deadline) {
      throw new Error(
        `${spec.dir} thoát sớm (${String(child.exitCode)}):\n${output}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((done) => {
    if (exited(child)) {
      done();
      return;
    }
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!exited(child)) child.kill("SIGKILL");
    }, 5_000).unref();
  });
}

export async function startService(
  spec: ServiceSpec,
  options: StartOptions = {},
): Promise<RunningService> {
  const port = options.port ?? (await freePort());
  const env = options.env ?? {};
  let child = await launch(spec, port, env);
  const service: RunningService = {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    stop: () => stopChild(child),
    async start() {
      if (!exited(child)) return;
      child = await launch(spec, port, env);
    },
    async restart() {
      await service.stop();
      await service.start();
    },
  };
  return service;
}
