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
  /**
   * [v4.9] Toàn bộ stdout + stderr tiến trình con đã in, tính từ lần `launch` đầu.
   *
   * Có để INV-23.3 quét được log của Service 2, không chỉ của Service 1: bất biến
   * nói plaintext SDK key không nằm trong log của CẢ HAI service, và log của
   * Service 2 sống trong một tiến trình khác. Không có đường đọc này thì nửa sau
   * của phép kiểm xanh vì nó không nhìn, chứ không phải vì không có gì để thấy —
   * và một test như vậy tệ hơn không có test.
   *
   * Output vẫn được thu như trước (`launch` cần nó để báo lỗi khi service không
   * lên); đây chỉ là đường đọc. Mức log mặc định là `warn`, nên test muốn thấy cả
   * dòng request phải truyền `env: { LOG_LEVEL: "info" }`.
   */
  output(): string;
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

/**
 * Một tiến trình con đã lên (`/healthz` 200), hoặc ném kèm output của nó.
 *
 * `sink` giữ output của MỌI lần thử và mọi lần `restart()`, cho `output()` của
 * service; biến `output` cục bộ chỉ là phần của LẦN THỬ này — thứ phép kiểm
 * `EADDRINUSE` và thông báo lỗi cần, và trộn hai phạm vi đó lại sẽ làm lần thử
 * thứ hai thấy `EADDRINUSE` của lần thứ nhất rồi chờ vô ích tới hết hạn.
 */
async function launch(
  spec: ServiceSpec,
  port: number,
  env: Readonly<Record<string, string>>,
  sink: string[],
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
    const record = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      sink.push(text);
    };
    child.stdout?.on("data", record);
    child.stderr?.on("data", record);

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
  const sink: string[] = [];
  let child = await launch(spec, port, env, sink);
  const service: RunningService = {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    stop: () => stopChild(child),
    async start() {
      if (!exited(child)) return;
      child = await launch(spec, port, env, sink);
    },
    async restart() {
      await service.stop();
      await service.start();
    },
    /** Nối lúc ĐỌC, không nối lúc ghi: một service nói nhiều không thành O(n²) chuỗi */
    output: () => sink.join(""),
  };
  return service;
}
