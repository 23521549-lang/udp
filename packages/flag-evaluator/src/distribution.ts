import type { FlagServe } from "@udp/shared-types";
import { bucketOf, type BucketInput } from "./hash.js";

/**
 * Chọn variant từ `rule.serve` (§6.4).
 */
export type VariantPick =
  | { kind: "variant"; variantId: string }
  | { kind: "distribution"; variantId: string }
  /** Không có giá trị stickiness — người gọi phải bỏ qua rule này, xem dưới */
  | { kind: "no-sticky" };

export function pickVariant(serve: FlagServe, input: BucketInput): VariantPick {
  if (serve.kind === "variant") {
    return { kind: "variant", variantId: serve.variantId };
  }

  /**
   * Người dùng ẩn danh: KHÔNG bốc ngẫu nhiên, mà báo cho người gọi bỏ qua rule.
   *
   * Bản v2 băm thẳng `context.userId`. Khi nó `undefined`, mọi người dùng ẩn
   * danh băm ra CÙNG một chuỗi nên rơi vào cùng một bucket — hoặc tất cả thấy,
   * hoặc không ai thấy, chứ không bao giờ là 20%. Đó là lỗi mà một phép đo tỉ lệ
   * trên người dùng đã đăng nhập sẽ không bao giờ phát hiện.
   *
   * Trả `no-sticky` thay vì tự chọn: evaluator sẽ `continue` sang rule kế tiếp,
   * và cuối cùng rơi về default variant. Khác Unleash, vốn bốc ngẫu nhiên.
   */
  if (input.stickyValue == null || input.stickyValue === "") {
    return { kind: "no-sticky" };
  }

  const bucket = bucketOf(input);
  let cumulative = 0;

  /**
   * KHÔNG sắp lại `weights`, dù sắp sẽ làm hàm băm snapshot ổn định hơn.
   *
   * Thứ tự mảng mang NGỮ NGHĨA: `[{A,10000},{B,90000}]` và `[{B,90000},{A,10000}]`
   * gán mọi người dùng vào hai variant khác nhau. Đã đo: đảo thứ tự mảng rồi
   * tăng phần trăm làm 2023/2023 người đang thấy `on` mất hết quyền thấy. Nếu
   * sắp ở đây, hai cấu hình có hành vi khác nhau sẽ ra cùng `config_hash`, và
   * I15a mù đúng chỗ nguy hiểm nhất. Thứ tự chuẩn phải được ép ở tầng GHI.
   */
  for (const slice of serve.weights) {
    cumulative += slice.weight;
    if (bucket < cumulative) {
      return { kind: "distribution", variantId: slice.variantId };
    }
  }

  /**
   * Không tới được: `flagServeDbSchema` bắt buộc tổng weight bằng đúng
   * `TOTAL_BUCKETS`, mà `bucket` luôn nhỏ hơn con số đó. Ném thay vì trả một
   * variant tuỳ tiện — nếu dòng này chạy thì bất biến ở tầng ghi đã vỡ, và im
   * lặng phục vụ sai variant còn tệ hơn một lỗi rõ ràng.
   */
  throw new Error(
    `serve.weights tổng không đủ ${String(cumulative)} cho bucket ${String(bucket)} — ` +
      `dữ liệu đã lọt qua flagServeDbSchema mà không đúng bất biến của nó`,
  );
}
