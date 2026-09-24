/**
 * [v4.10] Lỗi CHÍ TỬ, và quy tắc `rethrowIfFatal`.
 *
 * Runner chạy một vòng lặp dài quanh các lời gọi cloud, nên nó phải bắt lỗi ở nhiều chỗ
 * để compensation có cơ hội chạy. Nhưng có hai hạng lỗi mà bắt là SAI:
 *
 *  1. **Mất lease** (`FenceLostError`). Worker này không còn quyền tác động; bắt lỗi rồi
 *     đi tiếp là đúng kịch bản mà điểm crash K9 sinh ra để chặn — hai worker cùng ghi.
 *  2. **Crash mô phỏng** (`SimulatedCrash`). Nó đại diện cho `kill -9`, và một tiến trình
 *     bị `kill -9` KHÔNG chạy `catch`. Nếu runner bắt nó rồi chạy compensation thì lưới
 *     khôi phục đang kiểm một thứ khác hẳn: nó kiểm nhánh `try/catch` của chính runner
 *     thay vì kiểm khả năng resume từ sổ và tag.
 *
 * Quy tắc RUN13 vì vậy là: **`rethrowIfFatal(err)` là câu lệnh ĐẦU TIÊN của mọi `catch`**
 * trong runner. Nó được cưỡng chế bằng một phép quét AST, không bằng kỷ luật — vì một
 * `catch` quên gọi nó là một lỗ không ai thấy trong code review.
 */

/** Lớp gốc của mọi lỗi mà runner KHÔNG được bắt */
export abstract class FatalRunnerError extends Error {}

/** Lease đã mất: `version` của job đã đổi, worker khác đã nhận (điểm crash K9) */
export class FenceLostError extends FatalRunnerError {
  constructor(readonly detail: string) {
    super(`Mất lease, worker này không còn quyền ghi: ${detail}`);
    this.name = "FenceLostError";
  }
}

/**
 * Đại diện cho `kill -9` ở tầng in-process của lưới.
 *
 * Nó cố tình KHÔNG mang thông tin gì hữu ích: một tiến trình bị giết không để lại thông
 * điệp, và nếu runner đọc được gì từ nó thì nó đã không còn là một lần chết.
 */
export class SimulatedCrash extends FatalRunnerError {
  constructor(readonly phase: string) {
    super(`crash mô phỏng ở pha ${phase}`);
    this.name = "SimulatedCrash";
  }
}

/** Ném lại nếu lỗi thuộc hạng chí tử. Câu lệnh ĐẦU TIÊN của mọi `catch` (RUN13) */
export function rethrowIfFatal(err: unknown): void {
  if (err instanceof FatalRunnerError) throw err;
}

/**
 * Lỗi của một step, mang theo tên step để compensation biết dừng ở đâu.
 *
 * Không phải chí tử: đây là thứ compensation tồn tại để xử lý.
 */
export class StepFailedError extends Error {
  constructor(
    readonly stepName: string,
    /**
     * `override` là bắt buộc: `Error.cause` đã tồn tại từ ES2022, và TypeScript đòi nói
     * rõ ta đang ghi đè nó chứ không tình cờ trùng tên.
     */
    override readonly cause: unknown,
  ) {
    super(`step ${stepName} thất bại`);
    this.name = "StepFailedError";
  }
}

/**
 * `lookup()` trả `indeterminate` quá số lần thử.
 *
 * Không phải chí tử và **không** dẫn tới compensation: hàng giữ `CREATING`, job sang
 * `FAILED`, và lượt job sau vẫn hội tụ được. Xoá tài nguyên mà ta không chắc có tồn tại
 * là chế độ hỏng tệ hơn.
 */
export class LookupIndeterminateError extends Error {
  constructor(
    readonly stepName: string,
    readonly attempts: number,
    readonly lastReason: string,
  ) {
    super(
      `lookup của ${stepName} còn bất định sau ${String(attempts)} lần thử: ${lastReason}`,
    );
    this.name = "LookupIndeterminateError";
  }
}
