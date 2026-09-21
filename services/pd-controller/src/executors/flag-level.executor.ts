import { ROLLOUT_EVENT, ROLLOUT_RETRY, TOTAL_BUCKETS } from "@udp/config";
import { z } from "zod";
import { errorMessage } from "../core/errors.js";
import type { Weight } from "../rollout-session/target.js";
import type { Fence } from "../reconciler/fence.js";

/**
 * Executor FLAG_LEVEL (§3.3, §7.3, C1): đổi phần trăm của một flag bằng cách ramp
 * `serve.weights` của một rule qua `PATCH /internal/rules/:id` của Service 2.
 *
 * Ba điều không đổi:
 *   - Mọi PATCH mang `If-Match: "<sessionId>:<version>"` — bên nhận từ chối
 *     version cũ bằng 412 (I23). Đây là chốt ở PHÍA BÊN KIA lời gọi mạng, nơi
 *     optimistic lock của database không với tới.
 *   - `reason` là BẮT BUỘC trong body (S2 400 nếu thiếu), ≤ 255 ký tự.
 *   - URL và secret TIÊM vào, không đọc `env` ở đây: `env` đóng băng lúc nạp
 *     module, và test cần trỏ tới một Service 2 dựng trên cổng ngẫu nhiên.
 *
 * Kết quả có kiểu riêng, không phải `AdapterResult` (§4.1 không có
 * `PRECONDITION_FAILED`, và "bên nhận từ chối fencing token" không phải một kết
 * cục của adapter cloud).
 *
 * Ba kết cục hỏng, phân theo "thử lại có ích không":
 *   - `PRECONDITION_FAILED` (412) — token cũ; thử lại vô ích, vòng sau hội tụ.
 *   - `REJECTED` (4xx khác) — S2 SỐNG và từ chối yêu cầu (rule đổi hình dạng,
 *     body sai…). Thử lại vô ích, và kill-switch càng không được chạy: nó dành cho
 *     S2 CHẾT (§7.6), không phải để đi vòng qua một lời từ chối có lý do.
 *   - `FAILED` — mạng, hết giờ, 5xx: S2 có thể chỉ chập chờn, thử lại có ích.
 */

export type ApplyOutcome =
  | { status: "SUCCESS" }
  | { status: "PRECONDITION_FAILED"; message: string }
  | { status: "REJECTED"; message: string }
  | { status: "FAILED"; message: string };

export interface RampTarget {
  ruleId: string;
  weights: Weight[];
}

export type UntrackOutcome =
  | { status: "SUCCESS"; changed: boolean }
  | { status: "FAILED"; message: string };

const untrackBodySchema = z.object({ changed: z.boolean() });

export interface FlagLevelExecutor {
  applyTraffic(
    fence: Fence,
    target: RampTarget,
    reason: string,
  ): Promise<ApplyOutcome>;
  /**
   * [v4.3] `POST /internal/flag-envs/:id/untrack` (§6.6). Theo CONFIG, kể cả ngay
   * sau khi session đóng: hàng session có thể đã bị xoá, config thì không cần.
   * Không cần fence: S2 tự bỏ qua khi config còn rollout đang chạy, nên gọi thừa
   * hay gọi muộn đều vô hại. Config không còn ⇒ S2 trả 200 `not-found`, nên mọi
   * 404 ở đây là lỗi thật (sai địa chỉ, S2 bản cũ) và được báo là FAILED.
   */
  untrack(configId: string): Promise<UntrackOutcome>;
}

