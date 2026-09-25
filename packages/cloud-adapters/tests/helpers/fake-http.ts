/**
 * Cloud giả ở tầng HTTP cho test gateway/credential (Google, ARM, Entra ID): bảng
 * `"METHOD đường-dẫn"` ⇒ hàng đợi phản hồi. Mỗi lời gọi lấy phản hồi đầu hàng đợi (phản hồi cuối được giữ lại để lặp); lời gọi
 * không có trong bảng là lỗi của test, không phải 404 im lặng.
 */
export interface FakeReply {
  status?: number;
  body?: unknown;
  /** Thân thô (không JSON) — mô phỏng trang lỗi HTML của proxy */
  raw?: string;
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export function fakeHttp(routes: Record<string, FakeReply | FakeReply[]>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const queues = new Map(
    Object.entries(routes).map(([k, v]) => [
      k,
      Array.isArray(v) ? [...v] : [v],
    ]),
  );
  const calls: RecordedCall[] = [];
  const fetchImpl = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    const path = url.split("?")[0] ?? url;
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      method,
      url,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: bodyText === undefined ? undefined : parse(bodyText),
    });
    const queue = queues.get(`${method} ${path}`);
    const reply = queue?.length === 1 ? queue[0] : queue?.shift();
    if (reply === undefined) {
      return Promise.reject(
        new Error(`HTTP giả: không có route ${method} ${path}`),
      );
    }
    const text =
      reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return Promise.resolve(new Response(text, { status: reply.status ?? 200 }));
  };
  return { fetch: fetchImpl, calls };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
