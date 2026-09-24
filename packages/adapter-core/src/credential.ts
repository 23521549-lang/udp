/**
 * [v4.10] Credential đã sẵn sàng dùng, và cái bọc giữ nó (§4.1, §4.3).
 *
 * Vì sao hai kiểu này ở `@udp/adapter-core` mà không ở `@udp/shared-types`: chú
 * thích ở `shared-types/src/index.ts` đã nói trước — `ResolvedCredential` **không
 * phải type thuần**, nó có `dispose()` và bị cấm serialize (I12, I24), nên đặt vào
 * một package "chỉ có type" là mất chính hợp đồng đó.
 */

/** Ba nhà cung cấp; trùng enum `CloudProvider` của database (§2.2) */
export type CloudProvider = "aws" | "gcp" | "azure";

/** BYOC: credential của khách. MANAGED: identity mặc định của chính platform */
export type CredentialMode = "BYOC" | "MANAGED";

/**
 * Sáu cách xác thực, khớp enum `CloudAuthKind` của database.
 *
 * Ba họ FEDERATED (`*_ROLE`, `*_WIF`, `*_FEDERATED`) là mặc định khuyến nghị; ba họ
 * còn lại là khoá dài hạn, và Portal hiển thị cảnh báo thường trực cho chúng.
 */
export type CloudAuthKind =
  | "AWS_ROLE"
  | "AWS_KEY"
  | "GCP_WIF"
  | "GCP_KEY"
  | "AZURE_FEDERATED"
  | "AZURE_SECRET";

/** Bên gọi không được phép biến secret thành chuỗi — mọi đường đều ném mã này */
export const SECRET_TO_STRING_FORBIDDEN = "SECRET_TO_STRING_FORBIDDEN";
/** Dùng credential sau `dispose()` — ném tường minh, KHÔNG âm thầm thành công */
export const CREDENTIAL_DISPOSED = "CREDENTIAL_DISPOSED";

/**
 * Bọc một secret trong `Buffer` và bịt mọi đường nó rò ra ngoài dưới dạng chuỗi.
 *
 * Bốn móc dưới đây đã được **đo thật** trước khi viết (R24-8), không phải giả định:
 *
 * | Đường | Hành vi |
 * | --- | --- |
 * | `JSON.stringify(obj)` với secret lồng 4 cấp | gọi `toJSON()` ⇒ `"[REDACTED]"` |
 * | `util.inspect(obj, { depth: null })` | tôn trọng symbol ⇒ `[REDACTED]` |
 * | `String(s)`, `` `${s}` ``, `"x" + s` | cả ba gọi `toString()` ⇒ **ném** |
 * | `dispose()` rồi `use()` | ném `CREDENTIAL_DISPOSED` |
 *
 * `#buf` là private THẬT của class (không phải `private` của TypeScript, thứ chỉ tồn
 * tại lúc biên dịch), nên không ai đọc được nó qua một phép ép kiểu.
 *
 * Giới hạn trung thực, ghi ở §16: `buffer.fill(0)` xoá được bản trong buffer, nhưng
 * bất kỳ `toString()` trung gian nào cũng để lại một bản sao string bất biến cho GC.
 * Đó là lý do `toString()` ở đây **ném** thay vì trả `"[REDACTED]"`: một giá trị trả
 * về hợp lệ sẽ làm lỗi đó im lặng.
 */
export class SecretBuffer {
  readonly #buf: Buffer;
  #disposed = false;

  constructor(secret: Buffer | string) {
    this.#buf =
      typeof secret === "string" ? Buffer.from(secret, "utf8") : secret;
  }

  /**
   * Đường DUY NHẤT đọc được plaintext, và nó có phạm vi.
   *
   * Trả về kết quả của `fn`, không trả buffer ra ngoài: một getter trả buffer là mời
   * bên gọi giữ tham chiếu sống lâu hơn `dispose()`.
   */
  use<T>(fn: (secret: Buffer) => T): T {
    if (this.#disposed) throw new Error(CREDENTIAL_DISPOSED);
    return fn(this.#buf);
  }

  /** Số byte — đọc được mà không chạm nội dung, dùng cho log và phép kiểm */
  get byteLength(): number {
    return this.#buf.byteLength;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    this.#buf.fill(0);
    this.#disposed = true;
  }

  /** Chỉ dùng trong test: khẳng định `dispose()` thật sự xoá */
  everyByteIsZero(): boolean {
    return this.#buf.every((b) => b === 0);
  }

  toString(): never {
    throw new Error(SECRET_TO_STRING_FORBIDDEN);
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[REDACTED]";
  }
}

/**
 * Credential NGẮN HẠN đã sẵn sàng dùng với SDK cloud (§4.1).
 *
 * Với họ FEDERATED đây là kết quả của AssumeRole / WIF / federated token exchange,
 * sống ≤ 1 giờ; với họ STATIC là bản giải mã của khoá dài hạn, sống tối đa 15 phút.
 */
export interface ResolvedCredential {
  provider: CloudProvider;
  mode: CredentialMode;
  authKind: CloudAuthKind;
  /** Payload đã sẵn sàng; chỉ đọc được qua `payload.use(...)` */
  payload: SecretBuffer;
  /** Thời điểm bản này hết hạn (token cloud) hoặc phải bị huỷ (mặc định 15 phút với STATIC) */
  expiresAt: Date;
  dispose(): void;
}
