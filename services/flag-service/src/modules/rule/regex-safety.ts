import { CONDITION_LIMITS } from "@udp/config";
import { UnprocessableError } from "@udp/http";
import { check } from "recheck";

/**
 * Phân tích ReDoS THẬT cho pattern `regex` — chỉ ở đường GHI của Service 2 (§6.5,
 * §12) [v4.6].
 *
 * Vì sao cần, khi schema dùng chung đã cấm backreference và lookaround: đánh giá
 * chạy trong OFREP — endpoint công khai, gọi được bằng khoá CLIENT nằm trong
 * trình duyệt — và JS không có timeout cho regex. `(a|a)*$` (hàm mũ) hay
 * `\d*\d*\d*x` (đa thức) đều qua được mọi phép kiểm cú pháp. `recheck` phân tích
 * automaton của pattern và trả `safe` / `vulnerable` / `unknown`.
 *
 * Phân tích chạy trong WORKER của `recheck`, không trên event loop: một lần ghi
 * nhiều pattern không được đứng cả `/sdk`, SSE, OFREP và poller của Service 2.
 * Trần `regexPatternsPerWrite` pattern khác nhau mỗi lần ghi, mỗi cái tối đa
 * `regexCheckTimeoutMs`, giữ tổng thời gian dưới hạn chờ của Service 1.
 *
 * Chỉ Service 2 phụ thuộc thư viện này: nó nặng, và code chạy trong ứng dụng của
 * khách (evaluator) không nên kéo nó theo. Lúc đánh giá, trần `regexInputMax` là
 * lớp chặn còn lại.
 *
 * `unknown` (hết hạn phân tích) bị TỪ CHỐI như `vulnerable`: một pattern mà bộ
 * phân tích không kết luận được là pattern không nên chạy trên endpoint công khai.
 */

/**
 * `recheck` chỉ nhận cấu hình backend qua biến môi trường. `worker` = phân tích
 * bằng JS trong worker thread của chính nó. Mặc định (`auto`) thử gọi một agent
 * Java/native trước — thứ không có (và không nên có) trong image.
 */
process.env["RECHECK_BACKEND"] ??= "worker";

/** Kết quả theo pattern — pattern là hằng của cấu hình, lặp lại qua mỗi lần lưu */
const verdicts = new Map<string, string | null>();
const VERDICT_CACHE_MAX = 1_000;

async function unsafeRegexIssue(pattern: string): Promise<string | undefined> {
  const cached = verdicts.get(pattern);
  if (cached !== undefined) return cached ?? undefined;

  const result = await check(pattern, "u", {
    timeout: CONDITION_LIMITS.regexCheckTimeoutMs,
  });
  const issue =
    result.status === "safe"
      ? null
      : result.status === "vulnerable"
        ? `có thể backtracking ${result.complexity.type === "exponential" ? "hàm mũ" : "đa thức"} (ReDoS)`
        : "không phân tích được độ an toàn trong thời hạn";
  if (verdicts.size >= VERDICT_CACHE_MAX) verdicts.clear();
  verdicts.set(pattern, issue);
  return issue ?? undefined;
}

interface RegexBearing {
  ruleType: string;
  condition?: unknown;
}

function patternsOf(condition: unknown): string[] {
  if (typeof condition !== "object" || condition === null) return [];
  const all: unknown = (condition as { all?: unknown }).all;
  if (!Array.isArray(all)) return [];
  return all.flatMap((c: unknown) =>
    typeof c === "object" &&
    c !== null &&
    (c as { operator?: unknown }).operator === "regex" &&
    typeof (c as { value?: unknown }).value === "string"
      ? [(c as { value: string }).value]
      : [],
  );
}

/** Ném 422 nếu một pattern `regex` nào trong các rule không an toàn */
export async function assertRegexesSafe(
  rules: readonly RegexBearing[],
): Promise<void> {
  const patterns = new Set(
    rules
      .filter((r) => r.ruleType === "ATTRIBUTE_BASED")
      .flatMap((r) => patternsOf(r.condition)),
  );
  if (patterns.size > CONDITION_LIMITS.regexPatternsPerWrite) {
    throw new UnprocessableError(
      `${String(patterns.size)} pattern regex khác nhau trong một lần lưu (tối đa ${String(CONDITION_LIMITS.regexPatternsPerWrite)})`,
    );
  }
  for (const pattern of patterns) {
    const issue = await unsafeRegexIssue(pattern);
    if (issue !== undefined) {
      throw new UnprocessableError(`Pattern regex "${pattern}" ${issue}`);
    }
  }
}
