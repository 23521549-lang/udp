import { STALE_FLAG_THRESHOLDS } from "@udp/config";
import { daysBefore, hourFloor, hoursAfter } from "@udp/shared-types";

/**
 * [v4.9] Cửa sổ của chốt archive (§3.4, §6.7) — hai công thức, MỘT nơi.
 *
 * `flag.service` dùng chúng để chặn ACTIVE → ARCHIVED và để viết câu `detail` của
 * 409 `FLAG_RECENTLY_EVALUATED`; `stats.service` dùng ĐÚNG hai công thức đó để
 * dựng khối `archive` có cấu trúc mà Portal đọc trước khi mở hộp thoại archive
 * (V10). Hai bản chép sẽ cho người dùng một con số trên màn hình và một con số
 * khác trong thông báo lỗi.
 */

export const ARCHIVE_GUARD_DAYS = STALE_FLAG_THRESHOLDS.archiveGuardDays;

/**
 * Biên dưới của cửa sổ: neo vào ĐẦU GIỜ chứa `asOf`, không vào chính `asOf`.
 *
 * `bucket_hour` là đầu giờ, nên neo vào một mốc giữa giờ sẽ cắt mất chính bucket
 * của giờ cách đây đúng 7 ngày — biên "asOf − 7d" của D1.2 nói về bucket, không
 * về phút giây.
 */
export const archiveGuardSince = (asOf: Date): Date =>
  daysBefore(hourFloor(asOf), ARCHIVE_GUARD_DAYS);

/**
 * Mốc sớm nhất chốt hết hiệu lực nếu từ giờ không còn lượt nào.
 *
 * Bucket cuối rời khỏi cửa sổ khi `hourFloor(asOf) − 7 ngày > lastBucket`, tức từ
 * `lastBucket + 7 ngày + 1 giờ` trở đi.
 */
export const archivableAfter = (lastEvaluatedAt: Date): Date =>
  hoursAfter(lastEvaluatedAt, ARCHIVE_GUARD_DAYS * 24 + 1);
