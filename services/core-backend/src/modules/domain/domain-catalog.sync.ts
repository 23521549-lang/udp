import type { PrismaClient } from "@udp/db";
// `syncDomainCatalog` sống ở `@udp/db` để script migrate (danh tính owner) dùng chung;
// file này chỉ giữ phần kiểm (assert) chạy bằng danh tính service lúc boot.
import type { DomainAdapterRegistry } from "./domain-adapter.registry.js";

export class RegistryCatalogMismatchError extends Error {
  readonly code = "REGISTRY_CATALOG_MISMATCH";
  constructor(readonly problems: readonly string[]) {
    super(`registry và catalog lệch nhau:\n  ${problems.join("\n  ")}`);
    this.name = "RegistryCatalogMismatchError";
  }
}

export interface CoverageOptions {
  /**
   * Khoá adapter được bỏ qua — dành cho adapter FIXTURE của test.
   *
   * Nó là một tham số tường minh chứ không phải một cờ trên `DomainAdapter`, và đó là chủ
   * đích: interface `DomainAdapter` bị **đóng băng ở 7 phương thức + 6 thuộc tính** (cổng
   * P18), nên thêm một `isFixture` vào đó là nới interface vì lý do của test. Ngoài ra,
   * cây adapter của sản phẩm là `src/modules/*-adapter/`, còn fixture nằm dưới `tests/`,
   * nên registry sản phẩm **không bao giờ thấy** chúng — danh sách này chỉ cần cho những
   * test tự trỏ registry vào cây fixture.
   */
  ignoreKeys?: readonly string[];
}

/**
 * Mọi adapter đã nạp phải có `domainType` CÓ THẬT và ĐANG dùng được trong catalog.
 *
 * Hai nguồn độc lập: registry đọc từ **thư mục**, catalog đọc từ **database**. Kiểm chúng
 * khớp nhau là cách bắt ba lỗi mà không nguồn nào một mình thấy được:
 *
 *  - Một adapter khai `domainType` viết sai (`MONITERING`) — nó nạp được, hiện lên Portal,
 *    và vỡ ở lần ghi `domain_configs` đầu tiên vì khoá ngoại.
 *  - Một domain bị `is_available = false` nhưng adapter của nó vẫn còn trong cây — Portal
 *    không cho bật, mà mã vẫn nghĩ nó dùng được.
 *  - Seed database thiếu một domain mà cây adapter đã có.
 */
export async function assertRegistryCoveredByCatalog(
  prisma: PrismaClient,
  registry: DomainAdapterRegistry,
  options: CoverageOptions = {},
): Promise<void> {
  const ignore = new Set(options.ignoreKeys ?? []);
  const catalog = await prisma.domainCatalog.findMany({
    select: { domainType: true, isAvailable: true },
  });
  const byType = new Map(catalog.map((r) => [r.domainType, r.isAvailable]));

  const problems: string[] = [];
  for (const { key, adapter, at } of registry.all()) {
    if (ignore.has(key)) continue;
    const available = byType.get(adapter.domainType);
    if (available === undefined) {
      problems.push(
        `${key} (${at}) khai domainType "${adapter.domainType}" không có trong catalog`,
      );
      continue;
    }
    if (!available) {
      problems.push(
        `${key} khai domainType "${adapter.domainType}" đang is_available = false`,
      );
    }
  }
  if (problems.length > 0) throw new RegistryCatalogMismatchError(problems);
}
