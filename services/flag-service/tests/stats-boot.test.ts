import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * [v4.9] Timer nền chỉ được khởi động trong `index.ts`, SAU `listen` (R13 (c)).
 *
 * Vì sao canh bằng văn bản chứ không bằng hành vi: một `createApp()` khởi động
 * flusher KHÔNG làm test nào đỏ — nó chỉ bắn truy vấn nền trong mọi file test
 * dựng app, trên đúng pool 5 khe mà test đang dùng. Thứ không làm test đỏ thì
 * phải có một lưới riêng, và lưới đó phải nông và tự động: nó cũng sẽ bắt job
 * nền THỨ TƯ mà chưa ai viết.
 *
 * Giới hạn đã biết, ghi ra để không ai tưởng nó mạnh hơn thực tế: nó đọc chữ,
 * nên một job được `start()` gián tiếp qua một hàm khác trong `app.ts` sẽ lọt.
 * Chốt hành vi thật là chính các file test tích hợp: chúng dựng app hàng chục
 * lần mà số truy vấn nền vẫn bằng 0.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../src");
const read = (file: string): string =>
  readFileSync(join(SRC, file), "utf8").replace(/\r\n/g, "\n");

/** Mọi job nền của tiến trình — thêm job mới thì thêm tên vào đây */
const BACKGROUND_JOBS = [
  "changeFeedWatcher",
  "pruneJob",
  "statsFlusher",
  "statsRollupJob",
  "notifyAccelerator",
] as const;

describe("khởi động job nền", () => {
  it("createApp() không gọi `.start()` của bất kỳ job nào", () => {
    const app = read("app.ts");
    expect(app).not.toMatch(/\.start\(/);
    for (const job of BACKGROUND_JOBS) expect(app).not.toContain(job);
  });

  it("index.ts start MỌI job SAU `listen`, và stop tất cả khi tắt", () => {
    const index = read("index.ts");
    const listenAt = index.indexOf(".listen(");
    expect(listenAt).toBeGreaterThan(0);

    for (const job of BACKGROUND_JOBS) {
      const startAt = index.indexOf(`${job}.start()`);
      const optionalStartAt = index.indexOf(`${job}?.start()`);
      const at = startAt >= 0 ? startAt : optionalStartAt;
      expect(at, `${job} phải được start trong index.ts`).toBeGreaterThan(
        listenAt,
      );
      expect(index).toMatch(new RegExp(`${job}\\??\\.stop\\(`));
    }
  });

  it("lần flush cuối nằm TRƯỚC `$disconnect` và sau khi ngừng nhận báo cáo", () => {
    const index = read("index.ts");
    const stopAccepting = index.indexOf("statsIngest.close()");
    const flush = index.indexOf("statsFlusher.flushNow(");
    const disconnect = index.indexOf("prisma.$disconnect()");

    expect(stopAccepting).toBeGreaterThan(0);
    expect(flush).toBeGreaterThan(stopAccepting);
    expect(disconnect).toBeGreaterThan(flush);
  });
});
