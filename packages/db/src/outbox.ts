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

/** Bước 3 và 4 của một environment: hash sau thay đổi, và delta cho dòng outbox */
export interface OutboxState {
  configHash: string;
  delta: Prisma.InputJsonValue;
}

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
   * hữu nghiệp vụ đó (`@udp/flag-snapshot`). Đảo lại thì `@udp/db` phải phụ
   * thuộc `@udp/flag-evaluator` và vòng phụ thuộc khép lại: package snapshot đã
   * đọc database qua `@udp/db`.
   */
  stateOf: (
    tx: Prisma.TransactionClient,
    environmentId: string,
  ) => Promise<OutboxState>;
}

/**
 * Ngân sách của transaction.
 *
 * Mặc định của Prisma là `timeout: 5000ms`. Đã đo RTT tới database ở Singapore
 * là ~50ms, tức 5 giây chỉ đủ 100 lượt đi về — và một lần tạo flag chạm N
 * environment tốn khoảng `4N + 3` lượt (câu `NOTIFY` của tầng 3 là MỘT lượt cho cả
 * lần ghi; `stateOf` là MỘT câu lệnh cho mỗi environment từ [v4.2]; [v4.10] bước
 * 4 gộp thành MỘT câu khi payload giống nhau ở mọi environment, bớt `N − 1` lượt).
 * Khai tường minh, rộng hơn, và nói rõ con số thay vì để mặc định âm thầm cắt
 * giữa chừng bằng `P2028` sau khi đã giữ khoá suốt thời gian đó.
 *
 * `maxWait` là thời gian chờ MỘT khe trong pool (mặc định `DATABASE_POOL_MAX`
 * là 5). Nó khác `timeout`, và nhầm hai cái là chẩn nhầm nguyên nhân.
 */
const TRANSACTION_BUDGET = { timeout: 20_000, maxWait: 5_000 } as const;

/** Một dòng của bước 4: version cấp ở bước 1, payload dựng ở bước 3 */
interface OutboxRow {
  environmentId: string;
  configVersion: number;
  /** Đã tuần tự hoá — bước 4 so payload giữa các environment bằng chuỗi */
  payload: string;
}

function assertInserted(inserted: number, expected: number): void {
  if (inserted !== expected) {
    throw new Error(
      `writeWithOutbox: ghi outbox trả ${String(inserted)} hàng, cần đúng ${String(expected)}`,
    );
  }
}

/**
 * Bước 4 cho mọi environment của lần ghi.
 *
 * INSERT thô, KHÔNG `RETURNING` — có chủ đích [v4.3]. `create` của Prisma là
 * `INSERT ... RETURNING *`, tức cần SELECT trên bảng; `udp_s3` (kill-switch,
 * §7.6) chỉ có INSERT, đúng §1.2 — đo 12/09/2026: 42501. Không nới quyền cho S3
 * đọc sổ outbox chỉ để Prisma đọc lại một hàng không ai dùng. `id` và
 * `created_at` là mặc định phía database.
 *
 * [v4.10] `payload` GIỐNG NHAU ở mọi environment là ca thường của một lần ghi
 * fan-out: delta của `segment.updated` là chính segment, thứ thuộc PROJECT chứ
 * không thuộc environment. Mỗi câu INSERT là một lần đẩy cả payload lên dây —
 * 4 MiB ở trần `SEGMENT.maxProjectBytes`, đo 336ms mỗi dòng (mục
 * `segment-cap-perf` của sổ đo) — nên 10 environment trả giá đó mười lần cho
 * cùng một chuỗi. Một câu `INSERT ... SELECT` trên `unnest(env_ids, versions)`
 * gửi payload đúng một lần và để Postgres nhân nó ra, vẫn đúng một dòng cho mỗi
 * `(environment_id, config_version)` như vòng lặp cũ.
 *
 * Payload KHÁC nhau thì vẫn một câu cho mỗi environment: gộp kiểu đó phải gửi N
 * payload trong một câu, tức trả đúng cái giá vừa tránh được.
 */
async function insertOutbox<T>(
  tx: Prisma.TransactionClient,
  write: OutboxWrite<T>,
  rows: readonly OutboxRow[],
): Promise<void> {
  const [first] = rows;
  if (
    first !== undefined &&
    rows.length > 1 &&
    rows.every((row) => row.payload === first.payload)
  ) {
    const inserted = await tx.$executeRaw`
      INSERT INTO config_change_log
             (environment_id, config_version, change_type, payload, actor_user_id)
      SELECT target.id::uuid, target.version, ${write.changeType},
             ${first.payload}::jsonb, ${write.actorUserId ?? null}::uuid
        FROM unnest(${rows.map((row) => row.environmentId)}::uuid[],
                    ${rows.map((row) => row.configVersion)}::int[])
             AS target(id, version)`;
    assertInserted(inserted, rows.length);
    return;
  }

  for (const { environmentId, configVersion, payload } of rows) {
    const inserted = await tx.$executeRaw`
      INSERT INTO config_change_log
             (environment_id, config_version, change_type, payload, actor_user_id)
      VALUES (${environmentId}::uuid, ${configVersion}, ${write.changeType},
              ${payload}::jsonb, ${write.actorUserId ?? null}::uuid)`;
    assertInserted(inserted, 1);
  }
}

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
   * [v4.9] Một lần sửa segment chạm MỌI environment của project — snapshot của
   * mỗi environment chứa mọi segment của project, không lọc theo tham chiếu
   * (`snapshot-row.ts`) — nên hai lần sửa đồng thời khoá cùng một tập hàng, và
   * tập đó là toàn bộ environment của project. Khoá theo thứ tự khác nhau là
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

    // ---- Bước 3: hash sau thay đổi, của TỪNG environment -------------------
    const rows: OutboxRow[] = [];
    for (const { environmentId, configVersion } of stamped) {
      const { configHash, delta } = await write.stateOf(tx, environmentId);

      await tx.environment.update({
        where: { id: environmentId },
        data: { configHash },
      });

      /**
       * Payload trùng nội dung giữ CÙNG MỘT chuỗi thay vì một bản sao.
       *
       * Bước 4 chỉ cần biết chúng có trùng nhau hay không, nên bản sao thứ hai
       * thành rác ngay tại đây và phép so ở bước 4 là so con trỏ. Nếu không:
       * mười environment ở trần `SEGMENT.maxProjectBytes` là 40 MiB chuỗi sống
       * cùng lúc trong lúc đang giữ khoá cả project, thay cho 4 MiB như vòng lặp
       * cũ — gộp bước 4 kiểu đó là đổi một hồi quy (lượt đi về) lấy một hồi quy
       * khác (bộ nhớ).
       */
      const payload = JSON.stringify(delta);
      const shared = rows[0]?.payload;
      rows.push({
        environmentId,
        configVersion,
        payload: payload === shared ? shared : payload,
      });
    }

    // ---- Bước 4: dòng outbox — ghi CUỐI CÙNG -------------------------------
    await insertOutbox(tx, write, rows);

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
