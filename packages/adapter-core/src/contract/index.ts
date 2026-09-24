import type { CloudAdapter } from "../cloud.js";
import type { Ledger } from "../runner/index.js";
import type { CloudControl, CloudFixture } from "../testing/index.js";

/**
 * [v4.10] Bộ test hợp đồng dưới dạng **DỮ LIỆU** (§13.2).
 *
 * `runCloudAdapterContract` chỉ là vỏ mỏng map sang `it()`. Chỉ nhờ vậy mới có được ba
 * thứ mà §13.2 đòi và một hàm `describe()` cứng không cho được:
 *
 *  1. **Meta-test "hợp đồng có răng":** đếm được số phép đã chạy và khẳng định mỗi phép
 *     có ít nhất một `expect` đã thực thi. Một phép rỗng trong một `describe()` cứng
 *     trông y như một phép thật.
 *  2. **Harness E15 dùng lại y nguyên danh sách** khi đổi sang LocalStack, vì môi trường
 *     là tham số chứ không phải một điều kiện rải trong thân test.
 *  3. **Sổ nới lỏng của E1 đếm được bằng máy:** §13.2 nói số lần phải nới lỏng bộ test
 *     chính là số liệu báo cáo, nên nó phải là một hằng số, không phải một loạt
 *     `it.skip` rải rác.
 */

/** Môi trường mà bộ hợp đồng Cloud chạy trên — bốn cổng, không phải hai lựa chọn */
export interface CloudContractEnv {
  readonly driver: "in-process" | "child-process";
  readonly ledger: () => Ledger;
  readonly control: CloudControl;
  /** Hằng số kỳ vọng VIẾT TAY — không suy từ `steps.length` của chính adapter */
  readonly fixture: CloudFixture;
  /**
   * Dựng cùng adapter nhưng với một credential mang nhãn khác.
   *
   * Phép kiểm `c8` cần một credential **thiếu quyền có chủ đích**, và cách duy nhất để nó
   * không phải một mock là môi trường tự cấp được một adapter như thế. Trên LocalStack đây
   * là một IAM role đã bị gỡ quyền; ở đây là một nhãn.
   */
  readonly adapterWithCredentialLabel?: (label: string) => CloudAdapter;
}

/**
 * Một phép kiểm của hợp đồng.
 *
 * `designCheckId` trỏ về phép tương ứng trong §13.2 của tài liệu. Nhờ trường này, một
 * bảng truy vết kiểm được bằng máy: thiếu một phép GỐC là một test đỏ, và đổi tên một
 * phép không làm mất dấu nó.
 */
export interface ContractCheck<TEnv> {
  /** Tên hiển thị, tiếng Việt, theo lối đặt tên của bộ test dự án */
  name: string;
  /** Mã của phép gốc trong §13.2, hoặc `null` nếu đây là phép v4.10 thêm vào */
  designCheckId: string | null;
  run(adapter: CloudAdapter, env: TEnv): Promise<void>;
}

export type CloudContractCheck = ContractCheck<CloudContractEnv>;

/**
 * Một lần **nới lỏng** bộ hợp đồng cho một họ adapter.
 *
 * §13.2: "nếu bộ test phải nới lỏng để `SaaSAdapter` lọt, thì khung adapter đã gò ép, và
 * số lần phải nới lỏng chính là số liệu báo cáo ở E1". Nên nới lỏng KHÔNG được làm bằng
 * `it.skip` hay một `return` sớm theo kiểu adapter — nó phải là một hàng ở đây, có lý do.
 *
 * Phân biệt với **tổng quát hoá** (đổi phát biểu của phép kiểm cho MỌI adapter): tổng
 * quát hoá không vào danh sách này, nó được ghi riêng.
 */
export interface ContractRelaxation {
  /** `name` của phép kiểm được nới lỏng */
  check: string;
  /** Họ adapter được miễn, ví dụ `"SaaSAdapter"` */
  adapterKind: string;
  reason: string;
}

/** Sổ nới lỏng — số liệu E1 là `.length`, máy đếm được, không thể quên */
export const CONTRACT_RELAXATIONS: readonly ContractRelaxation[] = [];

export type { LedgerCheck, LedgerFactory, TestRunnerApi } from "./ledger.js";
export { LEDGER_CONTRACT_CHECKS, runLedgerContract } from "./ledger.js";
