import { ERROR_CATALOG, type ErrorCode } from "@udp/shared-types/problem";

/**
 * Dịch lỗi của Postgres thành mã nghiệp vụ trong `ERROR_CATALOG`.
 *
 * Vì sao ở tầng `@udp/db` chứ không ở HTTP handler: đây là nơi duy nhất biết về
 * Prisma và về hình dạng lỗi driver trả ra. Nếu để handler tự bóc, mỗi service
 * sẽ tự bóc một kiểu và cùng một SQLSTATE sẽ ra ba mã lỗi khác nhau. Tầng này
 * nói *lỗi này là gì*; tầng HTTP nói *trình bày ra sao*.
 *
 * Chiều phụ thuộc vẫn đúng: `db` → `shared-types` → `config`. Hàm này KHÔNG dựng
 * `AppError` vì lớp đó thuộc core-backend, và `db` không được biết tới service nào.
 */

/**
 * SQLSTATE do trigger của UDP tự định nghĩa.
 *
 * Postgres nhận mọi mã 5 ký tự alphanumeric; lớp `UD` không đụng lớp chuẩn nào
 * (`00`–`0Z`, `20`–`58`, `72`, `F0`, `HV`, `P0`, `XX`). Dùng mã máy đọc thay vì
 * so khớp nội dung thông báo: thông báo là để người đọc, không phải để code
 * so chuỗi — đổi một chữ trong `RAISE` không được phép làm gãy xử lý lỗi.
 *
 * HAI mã cho hai tình huống, không phải một. Chúng khác nhau ở chỗ quan trọng
 * nhất với người gọi — thử lại có ích hay không:
 *
 *   UDP01  Lưu rule trỏ variant lạ. Request SAI NỘI DUNG; gửi lại y nguyên vẫn
 *          hỏng. 422, không retryable.
 *   UDP02  Xoá variant còn được tham chiếu. Request ĐÚNG, nhưng trạng thái xung
 *          đột; gỡ rule đang trỏ tới nó rồi thử lại là được. 409, retryable.
 *
 * Gộp hai cái vào một mã sẽ làm mất đúng `retryable` và `suggestedAction` — hai
 * trường §9 sinh ra để Portal biết nên hiện nút gì.
 */
export const UDP_SQLSTATE = {
  /** §6.7 — rule hoặc default trỏ tới variant không hợp lệ */
  ORPHAN_RULE: "UDP01",
  /** §6.7 — xoá variant còn được rule tham chiếu */
  VARIANT_IN_USE: "UDP02",
} as const;

const SQLSTATE_TO_CODE: Readonly<Record<string, ErrorCode>> = {
  [UDP_SQLSTATE.ORPHAN_RULE]: "ORPHAN_RULE",
  [UDP_SQLSTATE.VARIANT_IN_USE]: "VARIANT_IN_USE",
};

/**
 * Mã lỗi của chính Prisma (không phải SQLSTATE) cũng là ràng buộc database.
 *
 * `P2002` là vi phạm UNIQUE. Nó tới dưới dạng `PrismaClientKnownRequestError`
 * với `code` ở cấp ngoài cùng, khác hẳn ba hình dạng SQLSTATE bên dưới — và
 * trước khi có nhánh này, mọi lần trùng khoá đều rơi xuống 500.
 */
const PRISMA_CODE_TO_CODE: Readonly<Record<string, ErrorCode>> = {
  P2002: "DUPLICATE_RESOURCE",
};

export interface DbConstraintError {
  code: ErrorCode;
  /**
   * Nguyên văn chuỗi `RAISE` của trigger, đã bỏ tiền tố mã.
   *
   * AN TOÀN để trả ra ngoài kể cả ở production: đây là câu do chính ta viết
   * trong migration, không phải message của Prisma hay của driver — nó không
   * mang đường dẫn file, tên bảng nội bộ hay chuỗi kết nối. Phân biệt được hai
   * thứ này là điều kiện để lỗi `fixableBy: "user"` thật sự sửa được: nói "rule
   * trỏ variant không tồn tại" mà không nói variant NÀO thì người dùng bế tắc.
   */
  detail: string;
}

interface PgLikeError {
  code?: unknown;
  message?: unknown;
  cause?: PgLikeError;
}

interface PrismaDriverError extends PgLikeError {
  meta?: { driverAdapterError?: PgLikeError };
}

/**
 * Bóc SQLSTATE và thông báo gốc ra khỏi lỗi.
 *
 * BA hình dạng, tuỳ đường lỗi đi ra — đã đo trên Prisma 7.10, không phải suy đoán:
 *
 *   1. Lệnh đơn qua Prisma → `PrismaClientKnownRequestError` mã `P2039`,
 *      SQLSTATE ở `meta.driverAdapterError.cause.code`.
 *   2. Lỗi phát sinh lúc **COMMIT** của `$transaction` → `DriverAdapterError`,
 *      `code` và `meta` đều `undefined`, SQLSTATE ở `cause.code`.
 *   3. `pg.Client` trực tiếp (test bất biến dùng đường này) → SQLSTATE phẳng.
 *
 * Hình dạng 2 KHÔNG phải trường hợp hiếm: constraint trigger `DEFERRABLE
 * INITIALLY DEFERRED` chỉ chạy lúc commit, nên **toàn bộ chiều xoá của §6.7 đi
 * qua đúng đường này**. Thiếu nhánh đó thì `VARIANT_IN_USE` không bao giờ tới
 * được tầng HTTP và người dùng nhận 500 cho một lỗi họ sửa được.
 */
