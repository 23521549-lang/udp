import { registerAuthAdminRoutes } from "./handlers/auth-admin";
import { registerDashboardRoutes } from "./handlers/dashboards";
import { registerDeliveryRoutes } from "./handlers/delivery";
import { registerFlagRoutes } from "./handlers/flag";
import { registerPlatformRoutes } from "./handlers/platform";
import { registerProjectRoutes } from "./handlers/project";
import { registerTeamRoutes } from "./handlers/team";
import { advance } from "./live";
import { DEFAULT_SETUP, storedSetup, type DemoSetup } from "./persona";
import { HttpProblem, problemBody, Router, type Reply } from "./router";
import { createDb } from "./seed";

/**
 * Lớp giả lập backend của bản xem thử: chặn `fetch` tới `/api/v1` và trả lời từ "database" trong trang; thay
 * `EventSource` bằng một luồng mở mà im lặng (Portal đã poll mọi màn hình "đang chạy", SSE chỉ làm mới sớm hơn).
 * Mọi request khác (font, tệp tĩnh) đi thẳng như thường.
 */

export const API_PREFIX = "/api/v1";

/** Độ trễ giả của mạng — đủ để thấy trạng thái đang tải, không đủ để chờ */
const LATENCY_MS = { min: 60, max: 220 };

const json = (status: number, body: unknown, problem = false): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": problem ? "application/problem+json" : "application/json",
    },
  });

function toResponse(reply: Reply): Response {
  if (reply.status === 204 || reply.body === undefined) {
    return new Response(null, {
      status: reply.status === 200 ? 204 : reply.status,
    });
  }
  return json(reply.status, reply.body);
}

export interface MockBackend {
  /** Gọi một route như Portal gọi — test hợp đồng dùng thẳng, không qua `window.fetch` */
  handle(method: string, url: URL, body: unknown): Response;
}

export function createMockBackend(
  setup: DemoSetup = DEFAULT_SETUP,
): MockBackend {
  const db = createDb(setup);
  const router = new Router();
  registerAuthAdminRoutes(router, db);
  registerProjectRoutes(router, db);
  registerFlagRoutes(router, db);
  registerDeliveryRoutes(router, db);
  registerPlatformRoutes(router, db);
  registerDashboardRoutes(router, db);
  registerTeamRoutes(router, db);
  return {
    handle(method, url, body) {
      const path = url.pathname.slice(API_PREFIX.length);
      advance(db);
      try {
        // Như `requirePlatformAdmin` của Service 1: người thường không đọc được khu quản trị
        if (
          path.startsWith("/admin/") &&
          db.me.platformRole !== "PLATFORM_ADMIN"
        ) {
          throw new HttpProblem(
            403,
            "FORBIDDEN",
            "Chỉ quản trị viên nền tảng xem được khu này",
          );
        }
        const reply = router.handle({
          method,
          path,
          query: url.searchParams,
          body,
        });
        if (reply === null) {
          return json(
            404,
            problemBody(
              404,
              "NOT_FOUND",
              `Bản xem thử chưa có ${method} ${path}`,
            ),
            true,
          );
        }
        return toResponse(reply);
      } catch (e) {
        if (e instanceof HttpProblem) {
          return json(e.status, problemBody(e.status, e.code, e.detail), true);
        }
        console.error("lớp giả lập hỏng", method, path, e);
        return json(
          500,
          problemBody(500, "INTERNAL", "Lỗi trong bản xem thử"),
          true,
        );
      }
    },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Luồng SSE giả: mở rồi im lặng, đóng được — đủ cho `EventSource` mà Portal dùng */
class SilentEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly withCredentials = false;
  readyState = SilentEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    super();
    setTimeout(() => {
      if (this.readyState === SilentEventSource.CLOSED) return;
      this.readyState = SilentEventSource.OPEN;
      const opened = new Event("open");
      this.dispatchEvent(opened);
      this.onopen?.(opened);
    }, 0);
  }

  close(): void {
    this.readyState = SilentEventSource.CLOSED;
  }
}

export function installMockBackend(): void {
  const backend = createMockBackend(storedSetup());
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${API_PREFIX}/`))
      return realFetch(input, init);
    const text = await request.text();
    await sleep(
      LATENCY_MS.min + Math.random() * (LATENCY_MS.max - LATENCY_MS.min),
    );
    if (request.signal.aborted) {
      throw new DOMException("Request đã bị huỷ", "AbortError");
    }
    return backend.handle(
      request.method,
      url,
      text === "" ? undefined : (JSON.parse(text) as unknown),
    );
  };
  window.EventSource = SilentEventSource as unknown as typeof EventSource;
}
