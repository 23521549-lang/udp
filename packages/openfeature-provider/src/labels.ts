import { AsyncLocalStorage } from "node:async_hooks";
import type {
  EvaluationDetails,
  FlagValue,
  Hook,
  HookContext,
} from "@openfeature/server-sdk";

/**
 * Nhãn `ff` theo request (§6.6) [v4.7] — phần KHÔNG cần prom-client: provider tự
 * gắn hook này (tính chất b §6.8: developer không cấu hình gì), nên nó không được
 * kéo prom-client vào mọi ứng dụng. Middleware đọc store nằm ở subpath `/metrics`.
 */

export interface RequestLabels {
  /** flagKey ⇒ variant, chỉ tracked flag; lần đánh giá CUỐI trong request thắng */
  readonly flags: Map<string, string>;
}

/**
 * MỘT store cho cả tiến trình, kể cả khi ứng dụng nạp HAI bản của package (bundle
 * tách entry `.` và `./metrics`, hai bản cài lồng nhau): hook ghi vào store A mà
 * middleware đọc store B thì nhãn `ff` biến mất không một lỗi nào — probe pha 2
 * không bao giờ mở và rollout FLAG_LEVEL hết hạn. Khoá `Symbol.for` là toàn cục.
 */
const STORE_KEY = Symbol.for("udp.openfeature-provider.requestStore");
const registry = globalThis as unknown as Record<
  symbol,
  AsyncLocalStorage<RequestLabels> | undefined
>;

export const requestStore: AsyncLocalStorage<RequestLabels> = (registry[
  STORE_KEY
] ??= new AsyncLocalStorage<RequestLabels>());

/**
 * Ghi `flagKey ⇒ variant` của tracked flag vào store của request đang chạy.
 * Bỏ qua khi không có store (ngoài request), flag không tracked, hoặc không có
 * `variant` (DISABLED/ERROR — không nhánh nào để gắn).
 *
 * KHÔNG BAO GIỜ ném: hook `after` ném thì SDK trả default thay giá trị thật — một
 * lỗi đo lường sẽ đổi hành vi của ứng dụng khách (I33).
 */
export class UDPRequestLabelHook implements Hook {
  constructor(private readonly tracked: () => ReadonlySet<string>) {}

  after(
    hookContext: Readonly<HookContext<FlagValue>>,
    details: EvaluationDetails<FlagValue>,
  ): void {
    try {
      const store = requestStore.getStore();
      if (store === undefined || details.variant === undefined) return;
      if (!this.tracked().has(hookContext.flagKey)) return;
      store.flags.set(hookContext.flagKey, details.variant);
    } catch {
      // đo lường không bao giờ được làm hỏng một lần đánh giá
    }
  }
}
