import type { PrismaClient } from "./generated/prisma/client.js";

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
  const rows = await client.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
  const actual = rows[0]?.current_user;

  if (actual !== expectedRole) {
    throw new Error(
      `Kết nối database đang dùng role "${actual ?? "(không đọc được)"}" nhưng service này ` +
        `phải chạy bằng "${expectedRole}". Ma trận writer §1.2 chỉ có hiệu lực khi mỗi ` +
        `service nối bằng role của riêng nó — chạy \`pnpm db:service-login\` rồi đặt chuỗi ` +
        `kết nối tương ứng vào .env.`,
    );
  }
}
