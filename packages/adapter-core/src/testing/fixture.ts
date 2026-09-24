import type { CreatedResourceKind } from "../cloud.js";
import type { CloudFixture } from "./index.js";

/**
 * [v4.10] Hằng số kỳ vọng — **viết tay**, không suy từ hiện thực.
 *
 * Đây là ràng buộc thứ tự thứ BA của plan, và nó không hồi phục được: file này phải
 * commit **trước** `steps` của adapter sim. Lý do là một tautology cổ điển — nếu số tài
 * nguyên mong đợi suy từ `adapter.networkSteps(...).length` thì một adapter khai **thiếu**
 * một step vẫn xanh, vì kỳ vọng tự co lại theo hiện thực. Viết tay trước thì "adapter
 * thiếu một step" là một test đỏ.
 *
 * `EXPECTED_STEP_COUNT` là một hằng số RIÊNG, không suy từ `FIXTURE_STEPS.length` ở chỗ
 * dùng: `CRASH_POINTS.length === 10` **không** chặn được việc fixture tụt từ 13 step
 * xuống 1, và khi đó lưới vẫn "10/10 xanh" trong khi nó chỉ còn 10 ô thay vì 130.
 */

/**
 * Mười ba step của một lần provision đầy đủ, theo đúng §3.1 và §4.2.
 *
 * Sáu step đầu là bước NETWORK, bảy step sau là bước CLUSTER. Tên ở đây cũng là khoá của
 * `prior` mà `create()` đọc (§4.2), nên đổi tên một step là đổi hợp đồng.
 */
export const FIXTURE_STEPS: readonly {
  name: string;
  kind: CreatedResourceKind;
  step: "NETWORK" | "CLUSTER";
  /** Step này đọc `prior[...]` của step nào */
  dependsOn?: string;
}[] = [
  { name: "vpc", kind: "vpc", step: "NETWORK" },
  { name: "subnet-a", kind: "subnet", step: "NETWORK", dependsOn: "vpc" },
  { name: "subnet-b", kind: "subnet", step: "NETWORK", dependsOn: "vpc" },
  { name: "igw", kind: "internet-gateway", step: "NETWORK", dependsOn: "vpc" },
  { name: "eip", kind: "elastic-ip", step: "NETWORK" },
  { name: "nat", kind: "nat-gateway", step: "NETWORK", dependsOn: "subnet-a" },
  {
    name: "rtb-public",
    kind: "route-table",
    step: "NETWORK",
    dependsOn: "vpc",
  },
  { name: "sg", kind: "security-group", step: "CLUSTER", dependsOn: "vpc" },
  { name: "iam-cluster", kind: "iam-role", step: "CLUSTER" },
  { name: "cluster", kind: "cluster", step: "CLUSTER", dependsOn: "vpc" },
  {
    name: "oidc",
    kind: "oidc-provider",
    step: "CLUSTER",
    dependsOn: "cluster",
  },
  {
    name: "nodegroup",
    kind: "nodegroup",
    step: "CLUSTER",
    dependsOn: "cluster",
  },
  { name: "addon-cni", kind: "addon", step: "CLUSTER", dependsOn: "cluster" },
];

/** Số step, viết tay. Xem chú thích đầu file về vì sao nó là hằng số riêng */
export const EXPECTED_STEP_COUNT = 13;

/** Tổng số tài nguyên một lần provision đầy đủ phải tạo */
export const EXPECTED_RESOURCE_COUNT = 13;

/**
 * Bảng `kind → số lượng`.
 *
 * Chỉ một tổng số thì bỏ một `subnet` và thêm một `addon` vẫn ra 13. Bảng này làm mỗi
 * step biến mất là một test đỏ chứ không phải một dòng diff.
 */
export const EXPECTED_BY_KIND: Readonly<
  Partial<Record<CreatedResourceKind, number>>
> = {
  vpc: 1,
  subnet: 2,
  "internet-gateway": 1,
  "elastic-ip": 1,
  "nat-gateway": 1,
  "route-table": 1,
  "security-group": 1,
  "iam-role": 1,
  cluster: 1,
  "oidc-provider": 1,
  nodegroup: 1,
  addon: 1,
};

/**
 * Hai biến thể nhất quán của lưới.
 *
 * `instant` là tagging API thấy ngay; `delayed` là cửa sổ lan truyền tag của một API nhất
 * quán cuối (S-12). Chiều này CHỈ áp cho những ô mà cửa sổ đó có nghĩa — K2, K3 và ô
 * `K2b` — vì với các ô khác nó nhân đôi thời gian mà không thêm tính chất nào.
 *
 * Nó là một hằng số ghim được vì nếu không, "bỏ biến thể `delayed`" là một dòng biến mất
 * trong diff chứ không phải một test đỏ.
 */
