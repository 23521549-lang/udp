import type { PrismaClient } from "@udp/db";

/**
 * Chủ của project fixture — user CŨ NHẤT, không phải "một user bất kỳ".
 *
 * `findFirst` không `orderBy` trả hàng theo thứ tự vật lý mà Postgres đang giữ,
 * và thứ tự đó không được bảo đảm. `pnpm -r test` chạy core-backend SONG SONG
 * với flag-service trên cùng một database, và core-backend tạo user tạm rồi dọn
 * chúng cùng mọi thứ gắn với chúng khi xong. Nhặt nhầm đúng user tạm ấy làm chủ
 * thì project fixture của file này biến mất giữa chừng — đã thấy đúng hình dạng
 * đó: 65/65 test xanh, rồi `afterAll` nhận `P2025` vì project không còn để xoá.
 *
 * User cũ nhất là user của seed: được tạo trước mọi test, và không test nào
 * dọn nó. `findFirstOrThrow` thì ném rõ ràng nếu database chưa có user nào —
 * tức là seed chưa chạy — thay vì để test hỏng ở một chỗ khó hiểu hơn.
 */
export function stableOwner(admin: PrismaClient): Promise<{ id: string }> {
  return admin.user.findFirstOrThrow({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
}
