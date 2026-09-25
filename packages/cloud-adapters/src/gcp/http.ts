import { GatewayError, type GatewayErrorClass } from "../core/gateway.js";

/**
 * REST của Google Cloud qua `fetch` tiêm vào (Plan #26 review P3: không thư viện client).
 *
 * Mọi lỗi ra khỏi tệp này là `GatewayError` đã phân loại; thông báo chỉ gồm phương thức,
 * đường dẫn (không query) và mã lỗi của Google — không bao giờ header `Authorization`.
 */

export type Fetch = typeof fetch;

export interface GcpHttp {
  fetch: Fetch;
  accessToken: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: { reason?: string }[];
  };
}

const THROTTLE_REASONS = [
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
];
const DEPENDENCY_REASONS = [
  "resourceInUseByAnotherResource",
  "resourceNotReady",
];

export function classifyGoogle(
  status: number,
  body: GoogleErrorBody,
): GatewayErrorClass {
  const reasons = (body.error?.errors ?? []).map((e) => e.reason ?? "");
  if (status === 404) return "not-found";
  if (status === 429 || reasons.some((r) => THROTTLE_REASONS.includes(r)))
    return "throttled";
  if (reasons.some((r) => DEPENDENCY_REASONS.includes(r))) return "dependency";
  if (status === 400 && body.error?.status === "FAILED_PRECONDITION")
    return "dependency";
  if (status === 401 || status === 403) return "permission";
  if (status >= 500) return "transient";
  return "permanent";
}

const pathOf = (url: string): string => url.split("?")[0] ?? url;

/** Body không phải JSON (trang HTML 502 của proxy) ⇒ `{}`, không để `SyntaxError` thoát ra */
function parseBody(text: string): unknown {
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export async function gcpRequest<T>(
  http: GcpHttp,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await http.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${http.accessToken()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new GatewayError(
      "transient",
      `${method} ${pathOf(url)}: không tới được Google`,
    );
  }
  const text = await res.text();
  const json = parseBody(text);
  if (!res.ok) {
    const b = json as GoogleErrorBody;
    const reason =
      b.error?.errors?.[0]?.reason ?? b.error?.status ?? String(res.status);
    throw new GatewayError(
      classifyGoogle(res.status, b),
      `${method} ${pathOf(url)} ⇒ ${String(res.status)} ${reason}`,
    );
  }
  return json as T;
}

/** `not-found` ⇒ `null`, cho describe */
export async function gcpGetOrNull<T>(
  http: GcpHttp,
  url: string,
): Promise<T | null> {
  try {
    return await gcpRequest<T>(http, "GET", url);
  } catch (e) {
    if (e instanceof GatewayError && e.errorClass === "not-found") return null;
    throw e;
  }
}

export interface GcpOperation {
  name?: string;
  status?: string;
  selfLink?: string;
  error?: { errors?: { code?: string; message?: string }[] };
}

/**
 * Chờ một operation của Compute/IAM tới `DONE`, rồi đọc lỗi CỦA OPERATION (quota, tên
 * trùng…) — lỗi đó không có ở response tạo, và bỏ qua nó là tưởng đã tạo xong.
 */
export async function waitOperation(
  http: GcpHttp,
  op: GcpOperation,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<void> {
  const deadline = http.now() + timeoutMs;
  let current = op;
  while (current.status !== "DONE") {
    if (current.selfLink === undefined) {
      throw new GatewayError(
        "transient",
        "operation của Google không có selfLink",
      );
    }
    if (http.now() >= deadline) {
      throw new GatewayError(
        "transient",
        `operation ${current.name ?? "?"} chưa xong`,
      );
    }
    await http.sleep(intervalMs);
    current = await gcpRequest<GcpOperation>(http, "GET", current.selfLink);
  }
  const first = current.error?.errors?.[0];
  if (first !== undefined) {
    const code = first.code ?? "UNKNOWN";
    const errorClass: GatewayErrorClass = /QUOTA|RATE_LIMIT/.test(code)
      ? "throttled"
      : /NOT_FOUND/.test(code)
        ? "not-found"
        : /IN_USE|NOT_READY/.test(code)
          ? "dependency"
          : "permanent";
    throw new GatewayError(
      errorClass,
      `operation ${current.name ?? "?"} lỗi ${code}`,
    );
  }
}
