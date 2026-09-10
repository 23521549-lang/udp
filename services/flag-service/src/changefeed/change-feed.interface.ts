import type { Prisma, PrismaClient } from "@udp/db";

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

export interface ChangeFeed {
  /**
   * TẦNG 1 — version và hash thật của nhiều environment, trong MỘT truy vấn.
   *
   * Một truy vấn cho tất cả chứ không phải một truy vấn mỗi environment. Đã đo:
   * hai cách tốn như nhau cho MỘT environment (51.6ms so với 51.8ms, vì chi phí
   * là RTT chứ không phải công việc), nên cách thứ hai tốn gấp N lần mà không
   * đổi lại gì. Với pool 5 khe và chu kỳ 500ms, N truy vấn mỗi vòng làm cạn pool
   * ở khoảng N = 48 environment — và cái cạn cùng pool đó là đường ghi
   * `/internal/flags`, vốn ném `P2024` mà bảng ánh xạ lỗi chưa biết, tức là 500.
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
   */
  deltasSince(
    environmentId: string,
    cursor: number,
    limit: number,
  ): Promise<ChangeRecord[]>;
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

    deltasSince(environmentId, cursor, limit) {
      return client.configChangeLog.findMany({
        where: { environmentId, configVersion: { gt: cursor } },
        orderBy: { configVersion: "asc" },
        take: limit,
        select: { configVersion: true, changeType: true, payload: true },
      });
    },
  };
}
