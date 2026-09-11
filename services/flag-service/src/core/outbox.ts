import { env } from "@udp/config";
import { writeWithOutbox, type OutboxWrite } from "@udp/db";
import { prisma } from "./db.js";

/**
 * Mọi lần ghi cấu hình của Service 2 đi qua đây — quyết định tầng 3 của S2 nằm
 * MỘT chỗ thay vì lặp ở từng service.
 *
 * `writeWithOutbox` bắt mỗi writer tự nói có phát `NOTIFY` hay không, vì cái giá là
 * thật: commit của mọi transaction có `NOTIFY` xếp hàng qua một khoá toàn cục của
 * PostgreSQL (`PreCommit_Notify`). Với S2, câu trả lời là cờ
 * `CHANGEFEED_NOTIFY_ENABLED` — cùng cờ bật kênh nghe của chính nó. Tắt cờ là tắt
 * cả hai phía, nên cấu hình "không NOTIFY" của phép đo E4 mới là đối chứng sạch.
 */
export function writeConfigChange<T>(
  write: Omit<OutboxWrite<T>, "notify">,
): Promise<T> {
  return writeWithOutbox(prisma, {
    ...write,
    notify: env.CHANGEFEED_NOTIFY_ENABLED,
  });
}