function rawErrorOf(
  err: unknown,
): { state: string; message: string } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as PrismaDriverError;

  // Thứ tự: cụ thể trước, phẳng sau. Cấp ngoài cùng của một PrismaClientKnown-
  // RequestError mang `P2039` chứ không mang SQLSTATE, nên nó phải xét sau cùng.
  const candidates: PgLikeError[] = [
    e.meta?.driverAdapterError,
    e.meta?.driverAdapterError?.cause,
    e.cause,
    e,
  ].filter((c): c is PgLikeError => c != null);

  for (const candidate of candidates) {
    const state = candidate.code;
    if (typeof state === "string" && state in SQLSTATE_TO_CODE) {
      const message = candidate.message ?? candidate.cause?.message;
      return { state, message: typeof message === "string" ? message : "" };
    }
  }
  return undefined;
}

/** Bỏ tiền tố `MA_LOI: ` khỏi thông báo — mã đã nằm ở trường `code` rồi */
function stripCodePrefix(message: string, code: ErrorCode): string {
  const prefix = `${code}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

/**
 * Trả về mã nghiệp vụ và thông báo nếu lỗi là một ràng buộc của UDP.
 *
 * `undefined` nghĩa là "không nhận ra" — người gọi PHẢI xử lý như lỗi hệ thống
 * chứ đừng đoán. Đoán sai ở đây là biến một bug thành thông báo cho người dùng.
 */
export function dbConstraintError(err: unknown): DbConstraintError | undefined {
  const prisma = prismaConstraintError(err);
  if (prisma !== undefined) return prisma;

  const raw = rawErrorOf(err);
  if (raw === undefined) return undefined;

  const code = SQLSTATE_TO_CODE[raw.state];
  if (code === undefined) return undefined;

  return { code, detail: stripCodePrefix(raw.message, code) };
}

/**
 * Thông điệp DUY NHẤT của `P2028` có nghĩa là "quá tải".
 *
 * `P2028` là lớp cha `TransactionManagerError` của Prisma, và đã đọc thẳng runtime
 * 7.10: nó có BẢY lớp con. Chỉ một cái nói "không mở được transaction trong
 * `maxWait`" — tức pool đang cạn, và thử lại sau là đúng cách chữa. Sáu cái còn lại
 * là transaction không tồn tại, đã commit, đã rollback, hết `timeout`, lỗi nhất
 * quán nội bộ, mức cô lập sai: đều là bug hoặc chưa rõ. Ánh xạ cả họ sang 503
 * `retryable` là bảo người gọi thử lại một bug mãi mãi.
 *
 * Khớp theo thông điệp là mong manh — Prisma đổi câu chữ thì nhánh này im lặng
 * trượt về 500. Vì vậy có một test làm CẠN POOL THẬT (`db-errors.test.ts`): đổi
 * câu chữ thì test đó đỏ, không phải hệ thống.
 *
 * `P2024` KHÔNG có ở đây dù tài liệu Prisma cũ gọi nó là lỗi hết giờ chờ pool: đã
 * grep runtime 7.10 của `@prisma/client` lẫn `adapter-pg`, chuỗi đó không tồn tại
 * trên đường truy vấn — chỉ còn trong schema engine của migrate.
 */
const POOL_EXHAUSTED = "Unable to start a transaction in the given time";

export interface DbAvailabilityError {
  code: "PROVIDER_UNAVAILABLE";
  detail: string;
}

/**
 * Database không phục vụ được lúc này — khác hẳn một ràng buộc bị vi phạm.
 *
 * Tách khỏi `dbConstraintError` vì hai nhánh khác nhau ở mọi trục mà tầng HTTP
 * quan tâm: ràng buộc là lỗi NGƯỜI DÙNG sửa được (log `warn`, `detail` nói rõ
 * sai chỗ nào), còn cạn pool là lỗi VẬN HÀNH (log `error` để cảnh báo, người
 * dùng chỉ cần biết thử lại sau). Gộp chung một hàm là để tên hàm nói dối.
 */
export function dbAvailabilityError(
  err: unknown,
): DbAvailabilityError | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code !== "P2028" || typeof e.message !== "string") return undefined;
  if (!e.message.includes(POOL_EXHAUSTED)) return undefined;

  return {
    code: "PROVIDER_UNAVAILABLE",
    detail: "Hệ thống đang quá tải, vui lòng thử lại sau",
  };
}

/**
 * Nhận diện lỗi ràng buộc do chính Prisma báo, trước khi xét SQLSTATE.
 *
 * `detail` chỉ nêu TÊN TRƯỜNG bị trùng, lấy từ `meta.target`. Tên trường vốn là
 * một phần hợp đồng API nên không phải thông tin nội bộ — khác hẳn message thô
 * của Prisma, thứ mang cả tên bảng và câu SQL.
 */
function prismaConstraintError(err: unknown): DbConstraintError | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; meta?: { target?: unknown } };
  if (typeof e.code !== "string") return undefined;

  const code = PRISMA_CODE_TO_CODE[e.code];
  if (code === undefined) return undefined;

  const target = e.meta?.target;
  const fields = Array.isArray(target)
    ? target.filter((t): t is string => typeof t === "string")
    : typeof target === "string"
      ? [target]
      : [];

  return {
    code,
    detail:
      fields.length > 0
        ? `Đã tồn tại bản ghi với ${fields.join(", ")}`
        : "Đã tồn tại",
  };
}

/** HTTP status ứng với mã, lấy thẳng từ catalog để không có bảng thứ hai */
export function httpStatusOf(code: ErrorCode): number {
  return ERROR_CATALOG[code].httpStatus;
}
