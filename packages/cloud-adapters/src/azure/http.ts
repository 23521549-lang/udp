import { GatewayError, type GatewayErrorClass } from "../core/gateway.js";

/**
 * ARM REST qua `fetch` tiêm vào (Plan #26 review P3: không thư viện client).
 *
 * Mọi lỗi ra khỏi tệp này là `GatewayError` đã phân loại; thông báo chỉ gồm phương thức,
 * đường dẫn (không query) và mã lỗi của ARM — không bao giờ header `Authorization`.
 */

export type Fetch = typeof fetch;

export const ARM = "https://management.azure.com";

export interface AzureHttp {
  fetch: Fetch;
  accessToken: () => string;
}

interface ArmErrorBody {
  error?: { code?: string; message?: string };
}

/** Lỗi 409 mà chờ rồi làm lại thì qua: tài nguyên đang bận hoặc còn bị giữ */
const DEPENDENCY_CODES =
  /InUse|AnotherOperationInProgress|Retryable|ReferencedResourceNotProvisioned|PrincipalNotFound|OperationNotAllowed.*Provisioning/i;
/** Resource group/subscription không có là credential trỏ sai chỗ, không phải tài nguyên mất */
const CONFIGURATION_CODES =
  /^(ResourceGroupNotFound|SubscriptionNotFound|InvalidSubscriptionId|MissingSubscriptionRegistration)$/;

export function classifyArm(status: number, code: string): GatewayErrorClass {
  if (CONFIGURATION_CODES.test(code)) return "configuration";
  if (status === 404) return "not-found";
  if (status === 429 || /Quota|Throttl|TooManyRequests/i.test(code)) {
    return "throttled";
  }
  if (status === 401 || status === 403 || /Authorization/i.test(code)) {
    return "permission";
  }
  if (DEPENDENCY_CODES.test(code)) return "dependency";
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

/**
 * Một lời gọi ARM. `target` là đường dẫn ARM (`/subscriptions/...`) — gắn `api-version` —
 * hoặc một URL tuyệt đối ARM đã trả (`nextLink`, đã mang sẵn query).
 */
export async function armRequest<T>(
  http: AzureHttp,
  method: "GET" | "PUT" | "POST" | "DELETE",
  target: string,
  apiVersion: string | null,
  body?: unknown,
): Promise<T> {
  const url =
    apiVersion === null
      ? target
      : `${ARM}${target}${target.includes("?") ? "&" : "?"}api-version=${apiVersion}`;
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
      `${method} ${pathOf(url)}: không tới được ARM`,
    );
  }
  const json = parseBody(await res.text());
  if (!res.ok) {
    const code = (json as ArmErrorBody).error?.code ?? String(res.status);
    throw new GatewayError(
      classifyArm(res.status, code),
      `${method} ${pathOf(url)} ⇒ ${String(res.status)} ${code}`,
    );
  }
  return json as T;
}

/** `not-found` ⇒ `null`, cho describe */
export async function armGetOrNull<T>(
  http: AzureHttp,
  path: string,
  apiVersion: string,
): Promise<T | null> {
  try {
    return await armRequest<T>(http, "GET", path, apiVersion);
  } catch (e) {
    if (e instanceof GatewayError && e.errorClass === "not-found") return null;
    throw e;
  }
}

/** Đi HẾT `nextLink` — lỗi ở trang nào cũng là ném, không trả danh sách thiếu */
export async function armListAll<T>(
  http: AzureHttp,
  path: string,
  apiVersion: string,
): Promise<T[]> {
  const out: T[] = [];
  let page = await armRequest<{ value?: T[]; nextLink?: string }>(
    http,
    "GET",
    path,
    apiVersion,
  );
  out.push(...(page.value ?? []));
  while (page.nextLink !== undefined) {
    // Token Bearer chỉ được đi tới ARM: `nextLink` trỏ host khác là dữ liệu hỏng/độc
    if (!page.nextLink.startsWith(`${ARM}/`)) {
      throw new GatewayError("permanent", "nextLink của ARM trỏ ra ngoài ARM");
    }
    page = await armRequest(http, "GET", page.nextLink, null);
    out.push(...(page.value ?? []));
  }
  return out;
}
