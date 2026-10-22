import { GatewayError, type GatewayErrorClass } from "../core/gateway.js";

/**
 * Phân loại lỗi AWS SDK v3 rồi BỎ lỗi gốc (Plan #26 QĐ-2): SDK v3 mang credential ở
 * `err.config`/`err.$metadata`, nên chỉ `name` và mã HTTP được đọc — không field nào khác
 * của lỗi đi tiếp.
 */
const BY_NAME: [RegExp, GatewayErrorClass][] = [
  [
    /NotFound|NoSuchEntity|ResourceNotFoundException|InvalidAllocationID\.NotFound/,
    "not-found",
  ],
  [/Throttl|RequestLimitExceeded|TooManyRequests|SlowDown/, "throttled"],
  [
    /DependencyViolation|ResourceInUse|DeleteConflict|InvalidIPAddress\.InUse/,
    "dependency",
  ],
  [
    /AccessDenied|UnauthorizedOperation|InvalidClientTokenId|ExpiredToken|AuthFailure|SignatureDoesNotMatch|UnrecognizedClient/,
    "permission",
  ],
  [
    /InternalError|InternalFailure|ServiceUnavailable|ServerException|RequestTimeout/,
    "transient",
  ],
];

export function classifyAwsError(e: unknown): GatewayError {
  if (e instanceof GatewayError) return e;
  const err = e as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof err.name === "string" ? err.name : "Error";
  const status =
    typeof err.$metadata?.httpStatusCode === "number"
      ? err.$metadata.httpStatusCode
      : undefined;
  const byName = BY_NAME.find(([re]) => re.test(name))?.[1];
  const errorClass: GatewayErrorClass =
    byName ??
    (status === undefined
      ? "transient" // lỗi mạng không có response: thử lại được
      : status >= 500
        ? "transient"
        : status === 429
          ? "throttled"
          : status === 401 || status === 403
            ? "permission"
            : status === 404
              ? "not-found"
              : "permanent");
  return new GatewayError(
    errorClass,
    `AWS trả ${name}${status === undefined ? "" : ` (${String(status)})`}`,
  );
}

/** Chạy một lời gọi AWS, mọi lỗi ra ngoài đều đã phân loại và làm sạch */
export async function aws<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw classifyAwsError(e);
  }
}

/** Như `aws()`, nhưng `not-found` ⇒ `null` — cho describe */
export async function awsOrNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await aws(call);
  } catch (e) {
    if (e instanceof GatewayError && e.errorClass === "not-found") return null;
    throw e;
  }
}
