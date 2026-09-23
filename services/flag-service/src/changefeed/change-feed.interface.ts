import { Prisma, type PrismaClient } from "@udp/db";
import { z } from "zod";

/**
 * Đường ĐỌC của ADR-05, tách khỏi nơi dữ liệu thực sự nằm.
 *
 * §16 ghi một nhược điểm phải chấp nhận: độ trễ 500ms khi không có `NOTIFY`,
 * đổi lấy khả năng triển khai sau mọi pooler, và đường lùi là "thay `ChangeFeed`
 * bằng Redis Streams khi E9 cho thấy cần". Lời hứa đó chỉ giữ được nếu hôm nay
 * đã có một hợp đồng để thay — nếu watcher và poller gọi thẳng Prisma thì thay
 * là viết lại cả hai, và không ai đo E9 xong rồi mới đi làm việc đó.
 *
 * Hai phép đọc, đúng bằng hai tầng:
 *
 *   - `statesOf` là TẦNG 1 — nguồn sự thật, luôn bật, không thể sai.
 *   - `deltasSince` là TẦNG 2 — đường nhanh, yêu cầu liên tục.
 *
 * Tầng 3 (`NOTIFY`) KHÔNG có mặt ở đây, và đó là chủ đích: ADR-05 khai nó là
 * "ĐÁNH THỨC vòng poll, không mang dữ liệu". Một bộ đánh thức không phải một
 * đường đọc, nên nó thuộc về vòng lặp chứ không thuộc hợp đồng này.
 */

export interface EnvironmentState {
  configVersion: number;
  /**
   * Chuỗi RỖNG là hợp lệ và có nghĩa: `Environment.config_hash` khai
   * `@default("")`, nên mọi environment chưa từng bị ghi đều mang giá trị đó.
   * Đo trên database thật: 6/6 environment hiện có đang ở trạng thái này. Coi nó
   * như một hash để so là lệch 100%, ba lần liên tiếp là ngắt mạch, rồi lặp mãi
   * — một sự cố hoàn toàn tự gây ra. Người đọc phải xử lý ca này.
   */
  configHash: string;
}

export interface ChangeRecord {
  configVersion: number;
  changeType: string;
  payload: Prisma.JsonValue;
}

/**
 * [v4.9] Lô delta vượt ngân sách byte (V22) — KHÔNG phải lỗi.
 *
 * Tách khỏi `ChangeRecord[]` bằng một giá trị riêng chứ không bằng mảng rỗng: mảng
 * rỗng đã có nghĩa "không còn dòng nào sau con trỏ", và trộn hai thứ đó lại thì
 * poller kết luận "đã đuổi kịp" trong khi còn nguyên một lô chưa đọc.
 */
export const TOO_LARGE = "too-large";
export type DeltaBatch = ChangeRecord[] | typeof TOO_LARGE;

export interface ChangeFeed {
  /**
   * TẦNG 1 — version và hash thật của nhiều environment, trong MỘT truy vấn.
   *
   * Một truy vấn cho tất cả chứ không phải một truy vấn mỗi environment. Đã đo:
   * hai cách tốn như nhau cho MỘT environment (51.6ms so với 51.8ms, vì chi phí
   * là RTT chứ không phải công việc), nên cách thứ hai tốn gấp N lần mà không
   * đổi lại gì. Với pool 5 khe và chu kỳ 500ms, N truy vấn mỗi vòng làm cạn pool
   * ở khoảng N = 48 environment — và cái cạn cùng pool đó là đường ghi
   * `/internal/flags`: `$transaction` hết `maxWait` sẽ ném `P2028` và người ghi nhận 503.
   */
  statesOf(
    environmentIds: readonly string[],
  ): Promise<Map<string, EnvironmentState>>;

  /**
   * TẦNG 2 — các delta NGAY SAU con trỏ, theo thứ tự version tăng dần.
   *
   * `environmentId` là điều kiện BẮT BUỘC, không phải bộ lọc tuỳ chọn:
   * `config_version` chỉ liên tục TRONG một environment. Thiếu nó thì version
   * của các environment khác nhau xen kẽ và phép kiểm "liên tục" hỏng ở gần như
   * mọi dòng — trong khi triệu chứng chỉ là "tầng 2 không bao giờ dùng được".
   *
   * [v4.9] `maxBytes` là ngân sách byte của CẢ LÔ (V22), và nó được cưỡng chế
   * TRONG câu lệnh chứ không ở JS: một dòng `segment.updated` mang tới 4 MiB
   * (V21), nên "đọc 100 dòng về rồi mới đo" là đúng cái phải tránh — hàng trăm
   * MB đi qua dây database trước khi ta kết luận là quá lớn. Vượt ngân sách ⇒
   * `TOO_LARGE`, và người gọi rơi về snapshot (có trần nên luôn rẻ hơn).
   */
  deltasSince(
    environmentId: string,
    cursor: number,
    limit: number,
    maxBytes: number,
  ): Promise<DeltaBatch>;
}

