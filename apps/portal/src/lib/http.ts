import type { ProblemDetails } from "@udp/shared-types/problem";
import type { ZodType } from "zod";

/**
 * Lớp HTTP DUY NHẤT của Portal (§10.4, §10.10).
 *
 * Ba việc mà mọi lời gọi phải có, nên chúng sống ở đây chứ không ở từng hook:
 *
 * 1. **CSRF + X-Request-ID.** Cookie `udp_csrf` (không httpOnly) được đọc và gửi lại ở
 *    header cho mọi lệnh ghi. Thiếu nó thì mọi POST nhận 403 `csrf-invalid`.
 * 2. **Refresh đúng một lần, cho mọi tab.** `refresh()` của Service 1 có phát hiện dùng
 *    lại token: trình một refresh token ĐÃ xoay là `revokeFamily` ⇒ đăng xuất MỌI tab.
 *    Nên single-flight trong một tab là chưa đủ: hai tab cùng gặp 401 sẽ cùng trình
 *    cookie cũ. Khoá giữa các tab bằng Web Locks, và bên trong khoá kiểm xem tab khác
 *    đã refresh XONG sau khi request của mình bắt đầu chưa — rồi thì chỉ gửi lại, không
 *    refresh lần hai. Trình duyệt không có Web Locks: còn hở, ghi ở sổ nợ
 *    `portal-refresh-lock`.
 * 3. **Parse response bằng schema dây.** Response lệch hình là `ApiError` kind
 *    `contract`, không phải một object sai kiểu trôi vào component.
 */

export const API_BASE = "/api/v1";
const CSRF_COOKIE = "udp_csrf";
const CSRF_HEADER = "X-CSRF-Token";
const REFRESH_LOCK = "udp-auth-refresh";
/** Chỉ một mốc thời gian — không phải dữ liệu người dùng hay token (§10.4) */
const REFRESHED_AT_KEY = "udp_refreshed_at";

