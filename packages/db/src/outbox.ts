import type { Prisma } from "./generated/prisma/client.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import {
  CONFIG_CHANGE_CHANNEL,
  formatConfigChangeNotice,
  type ConfigChangeType,
} from "@udp/shared-types/change-feed";

/**
 * Kỷ luật ghi của ADR-05 — nơi DUY NHẤT được tăng `config_version`.
 *
 * Vì sao ở `packages/db` chứ không trong `services/flag-service`: migration
 * `service_roles` cấp cho `udp_s3` đúng ba quyền để làm kill-switch (§7.6) —
 * `UPDATE` cột `serve`, `UPDATE` hai cột `config_version`/`config_hash`, và
 * `INSERT config_change_log`. Nghĩa là Service 3 CŨNG là writer của đường lan
 * truyền. Để hàm này trong Service 2 thì Service 3 sẽ tự viết lại, và gần như
 * chắc chắn lệch: chỉ cần nó tăng version mà không khoá trước là hai transaction
 * cùng cấp một số `v`, rồi `@@unique([environmentId, configVersion])` bắn P2002
 * cho một bên — hoặc tệ hơn, hai dòng outbox commit ngược thứ tự. I15b và I30
 * cùng đúng bằng cấu trúc chỉ khi kỷ luật này sống đúng một chỗ.
 */

/**
 * Từ vựng ĐÓNG của `ConfigChangeLog.change_type` (§2.2) — nay là danh sách CHẠY
 * ĐƯỢC trong `@udp/shared-types/change-feed`, để `design-lint` so được nó với tài
 * liệu. Union cũ ở đây chỉ tồn tại lúc biên dịch nên không gì so được nó với §2.2.
 * Re-export ở đây để API công khai của `@udp/db` giữ nguyên.
 */
export type { ConfigChangeType };

export interface OutboxWrite<T> {
  /** Mọi environment bị ảnh hưởng. Tạo flag mới chạm TẤT CẢ environment của project. */
  environmentIds: readonly string[];
  changeType: ConfigChangeType;
  /** NULL nghĩa là Service 3 ghi trong lúc rollout (§2.2) */
  actorUserId?: string;
  /**
   * Tầng 3 (ADR-05): phát `NOTIFY` trong transaction này để đánh thức replica.
   *
   * BẮT BUỘC, không có mặc định: `NOTIFY` bắt commit xếp hàng qua một khoá toàn cục
   * (`PreCommit_Notify` trong `async.c` giữ `AccessExclusiveLock` tới sau commit),
   * nên mỗi writer phải tự nói nó có trả giá đó không — Service 2 truyền
   * `CHANGEFEED_NOTIFY_ENABLED` qua `writeConfigChange` của nó. Một mặc định ngầm ở
   * đây là quyết định hộ mọi writer tương lai, kể cả kill-switch của Service 3.
   */
  notify: boolean;
  /** Bước 2 — thay đổi nghiệp vụ thật */
  mutate: (tx: Prisma.TransactionClient) => Promise<T>;
  /**
   * Bước 3 VÀ bước 4 — cả hai đều là hàm của trạng thái SAU thay đổi, ở một
   * environment cụ thể.
   *
   * Vì sao một hàm chứ không phải hai: `config_hash` và `payload` cùng đọc đúng
   * một snapshot. Tách đôi thì hoặc đọc snapshot hai lần dưới row-lock — mà
   * `snapshotOf` là truy vấn nặng nhất trong transaction — hoặc bên tính delta
   * không có snapshot để dựng delta từ đó, và sẽ ghi ra một thông báo "có gì đó
   * đổi" thay vì một delta. Cột `payload` của §2.2 nói rõ nó là "delta đầy đủ để
   * replica cập nhật cache mà không phải đọc lại toàn bộ"; một thông báo thì
   * không làm được điều đó, và tầng 2 của ADR-05 sẽ trùng vai tầng 3.
   *
   * `configHash` do bên gọi tính, không phải `@udp/db` tính: package này giữ KỶ
   * LUẬT TRANSACTION, còn "snapshot là gì" và "delta là gì" thuộc về service sở
   * hữu nghiệp vụ đó. Đảo lại thì `@udp/db` phải phụ thuộc
   * `@udp/flag-evaluator`, và Service 3 — writer thứ hai của đường này (§7.6) —
   * kéo theo cả lõi đánh giá flag mà nó không dùng.
   */
  stateOf: (
    tx: Prisma.TransactionClient,
    environmentId: string,
  ) => Promise<{ configHash: string; delta: Prisma.InputJsonValue }>;
}

/**
 * Ngân sách của transaction.
 *
 * Mặc định của Prisma là `timeout: 5000ms`. Đã đo RTT tới database ở Singapore
 * là ~50ms, tức 5 giây chỉ đủ 100 lượt đi về — và một lần tạo flag chạm N
 * environment tốn khoảng `4N + 3` lượt (câu `NOTIFY` của tầng 3 là MỘT lượt cho cả
 * lần ghi; `stateOf` là MỘT câu lệnh cho mỗi environment từ [v4.2]).
 * Khai tường minh, rộng hơn, và nói rõ con số thay vì để mặc định âm thầm cắt
 * giữa chừng bằng `P2028` sau khi đã giữ khoá suốt thời gian đó.
 *
 * `maxWait` là thời gian chờ MỘT khe trong pool (mặc định `DATABASE_POOL_MAX`
 * là 5). Nó khác `timeout`, và nhầm hai cái là chẩn nhầm nguyên nhân.
 */
const TRANSACTION_BUDGET = { timeout: 20_000, maxWait: 5_000 } as const;

