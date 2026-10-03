import { count, defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

/**
 * [Plan #60 QĐ-1, UX-23] Câu cho lý do quyết định của vòng phân tích, viết từ MÃ + số Service 3 trả về (không còn
 * hiện câu tiếng Việt máy chủ viết sẵn khi người xem chọn English). Số đã định dạng theo ngôn ngữ trước khi vào đây.
 */
export const decisionReasonMessages = defineMessages({
  vi: {
    noData: "Nguồn số đo chưa trả dữ liệu cho bản thử, nên chưa quyết được.",
    warmingUp: (requests: number, needed: number) =>
      `Mới có ${formatNumber(requests)}/${formatNumber(needed)} request, chờ đủ để đo.`,
    settling: (wait: string) =>
      `Chờ cửa sổ đo nằm trọn sau bậc mới (còn ${wait}).`,
    within: "Không vượt ngưỡng.",
    breachPending: (streak: number, needed: number, causes: string) =>
      `Vượt ngưỡng lần ${formatNumber(streak)}/${formatNumber(needed)}: ${causes}.`,
    breachConfirmed: (needed: number, causes: string) =>
      `Vượt ngưỡng ${formatNumber(needed)} lần đo liên tiếp: ${causes}.`,
    manualOnly:
      "Chiến lược này không tự quyết: so số đo của hai nhóm rồi promote hay rollback bằng tay.",
    cause: {
      errorRate: (rate: string, limit: string, errors: number) =>
        `tỉ lệ lỗi ${rate} cao hơn ngưỡng ${limit} (${formatNumber(errors)} lỗi)`,
      relative: (rate: string, factor: string, baseline: string) =>
        `tỉ lệ lỗi ${rate} cao hơn ${factor} lần nhóm đối chứng (${baseline})`,
      latency: (p99: string, limit: string) =>
        `độ trễ p99 ${p99} cao hơn ngưỡng ${limit}`,
    },
  },
  en: {
    noData:
      "The metrics source returned no data for the canary, so no decision yet.",
    warmingUp: (requests: number, needed: number) =>
      `Only ${formatNumber(requests)} of ${count(needed, "request", "requests")} so far; waiting for enough to measure.`,
    settling: (wait: string) =>
      `Waiting for the measurement window to clear the new step (${wait} left).`,
    within: "Within thresholds.",
    breachPending: (streak: number, needed: number, causes: string) =>
      `Threshold crossed ${formatNumber(streak)} of ${formatNumber(needed)} times: ${causes}.`,
    breachConfirmed: (needed: number, causes: string) =>
      `Threshold crossed in ${count(needed, "measurement", "measurements")} in a row: ${causes}.`,
    manualOnly:
      "This strategy does not decide on its own: compare the two groups, then promote or roll back by hand.",
    cause: {
      errorRate: (rate: string, limit: string, errors: number) =>
        `error rate ${rate} above the ${limit} limit (${count(errors, "error", "errors")})`,
      relative: (rate: string, factor: string, baseline: string) =>
        `error rate ${rate} over ${factor} times the baseline (${baseline})`,
      latency: (p99: string, limit: string) =>
        `p99 latency ${p99} above the ${limit} limit`,
    },
  },
});
