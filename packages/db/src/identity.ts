import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * Lỗi danh tính kết nối — class riêng để catch ở boot phân biệt được với
 * mọi lỗi kết nối khác (TLS, DNS, timeout, pool cạn...).
 *
 * Vì sao không kiểm `instanceof PrismaClientKnownRequestError` ở phía gọi:
 * lỗi kết nối có nhiều lớp (`UnknownRequestError`, timeout của pg-pool…),
 * liệt kê từng lớp là bỏ lọt dần theo thời gian. Nhận diện tích cực phía
 * danh tính thì mọi lỗi còn lại — hiện tại và tương lai — đều đúng nhãn.
 */
export class DbIdentityMismatchError extends Error {}

/**
 * Câu log boot khi `assertServiceIdentity()` ném — gọi đúng tên lỗi.
 *
 * Chuỗi message giữ nguyên từng chữ: `boot-identity.test.ts` của 3 service
 * ghim chúng bằng `toContain`.
 */
export function describeBootFailure(err: unknown): string {
  const reason =
    err instanceof DbIdentityMismatchError
      ? "danh tính kết nối database sai"
      : "không kết nối được database";
  return `Không khởi động: ${reason}`;
}

/**
 * Khẳng định service đang nối bằng ĐÚNG role của nó.
 *
 * Không có bước này, ma trận writer §1.2 hỏng theo cách im lặng nhất có thể:
 * quên đặt `DATABASE_URL_S1`, hoặc chuỗi kết nối rơi về user owner, thì mọi
 * GRANT theo cột trở nên vô nghĩa — owner có toàn quyền — nhưng ứng dụng chạy
 * bình thường, test vẫn xanh (chúng dùng `SET ROLE` riêng), và không có gì báo.
 * Hệ thống chỉ *trông như* được cưỡng chế.
 *
 * Gọi lúc khởi động và để nó ném. Sập lúc boot với một câu rõ ràng rẻ hơn nhiều
 * so với việc phát hiện sau vài tháng rằng lớp phòng vệ chưa từng bật.
 */
export async function assertConnectedAs(
  client: PrismaClient,
  expectedRole: string,
): Promise<void> {
  const rows = await client.$queryRaw<
    { current_user: string }[]
  >`SELECT current_user`;
  const actual = rows[0]?.current_user;

  if (actual !== expectedRole) {
    throw new DbIdentityMismatchError(
      `Kết nối database đang dùng role "${actual ?? "(không đọc được)"}" nhưng service này ` +
        `phải chạy bằng "${expectedRole}". Ma trận writer §1.2 chỉ có hiệu lực khi mỗi ` +
        `service nối bằng role của riêng nó — chạy \`pnpm db:service-login\` rồi đặt chuỗi ` +
        `kết nối tương ứng vào .env.`,
    );
  }
}
