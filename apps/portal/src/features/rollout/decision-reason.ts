import type { DecisionCause, DecisionDetail } from "@udp/shared-types/rollout";
import { messagesOf } from "../../i18n";
import { formatDecimal, formatDuration, formatPercent } from "../../lib/format";
import { decisionReasonMessages } from "./decision-reason.messages";

/**
 * [Plan #60 QĐ-1, UX-23] Lý do của một quyết định rollout theo ngôn ngữ đang chọn, từ mã + số của Service 3. Không
 * có `detail` (hàng ghi trước Plan #60, lý do vận hành như lỗi gọi Service 2) thì dùng câu chữ máy chủ gửi kèm.
 *
 * Hàm thuần đọc ngôn ngữ lúc gọi (như `formatNumber`): component gọi nó đã theo dõi ngôn ngữ qua chữ của chính nó.
 */
export function decisionReason(
  detail: DecisionDetail | null | undefined,
  fallback: string | null | undefined,
): string | null {
  if (detail === null || detail === undefined) return fallback ?? null;
  const m = messagesOf(decisionReasonMessages);
  switch (detail.code) {
    case "NO_DATA":
      return m.noData;
    case "WARMING_UP":
      return m.warmingUp(detail.requests, detail.needed);
    case "SETTLING":
      return m.settling(formatDuration(detail.waitSeconds));
    case "WITHIN_THRESHOLDS":
      return m.within;
    case "MANUAL_ONLY":
      return m.manualOnly;
    case "BREACH": {
      const causes = detail.causes.map(causeText).join("; ");
      return detail.streak >= detail.needed
        ? m.breachConfirmed(detail.needed, causes)
        : m.breachPending(detail.streak, detail.needed, causes);
    }
  }
}

/** Tỉ lệ lỗi là phân số (0,07) ⇒ phần trăm; độ trễ là mili giây */
const pct = (fraction: number): string => formatPercent(fraction * 100);
const ms = (value: number): string => `${formatDecimal(Math.round(value))} ms`;

function causeText(cause: DecisionCause): string {
  const m = messagesOf(decisionReasonMessages).cause;
  switch (cause.kind) {
    case "ERROR_RATE":
      return m.errorRate(pct(cause.rate), pct(cause.limit), cause.errors);
    case "RELATIVE_ERROR_RATE":
      return m.relative(
        pct(cause.rate),
        formatDecimal(cause.factor),
        pct(cause.baselineRate),
      );
    case "LATENCY_P99":
      return m.latency(ms(cause.p99Ms), ms(cause.limitMs));
  }
}
