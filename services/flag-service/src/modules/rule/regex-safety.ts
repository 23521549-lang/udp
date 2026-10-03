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
 *
 * [v4.9] Dùng chung cho đường ghi rule VÀ đường ghi segment. `assertRegexesSafe`
 * lọc theo `ruleType`, thứ mà segment không có: gọi nó với một segment thì hàm im
 * lặng kiểm 0 pattern và `(a|a)*$` lọt lên OFREP (R07 (a)). Nên phép phân tích
 * được xuất ở HAI mức không phụ thuộc `ruleType` — `assertConditionsSafe` cho
 * `{ all }` của segment, `assertPatternsSafe` cho một tập pattern trần.
 */

/**
 * `recheck` chỉ nhận cấu hình backend qua biến môi trường. `worker` = phân tích
 * bằng JS trong worker thread của chính nó. Mặc định (`auto`) thử gọi một agent
 * Java/native trước — thứ không có (và không nên có) trong image.
 */
process.env["RECHECK_BACKEND"] ??= "worker";

/**
 * Phân tích MỘT pattern: `undefined` = an toàn, chuỗi = lý do từ chối.
 *
 * Là một kiểu riêng vì nó là SEAM (T9): ca `unknown` chỉ xảy ra khi `recheck` hết
 * hạn 1 giây, và một test phụ thuộc điều đó thì vừa chậm vừa chập chờn. Cũng là
 * cách duy nhất làm test thứ tự của R07 tất định — "phân tích treo thì lần ghi
 * flag cùng project vẫn xong" cần một phép phân tích không bao giờ trả lời.
 */
export type RegexAnalyzer = (pattern: string) => Promise<string | undefined>;

const recheckAnalyzer: RegexAnalyzer = async (pattern) => {
  const result = await check(pattern, "u", {
    timeout: CONDITION_LIMITS.regexCheckTimeoutMs,
  });
  if (result.status === "safe") return undefined;
  return result.status === "vulnerable"
    ? `có thể backtracking ${result.complexity.type === "exponential" ? "hàm mũ" : "đa thức"} (ReDoS)`
    : "không phân tích được độ an toàn trong thời hạn";
};

let analyze: RegexAnalyzer = recheckAnalyzer;

/** Kết quả theo pattern — pattern là hằng của cấu hình, lặp lại qua mỗi lần lưu */
const verdicts = new Map<string, string | null>();
const VERDICT_CACHE_MAX = 1_000;

/**
 * Thay bộ phân tích, trả hàm hoàn nguyên — CHỈ dùng trong test.
 *
 * Xoá cache ở cả hai chiều: một phán quyết là phán quyết CỦA bộ phân tích đã sinh
 * ra nó, nên giữ lại qua một lần thay là để kết quả của bản giả trả lời cho bản
 * thật (và ngược lại) ở lần ghi kế tiếp.
 */
export function setRegexAnalyzer(analyzer: RegexAnalyzer): () => void {
  analyze = analyzer;
  verdicts.clear();
  return () => {
    analyze = recheckAnalyzer;
    verdicts.clear();
  };
}

async function unsafeRegexIssue(pattern: string): Promise<string | undefined> {
  const cached = verdicts.get(pattern);
  if (cached !== undefined) return cached ?? undefined;

  const issue = await analyze(pattern);
  if (verdicts.size >= VERDICT_CACHE_MAX) verdicts.clear();
  verdicts.set(pattern, issue ?? null);
  return issue;
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

/**
 * Ném 422 nếu một pattern nào trong tập không an toàn — mức thấp nhất, không biết
 * gì về rule hay segment.
 *
 * Khử trùng TRƯỚC khi đếm: trần `regexPatternsPerWrite` là trần của công việc
 * phải làm, và cùng một pattern lặp 20 lần chỉ tốn một lần phân tích. Trần được
 * xét trước vòng lặp, nên một lần ghi vượt trần không phân tích pattern nào.
 */
export async function assertPatternsSafe(
  patterns: Iterable<string>,
): Promise<void> {
  const distinct = new Set(patterns);
  if (distinct.size > CONDITION_LIMITS.regexPatternsPerWrite) {
    throw new UnprocessableError(
      `${String(distinct.size)} pattern regex khác nhau trong một lần lưu (tối đa ${String(CONDITION_LIMITS.regexPatternsPerWrite)})`,
    );
  }
  for (const pattern of distinct) {
    const issue = await unsafeRegexIssue(pattern);
    if (issue !== undefined) {
      throw new UnprocessableError(`Pattern regex "${pattern}" ${issue}`);
    }
  }
}

/**
 * [v4.9] Ném 422 nếu `conditions.all` của một SEGMENT mang pattern không an toàn.
 *
 * Segment không có `ruleType`, và điều kiện của nó chạy trên đúng cùng evaluator
 * với điều kiện của rule (§6.5) — nên nó phải qua đúng cùng phép phân tích.
 */
export const assertConditionsSafe = (conditions: {
  readonly all: readonly unknown[];
}): Promise<void> => assertPatternsSafe(patternsOf(conditions));

/** Ném 422 nếu một pattern `regex` nào trong các rule không an toàn */
export const assertRegexesSafe = (
  rules: readonly RegexBearing[],
): Promise<void> =>
  assertPatternsSafe(
    rules
      .filter((r) => r.ruleType === "ATTRIBUTE_BASED")
      .flatMap((r) => patternsOf(r.condition)),
  );
