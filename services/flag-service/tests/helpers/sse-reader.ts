import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";

/**
 * Đọc SSE bằng `node:http` — Node 22 không có `EventSource` toàn cục (đã đo).
 *
 * `node:http` chứ không `fetch`: `fetch` không cho GET mang body và không gửi
 * `Content-Length: 0`, mà đó đúng là thứ một SDK viết bằng ngôn ngữ khác có thể
 * gửi — và là thứ làm `req` của Express bắn `close` SỚM (đã đo: +1ms, trong khi
 * `fetch` và GET không `Content-Length` thì không). Test phải dựng lại được đúng
 * những byte đó, nên client phải cho đặt header tuỳ ý.
 *
 * Tự đọc chứ không dùng thư viện EventSource: thứ đang được kiểm CHÍNH LÀ chữ trên
 * dây, mà thư viện thì tự nối lại, tự gửi `Last-Event-ID`, tự nuốt `retry:` — che
 * đúng những thứ test cần nhìn thấy.
 */

export interface SseEvent {
  id: string | undefined;
  event: string | undefined;
  data: string | undefined;
}

export interface SseReader {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  /** Mọi giá trị `retry:` đã thấy, theo thứ tự */
  readonly retries: readonly number[];
  /** Số dòng chú thích (nhịp tim) đã thấy */
  heartbeats(): number;
  /** Event kế tiếp — bỏ qua nhịp tim và `retry:`; ném nếu hết hạn hoặc stream đóng */
  next(timeoutMs: number): Promise<SseEvent>;
  /** Khẳng định KHÔNG có event nào trong `ms` */
  quiet(ms: number): Promise<void>;
  /** Resolve khi server đóng stream (hoặc test tự đóng) */
  readonly closed: Promise<void>;
  close(): void;
}

export function openSse(
  url: string,
  headers: Record<string, string>,
): Promise<SseReader> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers });
    // Lỗi trước khi có response là lỗi nối; sau đó `reject` không còn tác dụng
    req.on("error", reject);
    req.on("response", (res) => {
      resolve(readerOf(req, res));
    });
    req.end();
  });
}

function readerOf(req: ClientRequest, res: IncomingMessage): SseReader {
  const queue: SseEvent[] = [];
  const retries: number[] = [];
  let beats = 0;
  let ended = false;
  let wake: (() => void) | undefined;
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const onFrame = (frame: string): void => {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) {
        beats += 1;
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "retry") retries.push(Number(value));
      else if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (event === undefined && data.length === 0) return;
    queue.push({
      id,
      event,
      data: data.length === 0 ? undefined : data.join("\n"),
    });
    wake?.();
  };

  const finish = (): void => {
    if (ended) return;
    ended = true;
    markClosed();
    wake?.();
  };

  let buffer = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    buffer += chunk;
    for (
      let cut = buffer.indexOf("\n\n");
      cut !== -1;
      cut = buffer.indexOf("\n\n")
    ) {
      onFrame(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
    }
  });
  // Server đóng, server huỷ, hay test tự huỷ — cả ba đều là "đã đóng"
  res.on("end", finish);
  res.on("close", finish);
  res.on("error", finish);

  return {
    status: res.statusCode ?? 0,
    headers: {
      get(name) {
        const value = res.headers[name.toLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? value.join(", ") : value;
      },
    },
    retries,
    heartbeats: () => beats,
    async next(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const event = queue.shift();
        if (event !== undefined) return event;
        if (ended) throw new Error("Stream đã đóng trước khi có event");
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(`Không có event nào trong ${String(timeoutMs)}ms`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    },
    async quiet(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (queue.length > 0) {
        throw new Error(
          `Có event không mong đợi: ${JSON.stringify(queue.map((e) => e.event))}`,
        );
      }
    },
    closed,
    close: () => {
      req.destroy();
    },
  };
}
