import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./net.js";

/**
 * Dựng Service 2 THẬT bằng tiến trình con cho test của Service 3.
 *
 * Vì sao không import `createApp()` của S2: đó là import xuyên service — đúng
 * thứ `package-boundaries` sinh ra để chặn — và cũng không phải cách hai service
 * gặp nhau ngoài đời. Qua HTTP thật, `If-Match`, `X-Internal-Secret`, 412 và
 * fencing của S2 đều được kiểm như một hộp đen.
 *
 * Đo 12/09/2026: S2 boot ~4 giây, giữ 2 backend (pool + LISTEN) trên pooler và
 * pooler còn giữ chúng ~10 giây sau khi tiến trình chết — nên dựng MỘT lần cho
 * cả file test, không mỗi `it`. Trên Windows `kill()` là TerminateProcess, handler
 * tắt êm của S2 không chạy; chấp nhận được cho test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FLAG_SERVICE_DIR = resolve(here, "../../../flag-service");

export interface RunningFlagService {
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startFlagService(): Promise<RunningFlagService> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "src/index.ts"],
    {
      cwd: FLAG_SERVICE_DIR,
      env: {
        ...process.env,
        FLAG_SERVICE_PORT: String(port),
        LOG_LEVEL: "warn",
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

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(
        `flag-service thoát sớm (${String(child.exitCode)}):\n${output}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) break;
    } catch {
      // chưa lên
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`flag-service không lên trong 40s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) {
          done();
          return;
        }
        child.once("exit", () => done());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 5_000).unref();
      }),
  };
}
