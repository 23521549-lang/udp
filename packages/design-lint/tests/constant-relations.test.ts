import {
  CHANGE_FEED,
  CONDITION_LIMITS,
  SDK_STATS,
  SEGMENT,
  STALE_FLAG_THRESHOLDS,
} from "@udp/config/constants";
import { describe, expect, it } from "vitest";

/**
 * Vài con số ở `@udp/config/constants` không độc lập với nhau: chúng được chọn
 * theo một QUAN HỆ, và quan hệ đó là thứ giữ cho hệ thống đúng — không phải giá
 * trị cụ thể.
 *
 * Chú thích ở constants đã giải thích từng quan hệ (92 = `maxDays` + 2; 8 MiB =
 * 2 × trần segment; …). Nhưng một quan hệ chỉ sống trong chú thích thì vỡ theo
 * cách xấu nhất: ai đó chỉnh MỘT số vì một lý do đúng ở chỗ khác, mọi test vẫn
 * xanh, và thứ hỏng là một kết luận — cửa sổ 90 ngày đếm thiếu ở đầu, một cảnh
 * báo stale không bao giờ nổ, một segment hợp lệ không lưu được. Đây đúng hình
 * dạng của "Tổng cuối: 40 bất biến" ở `references.test.ts`: một câu đúng lúc viết,
 * sai lặng lẽ về sau.
 *
 * Mỗi `it` dưới đây kiểm MỘT quan hệ và nêu hệ quả của việc nó vỡ. Không có test
 * nào ghim giá trị tuyệt đối: đổi 92 thành 120 là quyền của người vận hành, đổi nó
 * xuống 80 khi `maxDays` vẫn là 90 thì không.
 */

describe("quan hệ giữa các hằng số (§2.2, §6.3, §6.7)", () => {
  it("cửa sổ truy vấn dài nhất vẫn nằm TRONG phần dữ liệu hàng giờ", () => {
    /**
     * Rollup gộp hàng GIỜ cũ hơn `hourlyDays` thành hàng NGÀY. Một truy vấn
     * `granularity=hour` chỉ được phép tới `maxHourlyDays`, nhưng cửa sổ NGÀY tới
     * `maxDays` cũng phải cộng từ hàng giờ ở phần đầu của nó khi múi giờ dương:
     * `+14 h` làm ngày địa phương đầu tiên bắt đầu sớm hơn mốc `maxDays` UTC.
     * Chặt hơn `>=` một bậc (`+ 1 <`) vì lý do đó — đúng QA C-07.
     *
     * Vỡ thì không ai thấy lỗi: phần đầu cửa sổ đã bị gộp, `GET …/stats` trả số
     * NHỎ HƠN thật, và `UNUSED` gọi một flag còn sống là đã chết.
     */
    expect(SDK_STATS.query.maxDays + 1).toBeLessThan(
      SDK_STATS.retention.hourlyDays,
    );
    expect(SDK_STATS.query.maxHourlyDays).toBeLessThanOrEqual(
      SDK_STATS.query.maxDays,
    );
  });

  it("dữ liệu hàng giờ giữ đủ lâu để chốt UNUSED có cái mà đọc", () => {
    /**
     * `UNUSED` hỏi "có lượt nào trong `unusedDays` không". Nếu retention ngắn hơn
     * ngưỡng đó thì câu trả lời luôn là "không" cho mọi flag — cảnh báo dương tính
     * giả trên TOÀN BỘ danh sách, tức là cảnh báo bị người dùng tắt.
     */
    expect(SDK_STATS.retention.hourlyDays).toBeGreaterThan(
      STALE_FLAG_THRESHOLDS.unusedDays,
    );
  });

  it("ngân sách delta đủ cho một lần sửa segment ở TRẦN", () => {
    /**
     * Một lần sửa segment ghi payload đầy đủ vào outbox của mọi environment
     * (§16). Ngân sách của MỘT lô delta phải lớn hơn nội dung lớn nhất mà một lần
     * ghi hợp lệ sinh ra, nếu không thì mọi lần sửa segment lớn đều rơi về
     * snapshot và tầng 2 thành vô dụng đúng ở chỗ nó đáng giá nhất.
     *
     * Hệ số 2 là dư địa cho `jsonb::text` (dài hơn canonical khoảng 1 byte mỗi
     * phần tử) cộng phần flag đi kèm trong cùng lô.
     */
    expect(CHANGE_FEED.maxDeltaBytes).toBeGreaterThanOrEqual(
      2 * SEGMENT.maxProjectBytes,
    );
  });

  it("một segment ASCII ở trần userIds luôn lưu được vào project trống", () => {
    /**
     * Hai trần độc lập nhìn cùng một dữ liệu: `userIdsMax` × `userIdMaxLength` là
     * trần của MỘT segment (schema zod), còn `maxProjectBytes` là trần TỔNG của
     * project. Nếu trần tổng nhỏ hơn một segment hợp lệ duy nhất thì có một body
     * qua được schema mà không bao giờ lưu được — 422 cho một request đúng theo
     * mọi thứ đã đặc tả, và không ai đọc tài liệu mà đoán ra được.
     *
     * `+ 3` cho mỗi id là hai dấu nháy kép và một dấu phẩy khi jsonb in ra.
     */
    expect(SEGMENT.maxProjectBytes).toBeGreaterThanOrEqual(
      CONDITION_LIMITS.userIdsMax * (CONDITION_LIMITS.userIdMaxLength + 3),
    );
  });

  it("parser nội bộ của S2 rộng hơn trần body ghi của S1", () => {
    /**
     * Service 1 serialize lại body rồi thêm `projectId` trước khi gọi
     * `/internal/segments`, nên thân đi tới Service 2 LỚN HƠN thân nó nhận. Bằng
     * nhau cũng không đủ.
     *
     * Vỡ thì lỗi hiện ra ở chỗ sai nhất: một body sát trần qua S1 nhận 413 từ S2,
     * mà S1 không relay 413 (§8.4), nên người dùng thấy 500 cho một request hợp lệ.
     */
    expect(SEGMENT.internalBodyLimitBytes).toBeGreaterThan(
      SEGMENT.writeBodyLimitBytes,
    );
  });
});
