import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { COOKIE_NAMES, CSRF_HEADER } from "@udp/config/constants";
import { NAMESPACE } from "../src/cluster.js";
import { pinnedKubectl } from "../src/install.js";
import {
  publicOrigin,
  readVmSettings,
  TLS_SECRET,
  VM_KUBECTL_PIN,
  type VmSettings,
} from "../src/vm.js";
import { parseSseBlock, type SseEvent } from "../e2e/support.js";

/**
 * Công cụ của E2E máy ảo (Plan #52 QĐ-11): nói chuyện với máy diễn tập ĐÚNG như người dùng trên Internet — qua
 * Traefik, HTTPS, tên host, chứng chỉ do cert-manager cấp. Không `fetch`: nó không nhận CA riêng cho từng lời gọi,
 * còn ở đây chỉ CA tự ký của cụm được tin — và vẫn kiểm tên host như với chứng chỉ thật.
 */

export const kube = pinnedKubectl(VM_KUBECTL_PIN);

export interface Target {
  settings: VmSettings;
  host: string;
  origin: string;
  /** CA mà Secret TLS mang; lượt CI dùng CA tự ký của cert-manager */
  ca: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Chờ tới khi `check` trả khác `undefined` hoặc hết hạn */
export async function eventually<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  what: string,
  everyMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`${what}: chưa thấy sau ${String(timeoutMs)} ms`);
    }
    await sleep(everyMs);
  }
}

/**
 * Máy đích — CHỈ máy diễn tập của CI (`TLS_ISSUER=self-signed`): bộ test đăng ký người dùng và KHÔI PHỤC database,
 * chạy nhầm lên máy thật là mất dữ liệu.
 */
export async function vmTarget(): Promise<Target> {
  const settings = readVmSettings();
  if (settings.TLS_ISSUER !== "self-signed") {
    throw new Error(
      "E2E máy ảo chỉ chạy trên máy diễn tập của CI (TLS_ISSUER=self-signed) — nó đăng ký người dùng và khôi phục database",
    );
  }
  await eventually(
    () =>
      kube.ask([
        "get",
        "certificate",
        TLS_SECRET,
        "-n",
        NAMESPACE,
        "-o",
        'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
      ]) === "True"
        ? true
        : undefined,
    180_000,
    "chứng chỉ udp-tls Ready",
  );
  const b64 = kube.ask([
    "get",
    "secret",
    TLS_SECRET,
    "-n",
    NAMESPACE,
    "-o",
    "jsonpath={.data.ca\\.crt}",
  ]);
  if (b64 === null || b64 === "")
    throw new Error("Secret TLS không mang ca.crt");
  return {
    settings,
    host: settings.UDP_PUBLIC_HOST,
    origin: publicOrigin(settings),
    ca: Buffer.from(b64, "base64").toString("utf8"),
  };
}

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** SAN của chứng chỉ server (chỉ với https) */
  peerAltNames?: string;
}

export interface CallOptions {
  headers?: Record<string, string>;
  body?: string;
  scheme?: "https" | "http";
}

function collect(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    res.on("error", reject);
  });
}

/** Một lời gọi tới máy qua host công khai; https mặc định, chỉ tin CA của cụm */
export function call(
  target: Target,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Reply> {
  const scheme = options.scheme ?? "https";
  const headers = {
    ...(options.body === undefined
      ? {}
      : { "Content-Type": "application/json" }),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const onResponse = (res: IncomingMessage): void => {
      const socket = res.socket as TLSSocket;
      const peerAltNames =
        scheme === "https"
          ? socket.getPeerCertificate().subjectaltname
          : undefined;
      collect(res).then(
        (body) => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            ...(peerAltNames === undefined ? {} : { peerAltNames }),
          });
        },
        (err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    };
    const req =
      scheme === "https"
        ? httpsRequest(
            {
              host: target.host,
              port: 443,
              path,
              method,
              headers,
              ca: target.ca,
              servername: target.host,
            },
            onResponse,
          )
        : httpRequest(
            { host: target.host, port: 80, path, method, headers },
            onResponse,
          );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export interface Session {
  cookie: string;
  csrf: string;
  setCookies: string[];
}

function sessionOf(reply: Reply): Session {
  const setCookies = reply.headers["set-cookie"] ?? [];
  const pairs = setCookies.map((c) => c.split(";")[0] ?? "");
  const csrf = pairs
    .find((c) => c.startsWith(`${COOKIE_NAMES.csrfToken}=`))
    ?.slice(COOKIE_NAMES.csrfToken.length + 1);
  if (csrf === undefined) throw new Error("không có cookie CSRF");
  return { cookie: pairs.join("; "), csrf, setCookies };
}

export interface User {
  email: string;
  password: string;
}

export const newUser = (label: string): User => ({
  email: `e2e-${label}-${String(Date.now())}@example.com`,
  password: `udp-e2e-${label}-password`,
});

export async function register(target: Target, user: User): Promise<Session> {
  const reply = await call(target, "POST", "/api/v1/auth/register", {
    body: JSON.stringify({ ...user, name: `E2E ${user.email}` }),
  });
  if (reply.status !== 201) {
    throw new Error(`đăng ký → ${String(reply.status)} ${reply.body}`);
  }
  return sessionOf(reply);
}

export async function login(target: Target, user: User): Promise<Reply> {
  return call(target, "POST", "/api/v1/auth/login", {
    body: JSON.stringify(user),
  });
}

/** API của Service 1 qua Portal, có cookie phiên và CSRF */
export async function api<T>(
  target: Target,
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const reply = await call(target, method, `/api/v1${path}`, {
    headers: { Cookie: session.cookie, [CSRF_HEADER]: session.csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: reply.status,
    body: (reply.body === "" ? undefined : JSON.parse(reply.body)) as T,
  };
}

export interface OpenStream {
  status: Promise<number>;
  events: SseEvent[];
  /** Số khối dữ liệu đã nhận (event, chú thích nhịp tim, `retry:`) */
  chunks: () => number;
  ended: () => boolean;
  close(): void;
}

/** Mở `/sdk/stream` qua Traefik bằng một khoá SDK thật */
export function openStream(target: Target, sdkKey: string): OpenStream {
  const events: SseEvent[] = [];
  let chunks = 0;
  let ended = false;
  let destroy: () => void = () => undefined;
  const status = new Promise<number>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: target.host,
        port: 443,
        path: "/sdk/stream",
        method: "GET",
        headers: {
          Authorization: `Bearer ${sdkKey}`,
          Accept: "text/event-stream",
        },
        ca: target.ca,
        servername: target.host,
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          chunks += 1;
          buffer += chunk;
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            const parsed = parseSseBlock(buffer.slice(0, end));
            if (parsed !== null) events.push(parsed);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
          }
        });
        res.on("close", () => {
          ended = true;
        });
      },
    );
    req.on("error", reject);
    req.end();
    destroy = () => req.destroy();
  });
  return {
    status,
    events,
    chunks: () => chunks,
    ended: () => ended,
    close: () => {
      destroy();
    },
  };
}

/** Bồn nhận bản sao lưu trên runner — đích `UDP_BACKUP_UPLOAD_URL` của máy diễn tập (deploy/vm/ci-settings.sh) */
export interface Sink {
  received: Map<string, Buffer>;
  close(): Promise<void>;
}

export function startSink(uploadUrl: string): Promise<Sink> {
  const port = Number(new URL(uploadUrl).port);
  const received = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    if (req.method !== "PUT") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.set(req.url ?? "", Buffer.concat(chunks));
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "0.0.0.0", () => {
      resolve({
        received,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}
