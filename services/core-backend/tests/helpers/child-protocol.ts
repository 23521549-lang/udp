import type { RunnerPhase } from "@udp/adapter-core/runner";

/**
 * [v4.10] Giao thức giữa tiến trình cha và tiến trình con của lưới tầng 2.
 *
 * Nó là một module RIÊNG, không nằm trong `provision-child.ts`, vì tệp đó là một
 * **điểm vào chạy được**: nó gọi `main()` ở cấp module. Nhập nó chỉ để lấy một hằng số
 * là chạy luôn cả tiến trình provision — đúng lỗi đã gặp: mọi ô của tầng 2 đỏ với
 * "thiếu tham số JSON" ngay lúc collect, trước khi một ô nào kịp chạy.
 */

export interface ChildRequest {
  projectId: string;
  jobId: string;
  workerId: string;
  /** Fence token — `version` tại lúc giành lease */
  version: number;
  cloudStatePath: string;
  applicationName: string;
  /** Pha sẽ tự `SIGKILL`; bỏ trống thì chạy hết không chết */
  crashPhase?: RunnerPhase;
  /** Step mà pha đó phải thuộc về; bỏ trống thì step đầu tiên gặp pha đó */
  crashStep?: string;
  /**
   * `pause` thay vì `kill`: in `PAUSED` rồi CHỜ một dòng trên stdin.
   *
   * Đây là cách ô K9 dựng được: con A dừng giữa đường (còn sống, còn giữ token cũ), cha
   * cướp lease, rồi A đi tiếp và phải bị fence chặn. Giết A thì không còn ai để bị chặn.
   */
  mode?: "kill" | "pause";
  /** Độ trễ lan truyền tag của cloud mô phỏng, cho ô `indeterminate` */
  tagPropagationDelayMs?: number;
}

/** Dòng con in ra khi tới pha `pause` — cha chờ đúng chuỗi này */
export const CHILD_PAUSED = "UDP_CHILD_PAUSED";
/** Dòng con in ra khi chạy xong mà không chết */
export const CHILD_DONE = "UDP_CHILD_DONE";
/**
 * Mốc chỉ in ra nếu tiến trình thoát TỬ TẾ — phân biệt `SIGKILL` với `process.exit`.
 *
 * `process.on("exit")` chạy khi tiến trình tự kết thúc, kể cả `process.exit(1)`, nhưng
 * KHÔNG chạy khi bị `SIGKILL` (hay `TerminateProcess` trên Windows). Không có mốc này,
 * phép khẳng định chết chỉ biết "thoát khác 0" — và trên Windows, nơi không có signal,
 * nó không phân biệt được một cái chết đột tử với một `process.exit(1)` tử tế. Đổi một
 * dòng trong tiến trình con là đủ để cả 40 ô mất ý nghĩa mà không ô nào đỏ.
 */
export const CHILD_GRACEFUL_EXIT = "UDP_CHILD_GRACEFUL_EXIT";

/** Dòng con in ra khi bị fence chặn — kết cục mong đợi của ô K9 */
export const CHILD_FENCED = "UDP_CHILD_FENCED";