export interface FlagLevelExecutorOptions {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Trọng số cho `percent` của variant mục tiêu — canary FLAG_LEVEL là HAI nhánh
 * (§2.2, §16), nên phần còn lại là phần bù. Đơn vị bucket: 100% = TOTAL_BUCKETS.
 */
export function weightsFor(
  percent: number,
  current: readonly Weight[],
  targetVariantId: string,
): Weight[] {
  if (current.length !== 2) {
    throw new Error(
      `Canary FLAG_LEVEL chỉ ramp rule hai variant, rule này có ${String(current.length)}`,
    );
  }
  if (percent < 0 || percent > 100) {
    throw new Error(`Phần trăm ngoài khoảng [0, 100]: ${String(percent)}`);
  }
  if (!current.some((w) => w.variantId === targetVariantId)) {
    throw new Error(
      `Variant mục tiêu ${targetVariantId} không có trong trọng số hiện tại của rule`,
    );
  }
  const target = Math.round((percent * TOTAL_BUCKETS) / 100);
  return current.map((w) => ({
    variantId: w.variantId,
    weight: w.variantId === targetVariantId ? target : TOTAL_BUCKETS - target,
  }));
}

export function createFlagLevelExecutor(
  options: FlagLevelExecutorOptions,
): FlagLevelExecutor {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? ROLLOUT_RETRY.executorTimeoutMs;
  const fetchImpl = options.fetch ?? fetch;

  return {
    async applyTraffic(fence, target, reason) {
      // Lưới thứ nhất: còn lease không? Không thì DỪNG trước khi chạm S2.
      fence.assert();

      let res: Response;
      try {
        res = await fetchImpl(
          `${baseUrl}/internal/rules/${encodeURIComponent(target.ruleId)}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-internal-secret": options.secret,
              "if-match": fence.ifMatch(),
            },
            body: JSON.stringify({
              weights: target.weights,
              reason: reason.slice(0, ROLLOUT_EVENT.reasonMaxLength),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
      } catch (err: unknown) {
        return { status: "FAILED", message: errorMessage(err) };
      }

      if (res.status === 412) {
        return {
          status: "PRECONDITION_FAILED",
          message: await safeText(res),
        };
      }
      if (!res.ok) {
        const message = `HTTP ${String(res.status)}: ${await safeText(res)}`;
        return res.status < 500
          ? { status: "REJECTED", message }
          : { status: "FAILED", message };
      }
      return { status: "SUCCESS" };
    },

    async untrack(configId) {
      try {
        const res = await fetchImpl(
          `${baseUrl}/internal/flag-envs/${encodeURIComponent(configId)}/untrack`,
          {
            method: "POST",
            headers: { "x-internal-secret": options.secret },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!res.ok) {
          return {
            status: "FAILED",
            message: `HTTP ${String(res.status)}: ${await safeText(res)}`,
          };
        }
        const body = untrackBodySchema.parse(await res.json());
        return { status: "SUCCESS", changed: body.changed };
      } catch (err: unknown) {
        // Mạng, hết giờ, hay body không đúng hợp đồng — lưới quét thử lại
        return { status: "FAILED", message: errorMessage(err) };
      }
    },
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export interface RetryOptions {
  /** Epoch ms — quá mốc này thì thôi (§7.6 `rollbackRetrySeconds`) */
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fence: Fence;
  /** Lùi luỹ thừa: 1s, 2s, 4s… chặn ở `maxBackoffMs` */
  maxBackoffMs?: number;
}

/**
 * Thử lại một side effect cho tới hạn (§7.6): rollback không được phụ thuộc vào
 * một lần gọi may rủi khi S2 chập chờn. Dừng sớm khi: thành công, bên nhận từ
 * chối (412 hay 4xx khác — thử lại không đổi được gì), hoặc mất lease (fence).
 */
export async function applyWithRetry(
  apply: () => Promise<ApplyOutcome>,
  options: RetryOptions,
): Promise<ApplyOutcome> {
  const maxBackoff = options.maxBackoffMs ?? ROLLOUT_RETRY.maxBackoffMs;
  let backoff: number = ROLLOUT_RETRY.initialBackoffMs;
  for (;;) {
    options.fence.assert();
    const outcome = await apply();
    if (outcome.status !== "FAILED") return outcome;
    const remaining = options.deadline - options.now();
    if (remaining <= 0) return outcome;
    await options.sleep(Math.min(backoff, remaining, maxBackoff));
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}
