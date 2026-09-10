import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@udp/config";
import { describe, expect, it } from "vitest";

/**
 * Chốt danh tính của Service 2 phải TỪ CHỐI PHỤC VỤ khi role sai.
 *
 * Vì sao cần một test riêng dù đã có `service-boot-contract.test.ts`: lint kia
 * đọc văn bản, và giới hạn #1 mà chính nó ghi ra là "xoá lời gọi chốt ở
 * entrypoint thì lint vẫn xanh" — `assertConnectedAs` vẫn còn trong `core/db.ts`
 * nên luật của nó vẫn thoả. Đã đo lại đúng điều đó khi dựng service này: gỡ hẳn
 * khối `try` khỏi `index.ts`, 35 test của design-lint vẫn xanh.
 *
 * Chỉ phép thử dựng tiến trình thật mới bắt được, nên mỗi service phải có một
 * cái của riêng mình.
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

function bootWith(databaseUrlS2: string): Promise<BootResult> {
  return new Promise((done) => {
    /**
     * Ghi đè `DATABASE_URL_S2`, KHÔNG phải `DATABASE_URL_S1`.
     *
     * Chép nguyên test của core-backend mà quên đổi tên biến là cái bẫy im lặng
     * nhất ở đây: tiến trình con sẽ khởi động BÌNH THƯỜNG vì `DATABASE_URL_S2`
     * thật vẫn còn trong môi trường, `survived` thành true, và test đỏ với một
     * thông báo chẳng liên quan gì tới nguyên nhân.
     */
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL_S2: databaseUrlS2 },
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    let survived = false;
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

describe("chốt danh tính của Service 2 chặn ngay ở cửa khởi động", () => {
  it("thoát mã 1 và KHÔNG mở cổng khi chuỗi kết nối rơi về owner", async () => {
    expect(
      env.DATABASE_URL,
      "DATABASE_URL trùng DATABASE_URL_S2 — không dựng được cấu hình sai để kiểm",
    ).not.toBe(env.DATABASE_URL_S2);

    const boot = await bootWith(env.DATABASE_URL);

    expect(
      boot.survived,
      "tiến trình vẫn sống sau 30 giây — chốt đã bị gỡ, cổng đã mở",
    ).toBe(false);
    expect(boot.code).toBe(1);

    // Mã thoát 1 một mình chưa đủ: mọi lỗi khởi động khác cũng cho mã 1.
    expect(boot.output).toContain("danh tính kết nối database sai");
    expect(boot.output).toContain("postgres");
    expect(boot.output).toContain("udp_s2");

    // Chốt phải chạy TRƯỚC listen(). Nếu ai đó dời nó xuống sau, mã thoát vẫn
    // là 1 và ba dòng trên vẫn xanh — chỉ dòng này bắt được.
    expect(boot.output).not.toContain("đã khởi động");
  }, 60_000);
});
