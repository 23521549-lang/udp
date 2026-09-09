import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@udp/config";
import { describe, expect, it } from "vitest";

/**
 * Chốt danh tính phải TỪ CHỐI PHỤC VỤ, không chỉ ghi log rồi chạy tiếp.
 *
 * `service-identity.test.ts` đã chứng minh `assertConnectedAs` ném khi role
 * lệch. Nhưng một hàm biết ném mà không ai gọi thì vẫn là trang trí: khối `try`
 * ở `src/index.ts` chỉ dài ba dòng, ai đó xoá nó trong một lần dọn dẹp thì
 * KHÔNG test nào đỏ, và ma trận writer §1.2 lặng lẽ tắt lại.
 *
 * Nên test này không đọc mã nguồn — nó dựng thật tiến trình với đúng cấu hình
 * sai hay gặp nhất (quên đặt `DATABASE_URL_S1` nên chuỗi kết nối rơi về owner)
 * rồi hỏi hệ thống một câu duy nhất: mày có mở cổng không? Nhờ đo hành vi chứ
 * không đo văn bản, test này miễn nhiễm với việc dời chốt sang file khác —
 * đúng như nó nên thế, vì dời chỗ mà giữ hành vi thì không phải thoái cấp.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, "..");

/** Bỏ mã màu ANSI, để phép khẳng định PHỦ ĐỊNH bên dưới không bị qua mặt */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string): string => s.replace(ANSI, "");

interface BootResult {
  code: number | null;
  output: string;
  /** true khi tiến trình sống quá lâu và phải cắt — nghĩa là nó đã mở cổng */
  survived: boolean;
}

function bootWith(databaseUrlS1: string): Promise<BootResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: PKG,
      env: { ...process.env, DATABASE_URL_S1: databaseUrlS1 },
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    /**
     * Nếu chốt bị gỡ, tiến trình mở cổng và sống mãi. Phải tự cắt, và phải GHI
     * NHẬN là đã cắt — để test báo đúng nguyên nhân thay vì treo tới lúc vitest
     * timeout với một thông báo chẳng nói gì.
     *
     * 30 giây tuy rộng so với 3 giây đo được của nhánh khoẻ, nhưng cố tình
     * rộng: hạ xuống 10 giây sẽ đổi một lần đỏ chậm lấy nguy cơ đỏ OAN trên
     * máy CI chậm, mà đỏ oan thì tệ hơn nhiều — nó dạy người ta bỏ qua test.
     */
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

describe("chốt danh tính chặn ngay ở cửa khởi động", () => {
  it("thoát mã 1 và KHÔNG mở cổng khi chuỗi kết nối rơi về owner", async () => {
    /**
     * Chuỗi owner lấy qua `@udp/config` chứ không đọc `process.env` thô: file
     * test này không import gì từ `src/`, nên nếu không có lời import ấy thì
     * dotenv chưa hề chạy và `DATABASE_URL` là `undefined` — đã đo, lần chạy
     * đầu tiên của test này đỏ đúng vì lý do đó.
     *
     * Tiền đề còn lại phải khẳng định tường minh: hai chuỗi phải KHÁC nhau.
     * Nếu trùng thì tiến trình con khởi động bình thường và test đỏ ở dòng
     * `survived` với một thông báo khó hiểu; nói thẳng ra ở đây rẻ hơn.
     */
    expect(
      env.DATABASE_URL,
      "DATABASE_URL trùng DATABASE_URL_S1 — không dựng được cấu hình sai để kiểm",
    ).not.toBe(env.DATABASE_URL_S1);

    const boot = await bootWith(env.DATABASE_URL);

    expect(
      boot.survived,
      "tiến trình vẫn sống sau 30 giây — chốt đã bị gỡ, cổng đã mở",
    ).toBe(false);
    expect(boot.code).toBe(1);

    /**
     * Mã thoát 1 một mình CHƯA ĐỦ: `index.ts` hỏng vì bất cứ lý do nào khác —
     * thiếu biến môi trường, lỗi cú pháp — cũng cho mã 1. Phải đọc được đúng
     * lời than về lệch role, nếu không test sẽ pass vì lý do sai. Đó đúng là
     * cái bẫy I39(b) từng dính: nó xanh vì FK chặn trước, không phải vì
     * trigger chạy.
     */
    expect(boot.output).toContain("danh tính kết nối database sai");
    expect(boot.output).toContain("postgres");
    expect(boot.output).toContain("udp_s1");

    /**
     * Dòng then chốt của cả file: chốt phải chạy TRƯỚC `listen()`. Nếu ai đó
     * dời nó xuống sau, mã thoát vẫn là 1 và ba khẳng định trên vẫn xanh —
     * nhưng cổng đã kịp mở và phục vụ. Đây là chỗ duy nhất bắt được điều đó.
     */
    expect(boot.output).not.toContain("đã khởi động");
  }, 60_000);
});
