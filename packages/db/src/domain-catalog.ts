import type { PrismaClient } from "./generated/prisma/client.js";
import type { DomainTier } from "./generated/prisma/enums.js";

/**
 * Đồng bộ `domain_catalog` — UPSERT, và KHÔNG BAO GIỜ `DELETE`.
 *
 * `domain_catalog.domain_type` là **khoá ngoại** của `domain_configs`, nên xoá một hàng
 * catalog mà project nào đó còn bật domain đó là một lỗi khoá ngoại lúc chạy — hoặc, nếu
 * ai đó "sửa" bằng `onDelete: Cascade`, là xoá im lặng cấu hình domain của khách.
 *
 * Nên một domain bị gỡ khỏi bản khai chỉ được **đánh dấu** `is_available = false`:
 *
 *  - Project đang bật nó vẫn chạy, vẫn đọc được cấu hình cũ.
 *  - Portal không cho project MỚI bật nó.
 *  - Dữ liệu lịch sử còn nguyên để người vận hành biết vì sao một project có một domain
 *    không còn trong danh mục.
 *
 * Đây là cùng một lối với `ProvisionedResource` (§4.5): trạng thái đi tới một giá trị nói
 * "đã ngừng", không đi tới chỗ không tồn tại.
 *
 * **CHẠY BẰNG DANH TÍNH OWNER, không phải role service.** Ma trận writer §1.2 chỉ cho ba
 * service `SELECT ON domain_catalog`; `udp_s1` gọi hàm này nhận `42501 permission denied`.
 * Đó không phải một thiếu sót cần cấp thêm quyền — nó là ranh giới đúng: catalog là dữ
 * liệu NỀN TẢNG (16 domain của §5.5), không phải dữ liệu tenant, nên nó thuộc đường
 * migration/seed chứ không thuộc đường xử lý request.
 */

export interface DeclaredDomain {
  domainType: string;
  /**
   * `CORE | STANDARD | ADVANCED` — bậc HIỂN THỊ của domain trong catalog.
   *
   * **Đừng lẫn với Heavy/Light của §5.1.** Hai trục khác nhau cùng mang chữ "tier":
   *
   *  - `DomainTier` ở đây nói domain này thuộc nhóm nào trong danh mục người dùng thấy.
   *  - Heavy/Light ở §5.1 nói ADAPTER của domain đó có logic riêng hoàn toàn hay dùng
   *    chung một chuẩn mở — một tính chất của mã, không của danh mục.
   *
   * Viết ra vì bản đầu của tệp này khai `"HEAVY" | "LIGHT"` và `tsc` bắt được; nếu hai
   * enum tình cờ có cùng tập giá trị thì nó sẽ không bắt được, và một domain sẽ nằm sai
   * nhóm trên Portal mà không ai thấy.
   */
  tier: DomainTier;
  displayName: string;
  defaultOrder: number;
}

export interface SyncOutcome {
  /** Số hàng thêm mới hoặc cập nhật */
  upserted: number;
  /** `domain_type` bị đánh dấu không còn dùng được */
  markedUnavailable: string[];
  /** `domain_type` được bật lại (đã có trong bảng nhưng đang `false`) */
  reEnabled: string[];
}

export async function syncDomainCatalog(
  prisma: PrismaClient,
  declared: readonly DeclaredDomain[],
): Promise<SyncOutcome> {
  if (declared.length === 0) {
    /**
     * Bản khai RỖNG là một lỗi, không phải một lệnh tắt hết.
     *
     * Đường tới đây thường không phải ý muốn của ai: một lần đọc cấu hình thất bại trả về
     * mảng rỗng, và một hàm "làm theo bản khai" sẽ tắt cả 16 domain của mọi project. Ném
     * ở đây đổi một sự cố toàn hệ thống thành một lần khởi động thất bại.
     */
    throw new Error(
      "bản khai domain rỗng — từ chối đồng bộ, vì nó sẽ tắt mọi domain",
    );
  }

  const existing = await prisma.domainCatalog.findMany({
    select: { domainType: true, isAvailable: true },
  });
  const existingMap = new Map(
    existing.map((r) => [r.domainType, r.isAvailable]),
  );
  const declaredTypes = new Set(declared.map((d) => d.domainType));

  const reEnabled: string[] = [];
  for (const d of declared) {
    const was = existingMap.get(d.domainType);
    if (was === false) reEnabled.push(d.domainType);
    await prisma.domainCatalog.upsert({
      where: { domainType: d.domainType },
      create: {
        domainType: d.domainType,
        tier: d.tier,
        displayName: d.displayName,
        defaultOrder: d.defaultOrder,
        isAvailable: true,
      },
      update: {
        tier: d.tier,
        displayName: d.displayName,
        defaultOrder: d.defaultOrder,
        isAvailable: true,
      },
    });
  }

  const gone = existing
    .filter((r) => !declaredTypes.has(r.domainType) && r.isAvailable)
    .map((r) => r.domainType);
  if (gone.length > 0) {
    await prisma.domainCatalog.updateMany({
      where: { domainType: { in: gone } },
      data: { isAvailable: false },
    });
  }

  return {
    upserted: declared.length,
    markedUnavailable: gone.sort(),
    reEnabled: reEnabled.sort(),
  };
}
