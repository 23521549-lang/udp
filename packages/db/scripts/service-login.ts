import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { Client } from "pg";
import { DB_TLS_OPTIONS, sanitizeConnectionString } from "../src/adapter.js";

/**
 * Cấp quyền đăng nhập cho một service role và ghi chuỗi kết nối vào `.env`.
 *
 * Vì sao là SCRIPT chứ không phải migration: mật khẩu không được nằm trong git.
 * Migration là file được commit và chạy ở mọi môi trường, nên một
 * `ALTER ROLE … PASSWORD 'x'` trong đó là đưa credential vào lịch sử kho mã
 * vĩnh viễn.
 *
 *   pnpm db:service-login                    # udp_s1, ghi thẳng vào .env
 *   pnpm db:service-login udp_s2             # role khác — udp_s2 ghi HAI chuỗi (DIRECT_VAR)
 *   pnpm db:service-login -- --print         # in ra thay vì ghi (xem cảnh báo dưới)
 *   pnpm db:service-login -- --template=<url> [--template-direct=<url>] --env-file=<path>
 *
 * Các cờ khuôn dành cho lúc đích đến là một database tạm không có trong `.env`
 * (bản đầu của `db:verify-chain` từng gọi script này — nay thì không, xem chú thích
 * ở đó), và chúng tồn tại vì một lý do cụ thể:
 * bản trước lấy chuỗi ADMIN từ `DATABASE_URL_DIRECT` nhưng lấy KHUÔN của chuỗi
 * sinh ra từ `DATABASE_URL` — hai biến khác nguồn. Trỏ `DATABASE_URL_DIRECT`
 * sang một database tạm trong khi `.env` vẫn còn `DATABASE_URL` của Supabase
 * sẽ: đổi mật khẩu role trên database TẠM, rồi ghi đè `DATABASE_URL_S1` thật
 * bằng chuỗi SUPABASE mang mật khẩu mới. Mật khẩu Supabase cũ không bao giờ
 * được in ra, nên nó mất vĩnh viễn. Xem thêm khẳng định về host bên dưới.
 *
 * Chạy lại bao giờ cũng sinh mật khẩu MỚI và thu hồi mật khẩu cũ — đó cũng là
 * cách xoay credential khi cần.
 */

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

/** Đọc cờ dạng `--ten=gia-tri`. Chỉ nhận dạng có dấu `=` cho khỏi nhập nhằng. */
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/**
 * Đường ĐỌC cấu hình và đường GHI kết quả là hai thứ khác nhau.
 *
 * Luôn đọc `.env` của repo để lấy `DATABASE_URL_DIRECT`, nhưng ghi ra nơi khác
 * khi được yêu cầu. Nhập hai đường này làm một chính là lý do một lần chạy tạm
 * có thể phá hỏng cấu hình đang dùng.
 */
const repoEnv = resolve(here, "../../../.env");
loadDotenv({ path: repoEnv });
const outPath = flag("env-file") ?? repoEnv;

const VALID_ROLES = new Set(["udp_s1", "udp_s2", "udp_s3"]);
const role = args.find((a) => !a.startsWith("--")) ?? "udp_s1";

if (!VALID_ROLES.has(role)) {
  console.error(
    `Role không hợp lệ: ${role}. Chỉ nhận: ${[...VALID_ROLES].join(", ")}`,
  );
  process.exit(1);
}

const adminUrl = process.env["DATABASE_URL_DIRECT"];
if (!adminUrl) {
  console.error(
    "DATABASE_URL_DIRECT chưa được đặt — script này cần quyền owner để ALTER ROLE.",
  );
  process.exit(1);
}

// base64url: không ký tự nào cần escape trong chuỗi kết nối hay trong SQL.
const password = randomBytes(24).toString("base64url");

/**
 * Khuôn của chuỗi sẽ sinh ra.
 *
 * Mặc định lấy `DATABASE_URL` (pooled) vì runtime của service nối qua pooler,
 * còn script này cần quyền owner nên phải nối session mode. Hai chuỗi khác
 * cổng là đúng — nhưng KHÁC HOST thì không bao giờ đúng, và đó chính là kịch
 * bản phá hỏng credential mô tả ở đầu file. Nên khẳng định thay vì tin.
 *
 * `--template=<url>` bỏ qua toàn bộ chuyện này: người gọi nói thẳng chuỗi nào
 * là khuôn, dùng khi đích đến là một database tạm không có trong `.env`.
 */
const explicitTemplate = flag("template");
const url = new URL(
  sanitizeConnectionString(
    explicitTemplate ?? process.env["DATABASE_URL"] ?? adminUrl,
  ),
);

if (explicitTemplate === undefined) {
  const adminHost = new URL(sanitizeConnectionString(adminUrl)).hostname;
  if (url.hostname !== adminHost) {
    console.error(
      `DATABASE_URL trỏ tới "${url.hostname}" nhưng DATABASE_URL_DIRECT trỏ tới ` +
        `"${adminHost}". Cấp LOGIN trên máy chủ này rồi ghi chuỗi kết nối của máy chủ ` +
        `kia là cách chắc chắn nhất để mất credential đang dùng. Dùng --template=<url> ` +
        `nếu bạn thật sự muốn chỉ định khuôn khác.`,
    );
    process.exit(1);
  }
}