/**
 * Ghi một thay đổi cấu hình theo đúng thứ tự bốn bước của ADR-05 (§8.4):
 *
 *   1. `UPDATE environments SET config_version = config_version + 1 … RETURNING`
 *   2. thay đổi thật
 *   3. cập nhật `config_hash` = sha256(snapshot chuẩn hoá)
 *   4. `INSERT config_change_log` mang ĐÚNG version đó — ghi cuối cùng
 *
 * Rồi, nếu `notify`: `pg_notify` cho mọi environment của lần ghi — vẫn TRONG
 * transaction, nên notification chỉ đi khi cả bốn bước đã commit.
 *
 * Ba chi tiết mà đổi thứ tự là hỏng, mỗi cái một kiểu:
 *
 * **Bước 1 phải là bước đầu.** Chính lệnh `UPDATE` giữ row lock trên hàng
 * `Environment` tới lúc COMMIT, biến hàng đó thành điểm tuần tự hoá duy nhất.
 * Nhờ vậy thứ tự `config_version` trùng thứ tự commit và không có hổng vĩnh
 * viễn (I15b) — một transaction rollback thì version của nó chưa từng tồn tại.
 *
 * **Bước 3 phải sau bước 2.** Tính hash trước khi thay đổi được ghi là băm
 * trạng thái CŨ, nên `config_hash` mô tả sai nội dung ở MỌI lần ghi. Replica so
 * mỗi 60 giây sẽ lệch liên tục, ngắt mạch tầng delta sau ba lần, rồi lặp lại
 * vĩnh viễn — tầng delta chết mà không có gì báo là nó chết vì lý do này.
 *
 * **Bước 4 phải cuối cùng.** Dòng outbox là tín hiệu "đã xong"; ghi nó trước
 * khi thay đổi hoàn tất là mời replica đọc một trạng thái chưa có.
 */
export async function writeWithOutbox<T>(
  client: PrismaClient,
  write: OutboxWrite<T>,
): Promise<T> {
  /**
   * Danh sách RỖNG là LỖI LẬP TRÌNH, không phải "không có gì để làm".
   *
   * Không có chốt này, `mutate` vẫn chạy — nhưng không khoá environment nào,
   * không tăng version nào, không ghi dòng outbox nào. Tức là một lần ghi lọt
   * hoàn toàn khỏi ADR-05: thay đổi có thật trong database mà không replica nào
   * được báo, và `config_hash` mô tả một trạng thái đã không còn đúng.
   */
  if (write.environmentIds.length === 0) {
    throw new Error(
      "writeWithOutbox gọi với danh sách environment rỗng — mọi thay đổi cấu " +
        "hình phải chạm ít nhất một environment, nếu không nó lọt khỏi ADR-05",
    );
  }

  /**
   * Khoá theo THỨ TỰ TẤT ĐỊNH.
   *
   * Một lần sửa segment chạm mọi environment có rule dùng nó (§3.2), nên hai
   * lần sửa đồng thời sẽ khoá cùng một tập hàng. Khoá theo thứ tự khác nhau là
   * deadlock thật (`40P01`), và Postgres chỉ phát hiện sau `deadlock_timeout`
   * rồi huỷ một bên. Sắp id trước khi khoá làm hình dạng đó không tồn tại.
   */
  const ids = [...new Set(write.environmentIds)].sort();

  return client.$transaction(async (tx) => {
    // ---- Bước 1: khoá và cấp version --------------------------------------
    const stamped: { environmentId: string; configVersion: number }[] = [];
    for (const environmentId of ids) {
      const row = await tx.environment.update({
        where: { id: environmentId },
        data: { configVersion: { increment: 1 } },
        select: { configVersion: true },
      });
      stamped.push({ environmentId, configVersion: row.configVersion });
    }

    // ---- Bước 2: thay đổi thật ---------------------------------------------
    const result = await write.mutate(tx);

    // ---- Bước 3 và 4 --------------------------------------------------------
    for (const { environmentId, configVersion } of stamped) {
      const { configHash, delta } = await write.stateOf(tx, environmentId);

      await tx.environment.update({
        where: { id: environmentId },
        data: { configHash },
      });

      await tx.configChangeLog.create({
        data: {
          environmentId,
          configVersion,
          changeType: write.changeType,
          payload: delta,
          // Spread có điều kiện: với `exactOptionalPropertyTypes`, gán
          // `actorUserId: undefined` là lỗi biên dịch chứ không phải "bỏ trống".
          ...(write.actorUserId === undefined
            ? {}
            : { actorUserId: write.actorUserId }),
        },
      });
    }

    // ---- Tầng 3: đánh thức replica — TRONG transaction ---------------------
    // PostgreSQL chỉ giao notification lúc COMMIT, nên một lần ghi rollback không
    // đánh thức ai (đã đo). MỘT câu cho mọi environment: một lượt đi về, không N.
    // `$executeRaw` chứ không `$queryRaw`: `pg_notify` trả `void`, và Prisma không
    // giải mã được cột kiểu đó (đã đo: P2010). Payload dựng bằng đúng hàm mà bên
    // nghe dùng để đọc — lệch tên trường là lỗi biên dịch, không phải tầng 3 điếc.
    if (write.notify) {
      const notices = stamped.map(({ environmentId, configVersion }) =>
        formatConfigChangeNotice({ environmentId, configVersion }),
      );
      await tx.$executeRaw`SELECT pg_notify(${CONFIG_CHANGE_CHANNEL}, p) FROM unnest(${notices}::text[]) AS p`;
    }

    return result;
  }, TRANSACTION_BUDGET);
}
