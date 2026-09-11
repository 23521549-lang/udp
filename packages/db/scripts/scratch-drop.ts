import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  assertScratchName,
  dropScratchDatabase,
} from "./helpers/scratch-database.js";

/**
 * Xoá một database scratch theo tên trong `UDP_SCRATCH_DB_NAME`.
 *
 *   UDP_SCRATCH_DB_NAME=udp_scratch_ci_123_1 pnpm --filter @udp/db scratch-drop
 *
 * Người dùng duy nhất hôm nay: bước `if: always()` cuối job `test` của CI.
 * Khi job bị huỷ giữa chừng (`cancel-in-progress`, hoặc runner chết), runner
 * gửi tín hiệu cho bash gốc của step rồi giết cả cây sau 10 giây — `finally`
 * của `test-scratch.ts` KHÔNG chạy, database ở lại trên Supabase. Bước dọn này
 * là lưới duy nhất cho ca đó, nên nó phải:
 *   - idempotent — sau một lượt thành công database đã bị xoá, chạy lại thoát 0;
 *   - từ chối mọi tên ngoài `SCRATCH_NAME_PATTERN` TRƯỚC khi nối, để một biến
 *     môi trường sai không bao giờ thành `DROP DATABASE postgres`.
 */

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

const name = process.env["UDP_SCRATCH_DB_NAME"];
if (name === undefined || name === "") {
  console.error(
    "UDP_SCRATCH_DB_NAME chưa được đặt — không biết xoá database nào.",
  );
  process.exit(1);
}
// Từ chối TRƯỚC khi nối, và in một câu thay vì stack trace: người đọc log CI
// cần biết tên nào bị từ chối và vì sao, không cần biết nó ném ở dòng nào.
try {
  assertScratchName(name);
} catch (err: unknown) {
  console.error((err as Error).message);
  process.exit(1);
}

const adminUrl = process.env["DATABASE_URL_DIRECT"];
if (!adminUrl) {
  console.error("DATABASE_URL_DIRECT chưa được đặt — cần quyền owner để DROP.");
  process.exit(1);
}

const outcome = await dropScratchDatabase(adminUrl, name);
console.log(
  outcome === "dropped"
    ? `Đã xoá ${name}.`
    : `${name} không tồn tại, không có gì để dọn.`,
);
