import type { SdkStatsReport } from "@udp/shared-types";
import { createSseParser, type SseItem } from "./sse.js";

/**
 * Đường mạng tới Service 2 (§6.3) [v4.7] — tách khỏi logic đồng bộ để test đơn vị
 * tiêm một transport giả và kiểm tất định I15a/I18/I33/I34 không cần mạng.
 *
 * Mọi phản hồi được PHÂN LOẠI ở đây; không gì ném ra ngoài (lỗi mạng cũng là một
 * loại kết quả). Body không đọc luôn bị huỷ: body 429 không đọc giữ kết nối trong
 * pool — đo được 30/30 kết nối bị giữ, huỷ thì còn 2.
 */

export type ConfigResult =
  | { kind: "ok"; body: unknown; etag: string | undefined }
  | { kind: "not-modified" }
  | { kind: "unauthorized" }
  | { kind: "unavailable"; retryAfterMs: number | undefined };

export type StreamOpen =
  | { kind: "open"; items: AsyncIterable<SseItem> }
  | { kind: "unauthorized" }
  /** 400: con trỏ sai dạng — RESYNC không con trỏ đúng một lần */
  | { kind: "bad-cursor" }
  | { kind: "unavailable"; retryAfterMs: number | undefined };

/**
 * Kết cục của MỘT lần `POST /sdk/stats`, phân loại theo V7. Ranh giới quan trọng
 * nhất là giữa `retry` và `ambiguous`: chỉ `retry` mới được gộp lô lại, vì chỉ ở
 * đó mới CHẮC CHẮN server chưa xử lý báo cáo.
 */
export type StatsPostResult =
  /** 2xx */
  | { kind: "accepted" }
  /** 429/503 hoặc kết nối hỏng trước khi gửi được gì ⇒ gộp lô lại */
  | { kind: "retry"; retryAfterMs: number | undefined }
  /** 400/413: báo cáo sai hợp đồng — gửi lại cũng thế; một chẩn đoán mỗi phiên */
  | { kind: "rejected" }
  /** 401/403 (khoá bị từ chối) và 404/405 (Service 2 chưa có route) */
  | { kind: "stop" }
  /** Quá hạn, bị huỷ, hoặc mã lạ: KHÔNG biết server đã xử lý hay chưa ⇒ bỏ lô */
  | { kind: "ambiguous" };

export interface Transport {
  getConfig(
    ifNoneMatch: string | undefined,
    signal: AbortSignal,
  ): Promise<ConfigResult>;
  /** `since` vắng = không con trỏ (server gửi snapshot trước) */
  openStream(
    since: number | undefined,
    signal: AbortSignal,
  ): Promise<StreamOpen>;
  postStats(
    report: SdkStatsReport,
    signal: AbortSignal,
  ): Promise<StatsPostResult>;
}

/** `Retry-After`: số giây HOẶC HTTP-date (RFC 9110 §10.2.3) */
export function retryAfterMs(
  header: string | null,
  now: number,
): number | undefined {
  if (header === null) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // body đã đóng
  }
}

export class HttpTransport implements Transport {
  private readonly base: string;

  constructor(
    host: string,
    private readonly sdkKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = host.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.sdkKey}`, ...extra };
  }

  async getConfig(
    ifNoneMatch: string | undefined,
    signal: AbortSignal,
  ): Promise<ConfigResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/sdk/config`, {
        headers: this.headers(
          ifNoneMatch === undefined ? {} : { "If-None-Match": ifNoneMatch },
        ),
        signal,
      });
    } catch {
      return { kind: "unavailable", retryAfterMs: undefined };
    }
    if (res.status === 304) {
      await discard(res);
      return { kind: "not-modified" };
    }
    if (res.status === 401 || res.status === 403) {
      await discard(res);
      return { kind: "unauthorized" };
    }
    if (!res.ok) {
      const retry = retryAfterMs(res.headers.get("Retry-After"), Date.now());
      await discard(res);
      return { kind: "unavailable", retryAfterMs: retry };
    }
    try {
      return {
        kind: "ok",
        body: await res.json(),
        etag: res.headers.get("ETag") ?? undefined,
      };
    } catch {
      return { kind: "unavailable", retryAfterMs: undefined };
    }
  }

  async openStream(
    since: number | undefined,
    signal: AbortSignal,
  ): Promise<StreamOpen> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.base}/sdk/stream${since === undefined ? "" : `?since=${String(since)}`}`,
        { headers: this.headers({ Accept: "text/event-stream" }), signal },
      );
    } catch {
      return { kind: "unavailable", retryAfterMs: undefined };
    }
    if (res.status === 401 || res.status === 403) {
      await discard(res);
      return { kind: "unauthorized" };
    }
    if (res.status === 400) {
      await discard(res);
      return { kind: "bad-cursor" };
    }
    const type = res.headers.get("Content-Type") ?? "";
    if (!res.ok || res.body === null || !type.startsWith("text/event-stream")) {
      const retry = retryAfterMs(res.headers.get("Retry-After"), Date.now());
      await discard(res);
      return { kind: "unavailable", retryAfterMs: retry };
    }
    return { kind: "open", items: itemsOf(res.body) };
  }

  async postStats(
    report: SdkStatsReport,
    signal: AbortSignal,
  ): Promise<StatsPostResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/sdk/stats`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(report),
        signal,
      });
    } catch {
      /**
       * `signal` đã bắn ⇒ quá hạn hoặc provider đang đóng: request có thể đã tới
       * server rồi, gửi lại là đếm đôi (V7). Còn lại là kết nối hỏng NGAY (DNS,
       * ECONNREFUSED, TLS): chưa một byte nào ra khỏi máy khách ⇒ gộp lô lại.
       */
      return signal.aborted
        ? { kind: "ambiguous" }
        : { kind: "retry", retryAfterMs: undefined };
    }
    const { status } = res;
    const retry = retryAfterMs(res.headers.get("Retry-After"), Date.now());
    await discard(res);
    if (res.ok) return { kind: "accepted" };
    if (status === 429 || status === 503)
      return { kind: "retry", retryAfterMs: retry };
    if (status === 400 || status === 413) return { kind: "rejected" };
    if (status === 401 || status === 403 || status === 404 || status === 405)
      return { kind: "stop" };
    // 500/502/504…: proxy có thể đã chuyển request đi rồi mới hỏng ⇒ bỏ lô
    return { kind: "ambiguous" };
  }
}

async function* itemsOf(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseItem> {
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const item of parser.feed(decoder.decode(value, { stream: true }))) {
        yield item;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // đã đóng
    }
  }
}
