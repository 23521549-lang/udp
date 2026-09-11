import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  assertScratchIdentity,
  maskForGitHub,
  measureRoundTripMs,
  scratchEnv,
  scratchNameFromEnv,
  step,
  withScratchDatabase,
} from "./helpers/scratch-database.js";

/**
 * TOÀN BỘ bộ test của workspace trên một database dùng-một-lần.
 *
 *   pnpm test:scratch
 *
 * Đây là đúng lệnh CI chạy. Khác `pnpm test` (chạy trên database dev đang dùng,
 * nhanh, cho vòng lặp phát triển) ở ba điểm: database được dựng từ số 0 bằng
 * chuỗi migration trong kho mã rồi seed, không có dữ liệu nào của dev bị test
 * chạm vào, và database bị xoá khi xong dù kết quả ra sao.
 *
 * Khác `db:verify-chain` ở chỗ nó cần CHUỖI THẬT của ba role (`DATABASE_URL_S1`,
 * `_S2`, `_S2_DIRECT`): test của hai service nối bằng role của chính mình theo
 * §1.2 và chốt `current_user` lúc boot. Role là cấp cluster nên chuỗi role của
 * môi trường đang dùng nối thẳng vào database scratch được (đã đo qua cả hai
 * pooler); GRANT cấp database thì migration dựng lại bên trong nó.
 *
 * Tên database: `UDP_SCRATCH_DB_NAME` nếu có (CI đặt tất định để bước dọn biết
 * tên), không thì `udp_scratch_<thời điểm>`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DB_PKG = resolve(here, "..");
const ROOT = resolve(here, "../../..");
loadDotenv({ path: resolve(ROOT, ".env") });

/**
 * Bắt buộc TRƯỚC khi tạo database, và KHÔNG fallback về owner như `verify-chain`.
 *
 * Fallback ở đây làm `boot-identity` của hai service đỏ với thông báo "role
 * postgres nhưng phải là udp_s2" — cách xa nguyên nhân thật là thiếu secret.
 * Thà liệt kê đúng tên biến thiếu ngay ở đây.
 */
const notifyEnabled = process.env["CHANGEFEED_NOTIFY_ENABLED"] !== "false";
const required = [
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "DATABASE_URL_S1",
  "DATABASE_URL_S2",
  ...(notifyEnabled ? ["DATABASE_URL_S2_DIRECT"] : []),
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(
    `Thiếu biến môi trường: ${missing.join(", ")}.\n` +
      `Bộ test đầy đủ cần chuỗi thật của ba role (pnpm db:service-login, ` +
      `pnpm db:service-login udp_s2); DATABASE_URL_S2_DIRECT chỉ cần khi ` +
      `CHANGEFEED_NOTIFY_ENABLED không phải "false".`,
  );
  process.exit(1);
}

const adminUrl = process.env["DATABASE_URL_DIRECT"] ?? "";
const scratch = scratchNameFromEnv("udp_scratch");
const childEnv = scratchEnv(process.env, scratch);

// Phải in TRƯỚC mọi bước con: từ đây trở đi bất cứ thứ gì in chuỗi dẫn xuất ra
// stdout/stderr đều được GitHub che.
const maskedLines = maskForGitHub(childEnv);
if (maskedLines > 0)
  console.log(`Đã che ${String(maskedLines)} giá trị trong log.`);

const rtt = await measureRoundTripMs(adminUrl);
console.log(`Round trip tới database: ${rtt.toFixed(1)}ms (trung vị 5 mẫu)`);

try {
  await withScratchDatabase(adminUrl, scratch, async () => {
    await assertScratchIdentity(childEnv, scratch);
    console.log("Mọi chuỗi kết nối đã trỏ đúng database scratch và đúng role.");

    step(
      "1/3 áp toàn bộ migration lên database TRỐNG",
      "prisma",
      ["migrate", "deploy"],
      DB_PKG,
      childEnv,
    );
    step("2/3 seed", "tsx", ["prisma/seed.ts"], DB_PKG, childEnv);
    /**
     * `--no-bail` khác root `pnpm test` có chủ đích: mặc định pnpm dừng cấp lịch
     * ngay khi một gói đỏ, nên một lỗi ở `@udp/db` làm CI câm về 249 test của hai
     * service (đã đo). Ở đây cần thấy TOÀN BỘ bức tranh; mã thoát vẫn là 1.
     */
    step(
      "3/3 toàn bộ test (pnpm -r --no-bail --if-present test)",
      "pnpm",
      ["-r", "--no-bail", "--if-present", "test"],
      ROOT,
      childEnv,
    );
  });
} catch {
  console.error("\nBộ test đầy đủ KHÔNG xanh trên database scratch.");
  process.exit(1);
}

console.log("\nBộ test đầy đủ xanh trên database scratch.");
