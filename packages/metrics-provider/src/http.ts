/**
 * Một lời gọi HTTP có hạn chờ — dùng chung cho mọi nguồn metrics (§5.4).
 *
 * Mọi lỗi (mạng, mã ≠ 2xx, quá hạn) về `undefined`: bên gọi phân biệt "không hỏi được"
 * (`queryFailed`) với "hỏi được mà rỗng" (`hasData: false`), không phân biệt vì sao hỏng.
 *
 * Hạn chờ do CHÍNH hàm này giữ (`Promise.race`), không chỉ nhờ `signal`: một `fetch` tiêm
 * vào hay một proxy không tôn trọng `AbortSignal` vẫn không được giữ vòng reconciliation
 * treo quá `timeoutMs` — lease 60 giây sẽ hết và worker khác giẫm lên. Signal vẫn gửi đi để
 * bên có tôn trọng thì huỷ được kết nối thật.
 */
export async function timedRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<string | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  const request = (async (): Promise<string | undefined> => {
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!res.ok) return undefined;
      return await res.text();
    } catch {
      return undefined;
    }
  })();
  try {
    return await Promise.race([request, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** JSON hỏng ⇒ `undefined` — cùng một nhánh với "không hỏi được" */
export function parseJson<T>(body: string | undefined): T | undefined {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}