/**
 * Role nào có thêm chuỗi SESSION MODE của riêng nó — kênh LISTEN của tầng 3.
 *
 * Hai chuỗi của cùng một role PHẢI sinh trong CÙNG một lần chạy: mật khẩu vừa xoay
 * chỉ tồn tại ở lần chạy này, nên ghi một chuỗi rồi để chuỗi kia giữ mật khẩu cũ là
 * để kênh nghe hỏng xác thực ở lần khởi động kế tiếp.
 */
const DIRECT_VAR: Readonly<Partial<Record<string, string>>> = {
  udp_s2: "DATABASE_URL_S2_DIRECT",
};
const directVar = DIRECT_VAR[role];
const explicitDirectTemplate = flag("template-direct");

/**
 * Có khuôn pooled tường minh mà thiếu khuôn session thì chuỗi session sẽ lấy khuôn
 * từ `DATABASE_URL_DIRECT` thật trong khi chuỗi kia trỏ nơi khác — hai chuỗi của
 * cùng một role trỏ hai database. Từ chối TRƯỚC khi xoay mật khẩu.
 */
if (
  directVar !== undefined &&
  explicitTemplate !== undefined &&
  explicitDirectTemplate === undefined
) {
  console.error(
    `${role} cần HAI chuỗi (pooled và session). Có --template thì phải kèm ` +
      `--template-direct=<url session>, nếu không ${directVar} sẽ trỏ về .env thật.`,
  );
  process.exit(1);
}

const admin = new Client({
  connectionString: sanitizeConnectionString(adminUrl),
  ssl: DB_TLS_OPTIONS,
});
await admin.connect();

/**
 * ALTER ROLE là utility statement — Postgres KHÔNG nhận tham số ở đây, nên
 * mật khẩu buộc phải nội suy. Đã đo: truyền qua $1 cho lỗi cú pháp.
 *
 * An toàn nhờ hai điều, và cả hai đều được khẳng định chứ không giả định: tên
 * role đã qua danh sách trắng ở trên, và mật khẩu do chính script sinh bằng
 * base64url nên chỉ chứa [A-Za-z0-9_-]. Kiểm lại tập ký tự ngay trước khi nối —
 * nếu ai đó đổi cách sinh mật khẩu, chỗ này phải gãy chứ không được im lặng.
 */
if (!/^[A-Za-z0-9_-]+$/.test(password)) {
  throw new Error(
    "Mật khẩu chứa ký tự ngoài base64url — không được nội suy vào SQL",
  );
}
await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`);
await admin.end();

/**
 * Pooler của Supabase định tuyến theo tenant bằng phần sau dấu chấm của username
 * (`<role>.<project-ref>`). Đã đo: `udp_s1.<ref>` nối được và `current_user`
 * đúng là `udp_s1`, còn `udp_s1` trần bị từ chối với "no tenant identifier".
 */
const withRole = (template: URL): string => {
  const u = new URL(template.toString());
  const ref = u.username.includes(".") ? u.username.split(".")[1] : undefined;
  u.username = ref === undefined ? role : `${role}.${ref}`;
  u.password = password;
  return u.toString();
};

const entries: [name: string, value: string][] = [
  [`DATABASE_URL_${role.slice(-2).toUpperCase()}`, withRole(url)],
];
if (directVar !== undefined) {
  entries.push([
    directVar,
    withRole(
      new URL(sanitizeConnectionString(explicitDirectTemplate ?? adminUrl)),
    ),
  ]);
}
const lines = entries.map(([name, value]) => `${name}="${value}"`);

/**
 * Mặc định GHI vào `.env`, không in ra.
 *
 * Mật khẩu in ra stdout sẽ nằm lại trong lịch sử terminal, trong log CI, và
 * trong bất cứ transcript nào ghi phiên làm việc. `--print` chỉ dành cho lúc
 * thật sự phải dán tay sang nơi khác.
 */
if (args.includes("--print")) {
  console.log(`\nĐã cấp LOGIN cho ${role}. Dán vào .env:\n`);
  console.log(`${lines.join("\n")}\n`);
} else {
  let next = readFileSync(outPath, "utf8");
  const eol = next.includes("\r\n") ? "\r\n" : "\n";

  for (const line of lines) {
    const name = line.slice(0, line.indexOf("="));
    /**
     * `^TÊN=` — dấu `=` ngay sau tên, nên `DATABASE_URL_S2` không khớp nhầm dòng
     * `DATABASE_URL_S2_DIRECT`. Thay bằng HÀM chứ không bằng chuỗi: chuỗi thay thế
     * của `replace` hiểu `$&`, `$1`… như mẫu đặc biệt.
     */
    const pattern = new RegExp(`^${name}=.*$`, "m");
    next = pattern.test(next)
      ? next.replace(pattern, () => line)
      : `${next.trimEnd()}${eol}${eol}${line}${eol}`;
  }

  writeFileSync(outPath, next.replace(/\r?\n/g, eol), "utf8");
  console.log(
    `\nĐã cấp LOGIN cho ${role} và ghi ${entries.map(([n]) => n).join(", ")} vào ${outPath}.`,
  );
  console.log("Mật khẩu KHÔNG được in ra — chạy lại script này để xoay.\n");
  /**
   * Đã gặp (Plan #13): lần nối ngay sau khi xoay bị `28P01 password authentication
   * failed`, vài phút sau thì nối được với đúng chuỗi đó — pooler giữ mật khẩu cũ
   * một lúc. Báo trước để người chạy không đi sửa một thứ không hỏng.
   */
  console.log(
    "Pooler có thể mất một lúc mới nhận mật khẩu mới — 28P01 ngay sau khi xoay thì đợi rồi thử lại.\n",
  );
}
