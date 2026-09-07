/**
 * Danh mục 16 Domain Adapter (Design §5.5).
 *
 * ĐÂY LÀ SCAFFOLD TẠM THỜI. Theo §5.3 và bất biến I29, nguồn sự thật của bảng
 * `DomainCatalog` là **adapter registry**: mỗi service lúc khởi động quét thư mục
 * `modules/domain-adapter/*` bằng readdir + import() động, rồi UPSERT một hàng cho
 * mỗi adapter tìm thấy. Đó là điều kiện để chỉ số "0 file ngoài thư mục adapter"
 * của đóng góp C2 đúng: thêm domain mới không được đụng tới migration hay file này.
 *
 * Khi `domain-catalog.sync.ts` tồn tại, hằng số này chỉ còn dùng cho seed dev và
 * cho test cần một danh mục xác định; nó KHÔNG được trở thành đường ghi thứ hai
 * vào bảng `DomainCatalog`.
 *
 * `tier` phân loại theo §5.5, dùng để nhóm trên UI.
 * `defaultOrder` CHỈ để sắp xếp hiển thị và phá hòa trong cùng một bậc topo —
 * thứ tự deploy thật do đồ thị capability sinh ra (§5.3), không do cột này.
 */

export type DomainTier = "CORE" | "STANDARD" | "ADVANCED";

export interface DomainCatalogEntry {
  domainType: string;
  tier: DomainTier;
  displayName: string;
  defaultOrder: number;
}

export const DOMAIN_CATALOG_SEED: readonly DomainCatalogEntry[] = [
  // --- Tier 1: không có chúng thì không deploy được gì ---
  { domainType: "CONTAINER_REGISTRY", tier: "CORE", displayName: "Container Registry", defaultOrder: 10 },
  { domainType: "CICD", tier: "CORE", displayName: "CI/CD", defaultOrder: 20 },
  { domainType: "INFRA", tier: "CORE", displayName: "Infrastructure as Code", defaultOrder: 30 },

  // --- Tier 2: cần cho vận hành thật, và cho hai đóng góp C1 + C2 ---
  { domainType: "MONITORING", tier: "STANDARD", displayName: "Monitoring", defaultOrder: 40 },
  { domainType: "LOGGING", tier: "STANDARD", displayName: "Logging", defaultOrder: 50 },
  { domainType: "TRACING", tier: "STANDARD", displayName: "Tracing", defaultOrder: 60 },
  { domainType: "SERVICE_MESH", tier: "STANDARD", displayName: "Service Mesh", defaultOrder: 70 },
  /// Tách khỏi Service Mesh ở v4: mesh cho `mesh.traffic-split`, ingress cho
  /// `ingress.traffic-split`. Flagger và Argo Rollouts chấp nhận MỘT TRONG HAI
  /// (`anyOf`), nên gộp chung thì không biểu diễn được ràng buộc thật của chúng.
  { domainType: "INGRESS", tier: "STANDARD", displayName: "Ingress", defaultOrder: 80 },
  { domainType: "PROGRESSIVE_DELIVERY", tier: "STANDARD", displayName: "Progressive Delivery", defaultOrder: 90 },
  { domainType: "GITOPS", tier: "STANDARD", displayName: "GitOps", defaultOrder: 100 },
  { domainType: "SECRETS", tier: "STANDARD", displayName: "Secrets Management", defaultOrder: 110 },
  { domainType: "SECURITY", tier: "STANDARD", displayName: "Security Scanning", defaultOrder: 120 },
  { domainType: "POLICY", tier: "STANDARD", displayName: "Policy & Governance", defaultOrder: 130 },
  { domainType: "DATABASE", tier: "STANDARD", displayName: "Database Operators", defaultOrder: 140 },

  // --- Tier 3: hướng phát triển, chưa bắt buộc trong phạm vi khóa luận ---
  { domainType: "COST", tier: "ADVANCED", displayName: "Cost Management", defaultOrder: 150 },
  { domainType: "ARTIFACT_REGISTRY", tier: "ADVANCED", displayName: "Artifact & Package Registry", defaultOrder: 160 },
] as const;

/**
 * Kiểm tại thời điểm nạp module: đếm phải khớp con số mà §5.5 và §2.2 tuyên bố.
 * Thà sập lúc khởi động còn hơn để bảng `DomainCatalog` thiếu một hàng rồi phát
 * hiện bằng một khóa ngoại vỡ ở giữa luồng provisioning.
 */
const EXPECTED_DOMAIN_COUNT = 16;

if (DOMAIN_CATALOG_SEED.length !== EXPECTED_DOMAIN_COUNT) {
  throw new Error(
    `DOMAIN_CATALOG_SEED có ${DOMAIN_CATALOG_SEED.length} domain, thiết kế §5.5 nói ${EXPECTED_DOMAIN_COUNT}.`,
  );
}