export type ApiErrorKind = "http" | "network" | "contract";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    readonly problem: ProblemDetails | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get code(): string | undefined {
    return this.problem?.code;
  }

  get traceId(): string | undefined {
    return this.problem?.traceId;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

// ------------------------------------------------------------- phiên hết hạn

type ExpiredHandler = () => void;
let onSessionExpired: ExpiredHandler = () => undefined;

/** Auth đăng ký hành vi "phiên hết hạn" — lớp HTTP không biết router hay store */
export function setSessionExpiredHandler(handler: ExpiredHandler): void {
  onSessionExpired = handler;
}

// ------------------------------------------------------------- refresh

const nowMs = (): number => Date.now();

function readRefreshedAt(): number {
  try {
    return Number(localStorage.getItem(REFRESHED_AT_KEY) ?? "0");
  } catch {
    return 0;
  }
}

function markRefreshed(): void {
  try {
    localStorage.setItem(REFRESHED_AT_KEY, String(nowMs()));
  } catch {
    // Chế độ riêng tư chặn storage: chỉ mất tối ưu giữa tab, không mất tính đúng
  }
}

async function postRefresh(): Promise<boolean> {
  try {
    const res = await fetch(urlOf("/auth/refresh", undefined), {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Request-ID": crypto.randomUUID() },
    });
    if (res.ok) markRefreshed();
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------- khoá giữa tab khi KHÔNG có Web Locks (sổ nợ đã trả: portal-refresh-lock)

const LEASE_KEY = "udp_refresh_lease";
/** Lâu hơn một lượt refresh bình thường; tab chết giữa chừng thì lease tự hết hạn */
export const LEASE_MS = 8_000;
/** Chờ các tab cùng ghi lease lắng xuống rồi đọc lại xem ai thắng */
const SETTLE_MS = 40;
const POLL_MS = 60;

interface Lease {
  owner: string;
  expiresAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readLease(): Lease | null {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<Lease>;
    return typeof v.owner === "string" && typeof v.expiresAt === "number"
      ? { owner: v.owner, expiresAt: v.expiresAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * Lease trong localStorage — thay Web Locks ở trình duyệt không có nó.
 *
 * localStorage không có compare-and-set, nên "ghi rồi chờ lắng rồi đọc lại": hai tab cùng
 * ghi thì chỉ bản ghi sau còn lại, và chỉ chủ của bản đó chạy. Tab thua chờ; trong lúc
 * chờ, nếu tab thắng refresh xong (`udp_refreshed_at` mới hơn mốc request) thì `run` của
 * tab thua thấy điều đó và KHÔNG refresh lần hai. Lease chỉ chứa một id ngẫu nhiên và một
 * mốc hết hạn — không dữ liệu người dùng, không token (§10.4).
 *
 * Giới hạn còn lại, nói thẳng: nếu storage bị chặn (chế độ riêng tư của vài trình duyệt)
 * thì không có kênh chung nào giữa tab, và ca hai tab cùng refresh còn hở như trước.
 */
async function withStorageLease(run: () => Promise<boolean>): Promise<boolean> {
  const me = crypto.randomUUID();
  const giveUpAt = nowMs() + LEASE_MS * 2;
  while (nowMs() < giveUpAt) {
    const current = readLease();
    if (current === null || current.expiresAt < nowMs()) {
      try {
        localStorage.setItem(
          LEASE_KEY,
          JSON.stringify({ owner: me, expiresAt: nowMs() + LEASE_MS }),
        );
      } catch {
        return run();
      }
      await sleep(SETTLE_MS);
      if (readLease()?.owner === me) {
        try {
          return await run();
        } finally {
          if (readLease()?.owner === me) localStorage.removeItem(LEASE_KEY);
        }
      }
    }
    await sleep(POLL_MS);
  }
  return run();
}

/**
 * Bộ refresh của MỘT tab. Tách thành factory để test dựng được hai "tab" độc lập (mỗi
 * tab một single-flight riêng) trên cùng một localStorage — đúng tình huống cần kiểm.
 */
export function createRefresher(
  lockApi: () => LockManager | undefined = () =>
    typeof navigator === "undefined" ? undefined : navigator.locks,
): (startedAt: number) => Promise<boolean> {
  let inFlight: Promise<boolean> | undefined;
  return (startedAt) => {
    if (inFlight !== undefined) return inFlight;

    const run = async (): Promise<boolean> => {
      if (readRefreshedAt() > startedAt) return true;
      return postRefresh();
    };

    const locks = lockApi();
    // Kiểu DOM khai `request` trả Promise<Promise<T>>; lúc chạy nó đã được làm phẳng
    const locked: Promise<boolean> =
      locks === undefined
        ? withStorageLease(run)
        : locks.request(REFRESH_LOCK, run).then((v) => v);
    const out = locked.finally(() => {
      inFlight = undefined;
    });
    inFlight = out;
    return out;
  };
}

/**
 * Refresh phiên — MỘT lần cho mọi request đang chờ trong tab này, và dưới khoá giữa các
 * tab (Web Locks; không có thì lease localStorage).
 *
 * `startedAt`: mốc request gốc được gửi. Nếu tab khác refresh xong SAU mốc đó thì cookie
 * mới đã có, request gốc chỉ cần gửi lại — refresh lần nữa là trình cookie đã xoay và
 * tự đăng xuất mọi tab.
 */
export const refreshSession = createRefresher();

// ------------------------------------------------------------- request

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** §9: sinh TẠI LÚC BẤM GỬI (trong `mutationFn`), không phải lúc dựng hook */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Đường auth không được tự refresh: 401 ở đó là câu trả lời, không phải phiên cũ */
const NO_REFRESH = new Set(["/auth/login", "/auth/register", "/auth/refresh"]);

function urlOf(path: string, query: RequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  // Tuyệt đối theo origin của trang: cùng kết quả trong trình duyệt, và `fetch` của Node
  // (môi trường test) không nhận URL tương đối
  return new URL(
    `${API_BASE}${path}${qs === "" ? "" : `?${qs}`}`,
    window.location.origin,
  ).toString();
}

function headersOf(opts: RequestOptions): Headers {
  const headers = new Headers({ "X-Request-ID": crypto.randomUUID() });
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  if ((opts.method ?? "GET") !== "GET") {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== undefined) headers.set(CSRF_HEADER, csrf);
  }
  if (opts.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", opts.idempotencyKey);
  }
  return headers;
}

async function problemOf(res: Response): Promise<ProblemDetails | undefined> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) return undefined;
  try {
    const body = (await res.json()) as Partial<ProblemDetails>;
    return typeof body.title === "string" && typeof body.status === "number"
      ? (body as ProblemDetails)
      : undefined;
  } catch {
    return undefined;
  }
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  try {
    return await fetch(urlOf(path, opts.query), {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: headersOf(opts),
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError("network", 0, undefined, "Mất kết nối tới máy chủ");
  }
}

/**
 * Gọi API và parse response bằng `schema`. `schema = null` cho response không thân
 * (204): trả `undefined`.
 */
export async function api<T>(
  schema: ZodType<T>,
  path: string,
  opts?: RequestOptions,
): Promise<T>;
export async function api(
  schema: null,
  path: string,
  opts?: RequestOptions,
): Promise<undefined>;
export async function api<T>(
  schema: ZodType<T> | null,
  path: string,
  opts: RequestOptions = {},
): Promise<T | undefined> {
  const startedAt = nowMs();
  let res = await send(path, opts);

  if (res.status === 401 && !NO_REFRESH.has(path)) {
    if (await refreshSession(startedAt)) {
      res = await send(path, opts);
    }
    if (res.status === 401) {
      onSessionExpired();
    }
  }

  if (!res.ok) {
    const problem = await problemOf(res);
    throw new ApiError(
      "http",
      res.status,
      problem,
      problem?.detail ?? problem?.title ?? `HTTP ${String(res.status)}`,
    );
  }

  if (schema === null || res.status === 204) return undefined;

  const json: unknown = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.join(".") || "(gốc)")
      .join(", ");
    throw new ApiError(
      "contract",
      res.status,
      undefined,
      `Phản hồi của máy chủ không đúng hợp đồng (${where})`,
    );
  }
  return parsed.data;
}
