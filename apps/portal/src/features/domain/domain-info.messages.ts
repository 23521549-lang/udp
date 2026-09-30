import { defineMessages } from "../../i18n";

/**
 * [Plan #58 UX-7, UX-14] Tên hiển thị và công dụng của 16 domain — một nguồn cho mọi màn (trang chủ, wizard, trang
 * Domain, nhật ký job, Bảng điều khiển) thay vì in mã `GITOPS`. Tên giữ đúng `displayName` của catalog; câu công dụng
 * viết bằng lời thường cho người chưa quen hạ tầng.
 */

export const DOMAIN_TYPES = [
  "CONTAINER_REGISTRY",
  "CICD",
  "INFRA",
  "MONITORING",
  "LOGGING",
  "TRACING",
  "SERVICE_MESH",
  "INGRESS",
  "PROGRESSIVE_DELIVERY",
  "GITOPS",
  "SECRETS",
  "SECURITY",
  "POLICY",
  "DATABASE",
  "COST",
  "ARTIFACT_REGISTRY",
] as const;
export type KnownDomainType = (typeof DOMAIN_TYPES)[number];

/** Nhóm theo VIỆC người dùng cần làm (thay cho bậc Cốt lõi/Tiêu chuẩn/Nâng cao) */
export const DOMAIN_GROUPS = {
  ship: [
    "CICD",
    "CONTAINER_REGISTRY",
    "ARTIFACT_REGISTRY",
    "GITOPS",
    "PROGRESSIVE_DELIVERY",
  ],
  run: ["INGRESS", "SERVICE_MESH", "DATABASE", "SECRETS"],
  observe: ["MONITORING", "LOGGING", "TRACING"],
  govern: ["SECURITY", "POLICY", "COST", "INFRA"],
} as const satisfies Record<string, readonly KnownDomainType[]>;
export type DomainGroup = keyof typeof DOMAIN_GROUPS;

/** Gói khởi đầu cho người mới: đủ để build, lưu image và thấy số đo — thêm dần sau */
export const STARTER_DOMAINS: readonly KnownDomainType[] = [
  "CICD",
  "CONTAINER_REGISTRY",
  "MONITORING",
];

export const domainInfoMessages = defineMessages({
  vi: {
    name: {
      CONTAINER_REGISTRY: "Container Registry",
      CICD: "CI/CD",
      INFRA: "Infrastructure as Code",
      MONITORING: "Monitoring",
      LOGGING: "Logging",
      TRACING: "Tracing",
      SERVICE_MESH: "Service Mesh",
      INGRESS: "Ingress",
      PROGRESSIVE_DELIVERY: "Progressive Delivery",
      GITOPS: "GitOps",
      SECRETS: "Secrets Management",
      SECURITY: "Security Scanning",
      POLICY: "Policy & Governance",
      DATABASE: "Database Operators",
      COST: "Cost Management",
      ARTIFACT_REGISTRY: "Artifact & Package Registry",
    } satisfies Record<KnownDomainType, string>,
    purpose: {
      CONTAINER_REGISTRY:
        "Nơi lưu image container của ứng dụng để cluster kéo về chạy.",
      CICD: "Tự build, test và đóng image mỗi lần bạn push code.",
      INFRA: "Mô tả hạ tầng bằng mã để dựng lại giống hệt khi cần.",
      MONITORING:
        "Thu số đo request, lỗi, độ trễ để vẽ biểu đồ và tự lùi bản lỗi.",
      LOGGING: "Gom log của mọi pod về một chỗ để tìm lỗi.",
      TRACING: "Theo một request đi qua nhiều service để thấy chỗ chậm.",
      SERVICE_MESH:
        "Mã hoá và điều phối lưu lượng giữa các service, chia theo phần trăm.",
      INGRESS: "Cửa vào từ Internet: nhận HTTPS và chuyển tới đúng service.",
      PROGRESSIVE_DELIVERY:
        "Phát hành bản mới từng phần trăm, tự lùi lại khi số đo xấu.",
      GITOPS: "Giữ cluster luôn khớp với cấu hình trong Git.",
      SECRETS:
        "Giữ mật khẩu, khoá API ngoài mã nguồn và đưa vào ứng dụng an toàn.",
      SECURITY: "Quét image và cấu hình tìm lỗ hổng trước khi chạy.",
      POLICY:
        "Chặn cấu hình vi phạm quy tắc của bạn, ví dụ chạy bằng quyền root.",
      DATABASE:
        "Chạy và quản lý database ngay trong cluster: PostgreSQL, Redis…",
      COST: "Tính chi phí theo environment và theo workload.",
      ARTIFACT_REGISTRY:
        "Lưu gói thư viện và bản build không phải image: npm, Maven…",
    } satisfies Record<KnownDomainType, string>,
    group: {
      ship: "Build và giao hàng",
      run: "Chạy ứng dụng",
      observe: "Quan sát",
      govern: "An toàn, chi phí, hạ tầng",
    } satisfies Record<DomainGroup, string>,
  },
  en: {
    name: {
      CONTAINER_REGISTRY: "Container Registry",
      CICD: "CI/CD",
      INFRA: "Infrastructure as Code",
      MONITORING: "Monitoring",
      LOGGING: "Logging",
      TRACING: "Tracing",
      SERVICE_MESH: "Service Mesh",
      INGRESS: "Ingress",
      PROGRESSIVE_DELIVERY: "Progressive Delivery",
      GITOPS: "GitOps",
      SECRETS: "Secrets Management",
      SECURITY: "Security Scanning",
      POLICY: "Policy & Governance",
      DATABASE: "Database Operators",
      COST: "Cost Management",
      ARTIFACT_REGISTRY: "Artifact & Package Registry",
    },
    purpose: {
      CONTAINER_REGISTRY:
        "Stores your app's container images so the cluster can pull them.",
      CICD: "Builds, tests and packages an image every time you push code.",
      INFRA: "Describes infrastructure as code so you can rebuild it exactly.",
      MONITORING:
        "Collects request, error and latency metrics for charts and automatic rollback.",
      LOGGING: "Gathers logs from every pod in one place for troubleshooting.",
      TRACING: "Follows a request across services to find where it slows down.",
      SERVICE_MESH:
        "Encrypts and routes traffic between services, including percentage splits.",
      INGRESS:
        "The entry from the Internet: receives HTTPS and routes it to the right service.",
      PROGRESSIVE_DELIVERY:
        "Releases a new version a percentage at a time and rolls back when metrics look bad.",
      GITOPS: "Keeps the cluster matching the configuration in Git.",
      SECRETS:
        "Keeps passwords and API keys out of code and delivers them safely.",
      SECURITY:
        "Scans images and configuration for vulnerabilities before they run.",
      POLICY:
        "Blocks configuration that breaks your rules, such as running as root.",
      DATABASE:
        "Runs and manages databases inside the cluster: PostgreSQL, Redis…",
      COST: "Breaks down cost by environment and by workload.",
      ARTIFACT_REGISTRY:
        "Stores packages and non-image build artifacts: npm, Maven…",
    },
    group: {
      ship: "Build and ship",
      run: "Run the app",
      observe: "Observe",
      govern: "Safety, cost, infrastructure",
    },
  },
});
