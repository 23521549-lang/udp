import { execFileSync } from "node:child_process";
import { get, type ClientRequest } from "node:http";
import { COOKIE_NAMES, CSRF_HEADER } from "@udp/config/constants";
import { SEED_DEV_PASSWORD, SEED_OWNER_EMAIL } from "@udp/db/seed-constants";
import { HOST_PORTS, KUBE_CONTEXT } from "../src/cluster.js";

/**
 * Công cụ của E2E rút gọn (Plan #50): nói chuyện với cụm kind ĐÚNG như người dùng và SDK — Portal qua
 * nginx, Service 2 qua NodePort, Prometheus qua proxy của API server (không port-forward nào phải dọn).
 */

export const PORTAL = `http://127.0.0.1:${String(HOST_PORTS.portal)}`;
export const FLAG_SERVICE = `http://127.0.0.1:${String(HOST_PORTS.flagService)}`;

export interface Session {
  cookie: string;
  csrf: string;
}

/** Đăng nhập QUA proxy `/api` của Portal — cookie phiên và token CSRF như trình duyệt nhận */
export async function login(): Promise<Session> {
  const res = await fetch(`${PORTAL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: SEED_OWNER_EMAIL,
      password: SEED_DEV_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`đăng nhập → ${String(res.status)}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");
  const csrf = cookies
    .find((c) => c.startsWith(`${COOKIE_NAMES.csrfToken}=`))
    ?.slice(COOKIE_NAMES.csrfToken.length + 1);
  if (csrf === undefined) throw new Error("đăng nhập không đặt cookie CSRF");
  return { cookie: cookies.join("; "), csrf };
}

export interface Reply<T> {
  status: number;
  body: T;
}

/** Gọi API của Service 1 qua Portal; body lỗi vẫn trả về để assert in ra được */
export async function api<T>(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  const res = await fetch(`${PORTAL}/api/v1${path}`, {
    method,
    headers: {
      Cookie: session.cookie,
      [CSRF_HEADER]: session.csrf,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text === "" ? undefined : JSON.parse(text)) as T,
  };
}

export interface SseEvent {
  id?: number;
  event?: string;
  data?: string;
}

/** Một stream `/sdk/stream` đang mở: gom event, chờ event thoả điều kiện */
export interface SseStream {
  status: Promise<number>;
  events: SseEvent[];
  waitFor(
    match: (e: SseEvent) => boolean,
    timeoutMs: number,
  ): Promise<SseEvent>;
  close(): void;
}

/** Tách một khối SSE (giữa hai dòng trống) thành event; khối chỉ có chú thích/`retry:` ⇒ `null` */
export function parseSseBlock(block: string): SseEvent | null {
  const event: SseEvent = {};
  for (const line of block.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const field = line.slice(0, at);
    const value = line.slice(at + 1).replace(/^ /, "");
    if (field === "id") event.id = Number(value);
    else if (field === "event") event.event = value;
    else if (field === "data") event.data = value;
  }
  return event.event === undefined ? null : event;
}

export function openStream(sdkKey: string): SseStream {
  const events: SseEvent[] = [];
  let request: ClientRequest | undefined;
  const status = new Promise<number>((resolveStatus, reject) => {
    request = get(
      `${FLAG_SERVICE}/sdk/stream`,
      {
        headers: {
          Authorization: `Bearer ${sdkKey}`,
          Accept: "text/event-stream",
        },
      },
      (res) => {
        resolveStatus(res.statusCode ?? 0);
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            const parsed = parseSseBlock(buffer.slice(0, end));
            if (parsed !== null) events.push(parsed);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
          }
        });
      },
    );
    request.on("error", reject);
  });
  return {
    status,
    events,
    async waitFor(match, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(match);
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `không có event khớp sau ${String(timeoutMs)} ms; đã nhận: ${events.map((e) => `${e.event ?? ""}#${String(e.id)}`).join(", ")}`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    close() {
      request?.destroy();
    },
  };
}

/** Truy vấn tức thời Prometheus TRONG cụm qua proxy dịch vụ của API server */
export function promQuery(
  namespace: string,
  query: string,
): { metric: Record<string, string>; value: [number, string] }[] {
  const raw = execFileSync(
    "kubectl",
    [
      "--context",
      KUBE_CONTEXT,
      "get",
      "--raw",
      `/api/v1/namespaces/${namespace}/services/prometheus:9090/proxy/api/v1/query?query=${encodeURIComponent(query)}`,
    ],
    { encoding: "utf8" },
  );
  return (
    JSON.parse(raw) as {
      data: {
        result: { metric: Record<string, string>; value: [number, string] }[];
      };
    }
  ).data.result;
}

/** Thử lại tới khi `check` trả khác `undefined` hoặc hết hạn */
export async function eventually<T>(
  check: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`${what}: chưa thấy sau ${String(timeoutMs)} ms`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
