/**
 * [v4.10] Capability model của Domain Adapter (§5.3) — ngữ nghĩa phụ thuộc của
 * package manager (Debian `Depends`/`Recommends`/`Conflicts`/`Provides`, RPM) áp
 * cho tổ hợp tooling của IDP. Đây là đóng góp C2.
 *
 * Vì sao ba kiểu này nằm ở `@udp/shared-types` mà `ResolvedCredential` thì không:
 * chú thích ở `index.ts` hoãn cả hai, nhưng với HAI LÝ DO KHÁC NHAU.
 * `ResolvedCredential` bị loại vì nó *có hành vi* (`dispose()`, bị cấm serialize),
 * nên một package "chỉ có type" sẽ làm mất hợp đồng đó. Ba kiểu dưới đây là dữ
 * liệu THUẦN và Portal cần chúng để dựng thông báo lỗi capability của §5.3, nên
 * chỗ đúng của chúng là package dùng chung.
 *
 * KHÔNG có Zod ở đây: `CapabilityDeclaration` do adapter khai trong mã, không đến
 * từ HTTP, nên nó được kiểm bằng type guard lúc registry nạp adapter (fail-fast
 * khi khởi động) chứ không bằng schema lúc chạy.
 */

/**
 * 14 capability của §5.3.
 *
 * Union viết tay, KHÔNG suy từ registry. Đây là một lựa chọn có giá và giá đó
 * được nêu tường minh: `pd-controller` dùng `"metrics.query"` ở tầng biên dịch,
 * nên suy union từ registry lúc chạy sẽ mất kiểm kiểu ở một service khác. Hệ quả
 * là chỉ số "0 file" của C2 phải báo HAI con số (§5.3, E1): thêm một tool vào
 * domain đã có là 0 file ngoài thư mục adapter; thêm một domain cần capability
 * CHƯA CÓ thì phải sửa đúng file này. Nói ra thì trung thực; im lặng thì không.
 */
export type CapabilityId =
  | "registry.oci"
  | "metrics.query"
  | "metrics.scrape"
  | "logs.sink"
  | "traces.sink"
  | "mesh.traffic-split"
  | "ingress.traffic-split"
  | "traffic.control"
  | "secrets.store"
  | "gitops.sync"
  | "policy.admission"
  | "pipeline.trigger"
  | "db.instance"
  | "cost.query"
  /** [v4.11, Plan #35] Kho package ngôn ngữ (npm, Maven, PyPI…) — Artifact & Package Registry */
  | "packages.store";

/** Đúng 15 giá trị của `CapabilityId`, cho type guard và cho test đối chiếu tài liệu */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  "registry.oci",
  "metrics.query",
  "metrics.scrape",
  "logs.sink",
  "traces.sink",
  "mesh.traffic-split",
  "ingress.traffic-split",
  "traffic.control",
  "secrets.store",
  "gitops.sync",
  "policy.admission",
  "pipeline.trigger",
  "db.instance",
  "cost.query",
  "packages.store",
];

/**
 * Một capability mà adapter CUNG CẤP.
 *
 * `exclusive` là cách v4 thay ma trận `conflicts` N×N: hai adapter cùng provide
 * một capability exclusive là xung đột, và điều đó TỰ ĐỐI XỨNG nên không ai phải
 * nhớ khai chiều ngược. `version` là semver đầy đủ vì consumer so bằng
 * `constraint` semver: `metrics.query` của Prometheus là PromQL còn của Datadog
 * là DQL, nên một con số không đủ để nói "tương thích".
 */
export interface CapabilityProvision {
  id: CapabilityId;
  /** semver ĐẦY ĐỦ (`"2.0.0"`), không phải `"2"`. Khai sai ⇒ service không khởi động */
  version: string;
  /**
   * Chỉ được có MỘT provider trong cluster.
   *
   * [v4.10] Phạm vi là CLUSTER, tuyệt đối: hai adapter namespace-scoped ở hai
   * environment khác nhau cùng provide một capability exclusive vẫn là xung đột.
   * Bản v4.9 để ngỏ điều này trong khi `CapabilityBinding.environmentId` cho phép
   * binding theo environment, nên resolver đúng ở test một environment và sai âm
   * thầm khi có environment thứ hai.
   */
  exclusive?: boolean;
}

/** Một ràng buộc cứng đơn lẻ: capability này phải có, và (nếu nêu) thoả `constraint` */
export interface CapabilityRequirement {
  id: CapabilityId;
  /** Khoảng semver (`"^2"`, `">=1"`). Khai sai ⇒ service không khởi động */
  constraint?: string;
}

/**
 * Nhóm any-of: cần ÍT NHẤT MỘT nhánh được thoả.
 *
 * Phải có từ hai nhánh: `anyOf` một phần tử là một `CapabilityRequirement` viết
 * dài dòng, còn `anyOf` rỗng làm `MISSING_ANY_OF` trả về danh sách rỗng và UI
 * hiện ra mấy cái nút trống. Type guard của registry chốt điều này.
 */
export interface CapabilityAnyOf {
  anyOf: CapabilityRequirement[];
}

export type CapabilityRequires = CapabilityRequirement | CapabilityAnyOf;

export const isAnyOf = (r: CapabilityRequires): r is CapabilityAnyOf =>
  "anyOf" in r;

/**
 * Khai báo tĩnh của một adapter, dùng cho validator ở §5.3.
 *
 * `requires` là ràng buộc CỨNG (thiếu ⇒ chặn), `recommends` là optional THẬT
 * (thiếu ⇒ chỉ cảnh báo). Bản v3 gom mọi optional thành một nhóm any-of duy nhất
 * nên một tool có hai optional độc lập (`logs.sink` và `traces.sink` đều "có thì
 * tốt") bị chặn sai.
 */
export interface CapabilityDeclaration {
  provides: CapabilityProvision[];
  requires: CapabilityRequires[];
  /** Thiếu chỉ cảnh báo `RECOMMENDED_MISSING`, không đổi thứ tự deploy */
  recommends?: CapabilityId[];
  /** Ngoại lệ tool-level theo `toolId`, hiếm dùng — ưu tiên `exclusive` */
  conflicts?: string[];
  /** Câu gợi ý hiển thị khi thiếu, để thông báo lỗi có hành động cụ thể */
  hint?: Partial<Record<CapabilityId, string>>;
}

/**
 * Giá trị THỰC TẾ sau khi adapter deploy xong — persist ở bảng `capability_bindings`.
 *
 * Nó là cache DỰNG LẠI ĐƯỢC, không phải nguồn sự thật (ADR-08): nguồn sự thật là
 * trạng thái thật trên cluster, và `detectDrift()` đối chiếu với nó.
 *
 * `environmentId` vắng nghĩa là cluster-scoped. Ràng buộc duy nhất của bảng là một
 * index BIỂU THỨC trên `(domain_config_id, capability_id, COALESCE(environment_id::text,''))`,
 * vì `NULL` trong UNIQUE thường không loại trừ nhau.
 */
export interface CapabilityBinding {
  id: CapabilityId;
  version: string;
  /** `"<domainType>:<toolId>"` viết thường, ví dụ `"monitoring:prometheus-grafana"` */
  providedBy: string;
  environmentId?: string;
  /** Ví dụ `"http://prometheus-server.udp-system:9090"` */
  endpoint?: string;
  attributes?: Record<string, string>;
}
