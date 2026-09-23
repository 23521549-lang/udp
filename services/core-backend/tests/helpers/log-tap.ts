import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "@udp/http";

/**
 * Thu log của Service 1 TRONG TIẾN TRÌNH này, để INV-23.3 quét được (R04) [v4.9].
 *
 * Bất biến đòi quét log của cả hai service. Log của Service 2 đọc qua
 * `RunningService.output()` (nó là tiến trình con, stdout đã được thu). Service 1
 * thì chạy ngay trong worker của vitest, và log của nó đi thẳng ra fd 1 — đã đo,
 * không suy đoán: với `NODE_ENV=test` thì `isDevelopment` là false, nên pino
 * KHÔNG dùng transport `pino-pretty` (một worker thread, không chặn được từ đây)
 * mà ghi qua `sonic-boom`, tức `fs.write(1, …)`.
 *
 * Vì sao không chặn `process.stdout.write`: `sonic-boom` không đi qua đó. Vì sao
 * không dựng một logger riêng cho test: thứ cần kiểm là log THẬT mà service sẽ
 * ghi ở production, sau khi `redactPaths` của pino đã chạy — một logger khác là
 * kiểm một đường khác. Đây là cái giá phải trả để phép kiểm nói về đúng thứ nó
 * nói, và nó chỉ sống trong test.
 *
 * Chặn ở tầng `fs.write` là toàn cục trong tiến trình, nên `stop()` phải chạy
 * trong `afterAll`.
 */
export interface LogTap {
  /** Mọi thứ đã ghi ra fd 1 từ lúc `tapServiceLog()` */
  text(): string;
  /**
   * Ghi một dấu mốc qua CHÍNH `logger` rồi chờ nó hiện ra trong `text()`.
   *
   * Hai việc trong một: đẩy phần log còn trong bộ đệm của `sonic-boom` ra (nó ghi
   * không đồng bộ, nên đọc ngay sau một request là đọc thiếu), và CHỨNG MINH tap
   * còn hoạt động. Việc thứ hai mới là việc quan trọng: một phép kiểm "không có
   * plaintext trong log" sẽ xanh y như vậy nếu tap hỏng và `text()` luôn rỗng —
   * đó là loại test tệ hơn không có test. Mốc không xuất hiện trong hạn thì ném,
   * nên tap hỏng là ĐỎ, không phải xanh.
   *
   * Không `sleep` một khoảng cố định: chờ theo điều kiện, hết hạn thì ném.
   */
  settle(timeoutMs?: number): Promise<void>;
  stop(): void;
}

export function tapServiceLog(): LogTap {
  const chunks: string[] = [];
  const original = fs.write;

  const patched = function write(...args: unknown[]): void {
    const [fd, buffer] = args;
    if (fd === 1 && (typeof buffer === "string" || Buffer.isBuffer(buffer))) {
      chunks.push(buffer.toString());
    }
    (original as unknown as (...a: unknown[]) => void)(...args);
  };
  (fs as { write: unknown }).write = patched;

  const text = (): string => chunks.join("");

  return {
    text,
    async settle(timeoutMs = 5_000) {
      const marker = `logtap-${randomUUID()}`;
      logger.warn({ marker }, "log-tap settle");
      logger.flush();

      const deadline = Date.now() + timeoutMs;
      while (!text().includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(
            `tapServiceLog: sau ${String(timeoutMs)} ms vẫn không thấy dấu mốc — ` +
              "tap không còn thu được log của Service 1, nên mọi phép quét log sau đây là vô nghĩa",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    stop() {
      (fs as { write: unknown }).write = original;
    },
  };
}
