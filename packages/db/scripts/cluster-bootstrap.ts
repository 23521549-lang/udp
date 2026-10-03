import { Client } from "pg";

/**
 * Bật LOGIN và đặt mật khẩu cho ba role service trong một cluster UDP (job `udp-migrate`, Plan #49).
 *
 * Khác `service-login.ts`: mật khẩu KHÔNG sinh ở đây mà tới từ Secret `udp-secrets` của cluster — cùng
 * Secret mà S1/S2/S3 đọc chuỗi kết nối của chính mình, nên hai phía không bao giờ lệch nhau. Chạy lại
 * là đặt lại đúng mật khẩu đó (idempotent); xoay mật khẩu = đổi Secret rồi chạy lại job.
 *
 * Quyền: chuỗi owner `DATABASE_URL_DIRECT` (cần CREATEROLE — owner của database trong cluster có).
 */

const ROLES = {
  udp_s1: "UDP_S1_DB_PASSWORD",
  udp_s2: "UDP_S2_DB_PASSWORD",
  udp_s3: "UDP_S3_DB_PASSWORD",
} as const;

/** Mật khẩu ngắn hơn thế này là Secret sinh hỏng — dừng thay vì đặt một mật khẩu yếu */
const MIN_PASSWORD_LENGTH = 24;

const adminUrl = process.env["DATABASE_URL_DIRECT"];
if (adminUrl === undefined || adminUrl === "") {
  console.error(
    "DATABASE_URL_DIRECT chưa được đặt — job cần quyền owner để ALTER ROLE.",
  );
  process.exit(1);
}

const passwords = Object.entries(ROLES).map(([role, variable]) => {
  const password = process.env[variable] ?? "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `${variable} thiếu hoặc ngắn hơn ${String(MIN_PASSWORD_LENGTH)} ký tự`,
    );
    process.exit(1);
  }
  return { role, password };
});

const client = new Client({ connectionString: adminUrl });
await client.connect();
try {
  for (const { role, password } of passwords) {
    // Tên role là hằng của tệp này; mật khẩu thoát bằng escapeLiteral — ALTER ROLE không nhận tham số
    await client.query(
      `ALTER ROLE ${role} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`,
    );
    console.info(`${role}: đã bật LOGIN`);
  }
} finally {
  await client.end();
}
