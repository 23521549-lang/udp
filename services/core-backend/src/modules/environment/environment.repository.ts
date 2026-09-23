import { Prisma, type SdkKeyType } from "@udp/db";
import { SDK_KEY } from "@udp/config";
import { prisma } from "../../core/db.js";
import type { ListSdkKeysQuery } from "./sdk-key.types.js";

/**
 * Đường ĐỌC của environment và SDK key ở Service 1 (§3.1) [v4.9].
 *
 * `udp_s1` chỉ có SELECT trên `sdk_keys` (I22, ma trận writer) — nên file này đọc,
 * còn mọi lần GHI đi qua Service 2. Đó không phải phân chia tuỳ ý: R25 (a) ghi lại
 * đúng cái bẫy là đặt đường ghi khoá ở đây, nhận `42501` lúc chạy, rồi "sửa" bằng
 * một lệnh GRANT làm đỏ I22.
 *
 * Đọc thì thẳng database, không qua Service 2: một trang danh sách khoá không cần
 * khoá gì, và thêm một hop nội bộ chỉ để "cho giống đường ghi" là trả giá mà không
 * mua gì (cùng lý lẽ đã chốt cho segment).
 */

export interface EnvironmentRef {
  id: string;
  /**
   * Tên environment — đầu vào của `envSlug` trong token (`udp_sk_{envSlug}_…`).
   *
   * Đây là lý do phép kiểm sở hữu trả về HÀNG chứ không trả `boolean`: bên phát
   * hành cần đúng cái tên này, và đọc nó bằng một truy vấn thứ hai là hai lần đi
   * về cho một câu hỏi, cộng một khe để hai lần đọc thấy hai tên khác nhau.
   */
  name: string;
}

/**
 * Environment này có thuộc project này không — chốt sở hữu của MỌI route khoá.
 *
 * `WHERE id = $env AND project_id = $project` trong CÙNG một câu, đúng khuôn
 * chống R05: `requireMinProjectRole("OWNER")` chỉ chứng minh người gọi là OWNER
 * của project TRÊN ĐƯỜNG DẪN, không chứng minh `:envId` thuộc project đó. Thiếu
 * bước này thì OWNER của project A phát hành được khoá SERVER cho environment của
 * project B chỉ bằng cách đổi một id trên URL — và khoá đó đọc được toàn bộ rule
 * và `userIds` của B qua `/sdk/config`.
 */
export async function findInProject(
  projectId: string,
  environmentId: string,
): Promise<EnvironmentRef | undefined> {
  const row = await prisma.environment.findFirst({
    where: { id: environmentId, projectId },
    select: { id: true, name: true },
  });
  return row ?? undefined;
}

export interface SdkKeyRow {
  id: string;
  environmentId: string;
  keyType: SdkKeyType;
  keySuffix: string;
  label: string | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdBy: { id: string; name: string };
}

/**
 * Các cột của một khoá trên dây — `key_hash` KHÔNG có mặt.
 *
 * `select` tường minh chứ không `include`: một `select` liệt kê từng cột là lời
 * khai rằng hash không được đọc ra khỏi database, và nó không thể "vô tình" thêm
 * cột mới khi schema thêm cột. Một `include` thì ngược lại — nó lấy tất cả, và
 * ngày ai đó thêm một cột bí mật thứ hai vào bảng này, cột đó tự đi lên Portal.
 */
const KEY_COLUMNS = {
  id: true,
  environmentId: true,
  keyType: true,
  keySuffix: true,
  label: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.SdkKeySelect;

/**
 * Khoá của một environment theo `status` (§3.1).
 *
 * Khoá SỐNG trước, rồi tối đa `SDK_KEY.revokedListLimit` khoá đã thu hồi mới
 * nhất. Hai truy vấn chứ không một `ORDER BY` khéo: trần chỉ áp cho nhóm đã thu
 * hồi (nhóm sống đã bị trần `maxActivePerEnvironment` chặn ở 20), và một `LIMIT`
 * chung sẽ cắt mất khoá đang dùng của một environment có nhiều khoá cũ — tức là
 * trang danh sách không hiện chính thứ người dùng vào đó để xem.
 *
 * Nhóm đã thu hồi sắp theo `revoked_at`, không theo `created_at`: câu hỏi của
 * người đọc là "gần đây đã thu hồi cái gì".
 */
export async function listKeys(
  environmentId: string,
  status: ListSdkKeysQuery["status"],
): Promise<SdkKeyRow[]> {
  const active =
    status === "revoked"
      ? []
      : await prisma.sdkKey.findMany({
          where: { environmentId, revokedAt: null },
          select: KEY_COLUMNS,
          orderBy: { createdAt: "desc" },
        });

  const revoked =
    status === "active"
      ? []
      : await prisma.sdkKey.findMany({
          where: { environmentId, revokedAt: { not: null } },
          select: KEY_COLUMNS,
          orderBy: { revokedAt: "desc" },
          take: SDK_KEY.revokedListLimit,
        });

  return [...active, ...revoked];
}

/**
 * Một khoá của ĐÚNG environment này — `undefined` cho mọi id lạ.
 *
 * `environmentId` nằm trong `WHERE` chứ không được so sau khi đọc: khoá của
 * environment khác (kể cả environment khác trong CÙNG project) phải ra 404 trước
 * khi Service 2 được gọi lần nào (I14, R05). Hàm này vì thế là cả phép kiểm sở
 * hữu của DELETE lẫn đường đọc lại view sau khi Service 2 commit.
 */
export async function keyInEnvironment(
  environmentId: string,
  keyId: string,
): Promise<SdkKeyRow | undefined> {
  const row = await prisma.sdkKey.findFirst({
    where: { id: keyId, environmentId },
    select: KEY_COLUMNS,
  });
  return row ?? undefined;
}
