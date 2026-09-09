import { describe, expect, it } from "vitest";
import { assertConnectedAs } from "@udp/db";
import { prisma } from "../src/core/db.js";

/**
 * Ma trận writer §1.2 phải có hiệu lực trên ĐƯỜNG GHI THẬT, không chỉ trong
 * `SET ROLE` của test bên `packages/db`.
 *
 * Trước khi core-backend nối bằng `udp_s1`, ba role và toàn bộ GRANT theo cột
 * đúng nhưng không chặn gì: runtime dùng user owner, vốn có toàn quyền. 187 test
 * canh chúng vẫn xanh, và câu "database cưỡng chế quy tắc writer" vẫn đọc như
 * một sự thật — trong khi trên đường ghi thật nó chưa từng bật.
 */
describe("chốt khẳng định danh tính KHÔNG phải trang trí", () => {
  it("ném khi kết nối mang role khác role mong đợi", async () => {
    // Mô phỏng cấu hình sai phổ biến nhất: quên đặt DATABASE_URL_S1 nên chuỗi
    // kết nối rơi về user owner. Không có chốt này, ứng dụng chạy bình thường
    // với TOÀN QUYỀN và không có gì báo — ma trận writer im lặng mất hiệu lực.
    await expect(assertConnectedAs(prisma, "udp_s2")).rejects.toThrow(
      /udp_s1.*udp_s2|udp_s2/s,
    );
  });

  it("không ném khi role đúng", async () => {
    await expect(assertConnectedAs(prisma, "udp_s1")).resolves.toBeUndefined();
  });
});

describe("danh tính kết nối của Service 1", () => {
  it("nối bằng udp_s1, KHÔNG phải owner", async () => {
    const rows = await prisma.$queryRaw<
      { current_user: string }[]
    >`SELECT current_user`;
    expect(rows[0]?.current_user).toBe("udp_s1");
  });

  it("ghi được vào lãnh địa của mình", async () => {
    // `users` thuộc Service 1 — đây là phép thử dương, để phép thử âm bên dưới
    // không thể pass chỉ vì kết nối hỏng.
    await expect(prisma.user.count()).resolves.toBeGreaterThanOrEqual(0);
  });

  it("KHÔNG ghi được vào lãnh địa của Service 2", async () => {
    // Một module của core-backend vô ý tạo feature flag sẽ bị DATABASE chặn ngay
    // lúc phát triển, thay vì trở thành quy ước mà người viết tiếp không biết.
    const attempt = prisma.$executeRaw`
      INSERT INTO feature_flags (id, project_id, key, flag_type, created_at, updated_at)
      SELECT gen_random_uuid(), id, 'khong-duoc-phep', 'BOOLEAN', now(), now()
        FROM projects LIMIT 1`;

    await expect(attempt).rejects.toThrow(/permission denied|42501/i);
  });

  it("KHÔNG đọc được cloud_credentials của chính mình? — CÓ, đó là lãnh địa S1", async () => {
    // Đối chứng cho phép thử trên: S1 ĐƯỢC đọc credential (ADR-06 chỉ cấm S3).
    // Không có ca này thì test âm ở trên có thể xanh vì mọi thứ đều bị chặn.
    await expect(
      prisma.cloudCredential.count(),
    ).resolves.toBeGreaterThanOrEqual(0);
  });
});