/**
 * Hiện thực trên Postgres — bảng `config_change_log` chính là feed.
 *
 * ADR-05 gọi đây là "đúng nhờ trạng thái bền vững": một hàng trong bảng replay
 * được, sống qua restart, và đi qua mọi pooler. Redis Streams sẽ là một hiện
 * thực KHÁC của cùng hợp đồng trên, không phải một sửa đổi của cái này.
 */
export function postgresChangeFeed(client: PrismaClient): ChangeFeed {
  return {
    async statesOf(environmentIds) {
      const rows = await client.environment.findMany({
        where: { id: { in: [...environmentIds] } },
        select: { id: true, configVersion: true, configHash: true },
      });

      return new Map(
        rows.map((r) => [
          r.id,
          { configVersion: r.configVersion, configHash: r.configHash },
        ]),
      );
    },

    async deltasSince(environmentId, cursor, limit, maxBytes) {
      const rows = await client.$queryRaw<unknown[]>(
        deltasSql(environmentId, cursor, limit, maxBytes),
      );
      const batch = deltaRowsSchema.parse(rows);

      /**
       * Tổng lũy kế không giảm (`octet_length` không âm), nên dòng CUỐI trả lời
       * cho cả lô: nó vượt ngân sách thì lô vượt.
       */
      if (batch.at(-1)?.overBudget === true) return TOO_LARGE;

      return batch.map((r) => ({
        configVersion: r.configVersion,
        changeType: r.changeType,
        payload: r.payload as Prisma.JsonValue,
      }));
    },
  };
}

/**
 * MỘT câu lệnh, hai tầng, và cả hai tầng đều cần thiết (V22).
 *
 * Tầng trong `LIMIT` số dòng NGAY SAU con trỏ — đúng phép đọc cũ của
 * `findMany`. Tầng ngoài cộng dồn `octet_length(payload::text)` bằng window
 * function theo cùng thứ tự version, rồi CHỈ trả `payload` của những dòng còn
 * trong ngân sách. Dòng đầu tiên làm tràn ngân sách vì thế không đi qua dây, và
 * `overBudget` là một `boolean` chứ không phải tổng: tổng là `bigint`, mà
 * `node-postgres` trả `bigint` dưới dạng chuỗi (R7 V3) — so sánh ở SQL thì không
 * có chỗ nào cho lỗi ép kiểu.
 *
 * `coalesce(octet_length(...), 0)`: cột `payload` nhận cả `'null'::jsonb`, và
 * `octet_length(NULL)` là NULL, thứ sẽ làm mọi tổng lũy kế sau nó thành NULL.
 */
const deltasSql = (
  environmentId: string,
  cursor: number,
  limit: number,
  maxBytes: number,
): Prisma.Sql => Prisma.sql`
  /* udp:deltas */
  SELECT
    t."configVersion",
    t."changeType",
    CASE WHEN t."overBudget" THEN NULL ELSE t.payload END AS payload,
    t."overBudget"
  FROM (
    SELECT
      r.config_version AS "configVersion",
      r.change_type    AS "changeType",
      r.payload,
      SUM(COALESCE(OCTET_LENGTH(r.payload::text), 0))
        OVER (ORDER BY r.config_version) > ${maxBytes}::bigint AS "overBudget"
    FROM (
      SELECT config_version, change_type, payload
        FROM config_change_log
       WHERE environment_id = ${environmentId}::uuid
         AND config_version > ${cursor}
       ORDER BY config_version
       LIMIT ${limit}
    ) r
  ) t
  ORDER BY t."configVersion"
`;

const deltaRowsSchema = z.array(
  z.object({
    configVersion: z.number().int(),
    changeType: z.string(),
    payload: z.unknown(),
    overBudget: z.boolean(),
  }),
);