export const CONSISTENCY_VARIANTS: readonly {
  name: "instant" | "delayed";
  tagPropagationDelayMs: number;
}[] = [
  { name: "instant", tagPropagationDelayMs: 0 },
  { name: "delayed", tagPropagationDelayMs: 10_000 },
];

/** Gom lại thành hình `CloudFixture` mà bộ hợp đồng nhận */
export const CLOUD_FIXTURE: CloudFixture = {
  expectedResourceCount: EXPECTED_RESOURCE_COUNT,
  expectedByKind: EXPECTED_BY_KIND,
  expectedStepCount: EXPECTED_STEP_COUNT,
};

/**
 * Mười điểm crash của §4.5, với `tier` là **DỮ LIỆU**.
 *
 * Vì sao `tier` phải ở đây chứ không là một quy ước trong thân test: nói "ô ở tầng 1 của
 * K9/K10 không được đếm" là chưa đủ — một ô luôn xanh vẫn tồn tại trong bộ test và vẫn
 * cho cảm giác an toàn. Với `tier` là dữ liệu, một meta-test khẳng định được rằng mọi ô
 * `child-only` **không** chạy ở tầng 1 và **đã** chạy ở tầng 2.
 *
 * `child-only` là những ô mà tính chất cần khẳng định là tính chất của **sổ bền** hay của
 * **một tiến trình thật đã chết**, nên chạy chúng in-process với sổ trong bộ nhớ là một ô
 * rỗng nghĩa:
 *
 * - **K3**: cửa sổ giữa "cloud đã tạo xong" và "ta đã biết điều đó" — ô quyết định của C3.
 * - **K6**: thứ tự compensation dựng lại từ `networkSteps()`, không từ sổ; ở tầng 1 phải
 *   *mô phỏng* việc catch block không chạy, tức mô phỏng đúng cái cần chứng minh.
 * - **K9**: fencing theo `version` chỉ đúng nếu database cưỡng chế.
 * - **K10**: mất sạch sổ — không có sổ thật thì không có gì để mất.
 */
export const CRASH_POINTS: readonly {
  id: string;
  tier: "both" | "child-only";
  /** Pha của runner mà ô này giết */
  phase: string;
  why: string;
}[] = [
  {
    id: "K1",
    tier: "both",
    phase: "before-intend",
    why: "crash trước khi ghi sổ: không có hàng, lookup rồi create bình thường",
  },
  {
    id: "K2",
    tier: "both",
    phase: "after-intend",
    why: "đã ghi sổ, chưa gọi API: lookup theo tag không thấy thì create",
  },
  {
    id: "K3",
    tier: "child-only",
    phase: "after-create-commit",
    why: "API đã trả về nhưng chưa ghi provider_id — ô Terraform thua",
  },
  {
    id: "K4",
    tier: "both",
    phase: "before-wait-ready",
    why: "giữa create và waitReady: lookup xác nhận còn, gọi lại waitReady",
  },
  {
    id: "K5",
    tier: "both",
    phase: "after-wait-ready",
    why: "giữa các step: tiếp từ step kế tiếp, không làm lại việc đã xong",
  },
  {
    id: "K6",
    tier: "child-only",
    phase: "before-delete",
    why: "giữa compensation: thứ tự ngược dựng lại từ steps, không từ sổ",
  },
  {
    id: "K7",
    tier: "both",
    phase: "after-lookup",
    why: "khách xoá tài nguyên ngoài luồng: hội tụ về trạng thái mong muốn",
  },
  {
    id: "K8",
    tier: "both",
    phase: "before-lookup",
    why: "khách xoá tag udp.key: đường dự phòng theo provider_id",
  },
  {
    id: "K9",
    tier: "child-only",
    phase: "after-create-respond",
    why: "mất lease: worker cũ bị fencing chặn ở lần ghi kế tiếp",
  },
  {
    id: "K10",
    tier: "child-only",
    phase: "after-mark-created",
    why: "mất sạch sổ: rebuildLedgerFromCloud phải hội tụ được",
  },
];

/**
 * Hai biến thể của K10.
 *
 * `job_id` là NOT NULL với khoá ngoại Restrict, và ADR-08 nói nó là cột DUY NHẤT không
 * suy ra được từ tag. Nên "mất sạch sổ" có hai nghĩa khác nhau, và gộp chúng lại là bỏ
 * qua đúng chỗ khó:
 *
 * - **K10a**: chỉ mất `provisioned_resources`; job cũ còn, nối lại được.
 * - **K10b**: mất cả `provisioning_jobs`; phải tạo một job tổng hợp có **đánh dấu tường
 *   minh**, để lịch sử mất một cách NHÌN THẤY ĐƯỢC thay vì bị bịa.
 */
export const K10_VARIANTS: readonly { id: "K10a" | "K10b"; why: string }[] = [
  { id: "K10a", why: "chỉ mất sổ tài nguyên, job cũ còn để nối lại" },
  { id: "K10b", why: "mất cả bảng job, phải tạo job tổng hợp có đánh dấu" },
];
