import type { Db, ProjectRecord } from "./db";

/** Một request tới API đã tách phần sau `/api/v1` */
export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface Reply {
  status: number;
  body?: unknown;
}

export type Handler = (req: MockRequest, params: string[]) => Reply;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

/** Lỗi nghiệp vụ ném ra từ handler — thành một problem+json như Service 1 trả */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

export class Router {
  private readonly routes: Route[] = [];

  /** `template` dạng `/projects/:id/flags/:id` — mỗi `:x` là một tham số theo thứ tự */
  on(method: string, template: string, handler: Handler): this {
    const source = template
      .split("/")
      .map((part) => (part.startsWith(":") ? "([^/]+)" : part))
      .join("/");
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), handler });
    return this;
  }

  handle(req: MockRequest): Reply | null {
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(req.path);
      if (match === null) continue;
      return route.handler(req, match.slice(1).map(decodeURIComponent));
    }
    return null;
  }
}

export const ok = (body: unknown, status = 200): Reply => ({ status, body });
export const noContent: Reply = { status: 204 };

export function problemBody(status: number, code: string, detail: string) {
  return {
    type: `https://udp.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title: detail,
    status,
    detail,
    code,
    traceId: crypto.randomUUID().replaceAll("-", ""),
  };
}

export function projectOf(db: Db, projectId: string): ProjectRecord {
  const found = db.projects.find(
    (p) => p.project.id === projectId && p.project.status !== "DELETED",
  );
  if (found === undefined) {
    throw new HttpProblem(404, "NOT_FOUND", "Không tìm thấy project");
  }
  return found;
}

export function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new HttpProblem(404, "NOT_FOUND", `Không tìm thấy ${what}`);
  }
  return value;
}

/** Thân request đã parse JSON — handler tự lấy trường cần, như controller thật sau validate */
export const bodyOf = <T>(req: MockRequest): T => req.body as T;

export const intParam = (
  query: URLSearchParams,
  key: string,
  fallback: number,
): number => {
  const raw = query.get(key);
  const value = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
