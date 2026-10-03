/**
 * LRU có trần cho kết quả bulk của OFREP (ADR-03: "cache kết quả theo
 * (configVersion, hash(context))") [v4.6].
 *
 * Khoá do NGƯỜI LẠ quyết định — context tuỳ ý, gửi bằng khoá CLIENT công khai —
 * nên cache có HAI trần: số mục, và tổng BYTE (một mục là kết quả của mọi flag
 * trong project, nên kích thước mục không bị chặn bởi số mục). Giữ body ĐÃ tuần
 * tự hoá: đo được byte thật, và gửi lại không tốn một lượt `JSON.stringify`.
 * `Map` giữ thứ tự chèn: lấy ra rồi chèn lại là "vừa dùng".
 */
export interface ResultCache {
  get(key: string): string | undefined;
  set(key: string, body: string): void;
  readonly size: number;
  readonly bytes: number;
}

export function createResultCache(limits: {
  maxEntries: number;
  maxBytes: number;
}): ResultCache {
  const entries = new Map<string, string>();
  let bytes = 0;
  const sizeOf = (body: string): number => Buffer.byteLength(body);
  const drop = (key: string): void => {
    const body = entries.get(key);
    if (body === undefined) return;
    entries.delete(key);
    bytes -= sizeOf(body);
  };
  return {
    get(key) {
      const body = entries.get(key);
      if (body === undefined) return undefined;
      entries.delete(key);
      entries.set(key, body);
      return body;
    },
    set(key, body) {
      drop(key);
      // Một mục lớn hơn cả trần thì không giữ — giữ nó là đẩy mọi thứ khác ra
      if (sizeOf(body) > limits.maxBytes) return;
      entries.set(key, body);
      bytes += sizeOf(body);
      while (entries.size > limits.maxEntries || bytes > limits.maxBytes) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        drop(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}
