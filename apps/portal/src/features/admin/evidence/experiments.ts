/**
 * [Plan #56 QĐ-7] Sổ thí nghiệm của trang Bằng chứng — MỖI phép đo của §14 (`UDP_design.md`), cộng hai phép đo bổ
 * sung đã có tệp thô (I34, danh sách flag của Portal).
 *
 * Sổ là mã, không phải chữ: tên và "chứng minh điều gì" ở `evidence.messages.tsx` (hai ngôn ngữ). Một phép kiểm
 * (`tests/evidence.test.tsx`) giữ sổ khỏi trôi: tập mã E* bằng đúng bảng §14, mọi tiền tố tệp thô có trong sổ, mọi
 * mã sổ nợ khai ở đây là một mục có thật của `docs/measurements/kiem-chung-con-no.md`.
 */

/** Nhóm trên trang — theo "bản đồ phép đo theo đóng góp" của §14 */
export type EvidenceGroup = "C1" | "C2" | "C3" | "base" | "people" | "extra";

export const EVIDENCE_GROUPS: readonly EvidenceGroup[] = [
  "C1",
  "C2",
  "C3",
  "base",
  "people",
  "extra",
];

export type ExperimentId =
  | "E1"
  | "E2"
  | "E3"
  | "E4"
  | "E5"
  | "E6"
  | "E7"
  | "E8"
  | "E9"
  | "E10"
  | "E11"
  | "E12"
  | "E13"
  | "E14"
  | "E15"
  | "E16"
  | "I34"
  | "portal-pagination"
  | "kyverno-crd"
  | "chart-values";

export interface Experiment {
  id: ExperimentId;
  /** Nhóm hiện thẻ */
  group: EvidenceGroup;
  /** Mọi đóng góp phép đo này làm bằng chứng — E1 là C2 và (bổ trợ) C3 */
  supports: readonly ("C1" | "C2" | "C3")[];
  /** Cách có số: tệp thô trong repo, tính sống từ dữ liệu vận hành, hay cần người thật */
  source: "raw" | "live" | "people";
  /** Mã mục sổ nợ còn mở của CHÍNH phép đo này */
  debts: readonly string[];
}

export const EXPERIMENTS: readonly Experiment[] = [
  {
    id: "E5",
    group: "C1",
    supports: ["C1"],
    source: "raw",
    debts: ["E5", "service-level-cluster"],
  },
  { id: "E6", group: "C1", supports: ["C1"], source: "raw", debts: ["E6"] },
  {
    id: "E14",
    group: "C1",
    supports: ["C1"],
    source: "raw",
    debts: ["E14-prometheus"],
  },
  { id: "E1", group: "C2", supports: ["C2", "C3"], source: "raw", debts: [] },
  { id: "E8", group: "C2", supports: ["C2"], source: "raw", debts: [] },
  { id: "E15", group: "C3", supports: ["C3"], source: "raw", debts: ["E15"] },
  { id: "E16", group: "C3", supports: ["C3"], source: "raw", debts: ["E16"] },
  { id: "E2", group: "base", supports: [], source: "raw", debts: ["E2"] },
  {
    id: "E3",
    group: "base",
    supports: [],
    source: "raw",
    debts: ["E3-quiet", "E3-stats"],
  },
  {
    id: "E4",
    group: "base",
    supports: [],
    source: "raw",
    debts: ["E4-ci", "E4-segment"],
  },
  { id: "E7", group: "base", supports: [], source: "raw", debts: [] },
  { id: "E9", group: "base", supports: [], source: "raw", debts: ["E9"] },
  {
    id: "E10",
    group: "base",
    supports: [],
    source: "live",
    debts: ["cicd-webhook-real"],
  },
  {
    id: "E11",
    group: "people",
    supports: [],
    source: "people",
    debts: ["portal-dx"],
  },
  {
    id: "E12",
    group: "people",
    supports: [],
    source: "people",
    debts: ["portal-dx"],
  },
  {
    id: "E13",
    group: "people",
    supports: [],
    source: "people",
    debts: ["portal-dx"],
  },
  {
    id: "I34",
    group: "extra",
    supports: [],
    source: "raw",
    debts: ["I34-cluster"],
  },
  {
    id: "portal-pagination",
    group: "extra",
    supports: [],
    source: "raw",
    debts: ["portal-pagination"],
  },
  /**
   * [Plan #61 61d-3b] Policy admission sinh ra có hợp lệ theo CRD THẬT của Kyverno không — bằng chứng của C2 (lớp
   * nền adapter sinh ra đối tượng đúng hình), và nửa "hành vi lúc chạy" là một món nợ có tên.
   */
  {
    id: "kyverno-crd",
    group: "C2",
    supports: ["C2"],
    source: "raw",
    debts: ["kyverno-admission-real"],
  },
  /**
   * [Plan #61 61d-3c] Khoá `values` mà adapter đặt có tồn tại trong chart không. Không có mục sổ nợ: phép đo ĐÃ
   * chạy, chỉ phủ 29% vì cấu hình hợp lệ của từng adapter nằm trong `contract.test.ts` và không export — giới hạn
   * đó ghi ở §16, không phải một món nợ hạ tầng.
   */
  {
    id: "chart-values",
    group: "C2",
    supports: ["C2"],
    source: "raw",
    debts: [],
  },
];

/** Trạng thái hiện trên thẻ (QĐ-1) — suy từ sổ và từ việc CÓ tệp thô hay không, không khai tay */
export type EvidenceStatus =
  "measured" | "partial" | "live" | "pending" | "people";

export function statusOf(
  experiment: Experiment,
  hasRawFile: boolean,
): EvidenceStatus {
  if (experiment.source === "live") return "live";
  if (experiment.source === "people") return "people";
  if (!hasRawFile) return "pending";
  return experiment.debts.length > 0 ? "partial" : "measured";
}

/** Phép đo của §14 (không tính hai phép đo bổ sung) */
export const isDesignExperiment = (e: Experiment): boolean =>
  /^E\d+$/.test(e.id);
