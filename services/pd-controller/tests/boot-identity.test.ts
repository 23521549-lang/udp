import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@udp/config";
import { describe, expect, it } from "vitest";
import { freePort } from "./helpers/net.js";

/**
 * Chốt danh tính của Service 3 phải TỪ CHỐI PHỤC VỤ khi role sai — cùng lý do
 * với test cùng tên của hai service kia: design-lint đọc văn bản, chỉ tiến trình
 * thật mới bắt được lời gọi chốt bị gỡ khỏi entrypoint.
 *
 * Với S3 chốt này canh ngoại lệ hẹp nhất của §1.2: rơi về owner là reconciler
 * ghi được toàn bộ cấu hình flag.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, "..");

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI, "");

interface BootResult {
  code: number | null;
  output: string;
  survived: boolean;
}

async function bootWith(
  overrides: Record<string, string>,
  until?: (output: string) => boolean,
): Promise<BootResult> {
  // Cổng rảnh: không đụng `dev:pd` đang chạy trên 3003 của người phát triển
  const port = await freePort();
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: PKG,
      env: { ...process.env, PD_CONTROLLER_PORT: String(port), ...overrides },
    });
    let output = "";
    let survived = false;
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (!survived && until?.(plain(output)) === true) {
        survived = true;
        child.kill();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const cut = setTimeout(() => {
      survived = true;
      child.kill();
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(cut);
      done({ code, output: plain(output), survived });
    });
  });
}

describe("chốt danh tính của Service 3 chặn ngay ở cửa khởi động", () => {
  it("thoát mã 1 và KHÔNG mở cổng khi DATABASE_URL_S3 rơi về owner", async () => {
    expect(
      env.DATABASE_URL,
      "DATABASE_URL trùng DATABASE_URL_S3 — không dựng được cấu hình sai để kiểm",
    ).not.toBe(env.DATABASE_URL_S3);

    const boot = await bootWith({ DATABASE_URL_S3: env.DATABASE_URL });
    expect(
      boot.survived,
      "tiến trình vẫn sống sau 30 giây — chốt đã bị gỡ",
    ).toBe(false);
    expect(boot.code).toBe(1);
    expect(boot.output).toContain("danh tính kết nối database sai");
    expect(boot.output).toContain("postgres");
    expect(boot.output).toContain("udp_s3");
    expect(boot.output).not.toContain("đã khởi động");
  }, 60_000);

  it("thoát mã 1 khi kênh LISTEN rollout_intent nối bằng owner — chuỗi thứ hai cũng phải mang udp_s3", async () => {
    expect(
      env.DATABASE_URL_DIRECT,
      "DATABASE_URL_DIRECT trùng DATABASE_URL_S3_DIRECT — không dựng được cấu hình sai để kiểm",
    ).not.toBe(env.DATABASE_URL_S3_DIRECT);

    const boot = await bootWith({
      LOG_LEVEL: "info",
      ROLLOUT_INTENT_LISTEN_ENABLED: "true",
      DATABASE_URL_S3_DIRECT: env.DATABASE_URL_DIRECT,
    });

    expect(boot.survived, "chốt của kênh LISTEN đã bị gỡ").toBe(false);
    expect(boot.code).toBe(1);
    // Chốt thứ nhất (pool) phải QUA — không thì ca này đỏ vì lý do của ca trên
    expect(boot.output).toContain("Danh tính kết nối database đã xác nhận");
    expect(boot.output).toContain("kênh LISTEN rollout_intent");
    expect(boot.output).toContain("postgres");
    expect(boot.output).not.toContain("đã khởi động");
  }, 60_000);

  it("khởi động bình thường với udp_s3, ghi lệch đồng hồ, và kênh rollout_intent thật sự nghe", async () => {
    const boot = await bootWith(
      { LOG_LEVEL: "info", ROLLOUT_INTENT_LISTEN_ENABLED: "true" },
      (output) =>
        output.includes("đã khởi động") &&
        output.includes("Kênh LISTEN của rollout_intent đang nghe"),
    );
    expect(boot.survived, boot.output).toBe(true);
    expect(boot.output).toContain("Danh tính kết nối database đã xác nhận");
    expect(boot.output).toContain("Lệch đồng hồ so với database");
    expect(boot.output).not.toContain("danh tính kết nối database sai");
  }, 60_000);
});
