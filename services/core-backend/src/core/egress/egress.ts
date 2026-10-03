import {
  lookup as dnsLookup,
  type LookupAddress,
  type LookupAllOptions,
  type LookupOptions,
} from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { UnprocessableError } from "@udp/http";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Egress guard chống SSRF (§12 T11, §3.1 `egress/`) — MỌI HTTP ra ngoài do cấu hình của
 * người dùng quyết định địa chỉ (API SaaS của adapter, API server của cluster khách) đi qua
 * đây.
 *
 * Ba lớp, và lớp thứ ba là lớp đáng tiền:
 *
 *  1. Chỉ `https:` — không `http:`, `file:`, `gopher:`.
 *  2. IP viết thẳng trong URL bị kiểm trước khi mở kết nối.
 *  3. Tên miền được kiểm NGAY TRONG `lookup` của kết nối, trên MỌI địa chỉ phân giải ra.
 *     Kiểm bằng một lần `dns.lookup` riêng rồi mới `fetch` là để hở DNS rebinding: lần phân
 *     giải thứ hai (của chính kết nối) có thể trả một IP nội bộ khác.
 */

export type LookupFn = (
  hostname: string,
  options: LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

/** CIDR IPv4 không được gọi tới — mạng riêng, loopback, link-local (metadata cloud), đặc biệt */
const BLOCKED_V4: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const v4ToInt = (ip: string): number =>
  ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);

function blockedV4(ip: string): boolean {
  const value = v4ToInt(ip);
  return BLOCKED_V4.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix);
    return Math.floor(value / size) === Math.floor(v4ToInt(base) / size);
  });
}

/** IPv6: loopback, unspecified, ULA fc00::/7, link-local fe80::/10, multicast, và IPv4 nhúng */
function blockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded?.[1] !== undefined) return blockedV4(embedded[1]);
  const first = Number.parseInt(lower.split(":")[0] ?? "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  );
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blockedV4(ip);
  if (family === 6) return blockedV6(ip);
  return true; // không phải IP: không biết là gì thì không đi
}

export class EgressBlockedError extends UnprocessableError {
  constructor(target: string, reason: string) {
    super(`Không gọi ra ${target}: ${reason}`, undefined, "EGRESS_BLOCKED");
    this.name = "EgressBlockedError";
  }
}

/** `lookup` của kết nối: phân giải MỌI địa chỉ, một cái bị chặn là cả kết nối bị chặn */
function guardedLookup(resolve: LookupFn): LookupFunction {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err !== null) {
        callback(err, []);
        return;
      }
      const bad = addresses.find((a) => isBlockedAddress(a.address));
      const first = addresses[0];
      if (bad !== undefined || first === undefined) {
        callback(
          new EgressBlockedError(
            hostname,
            bad === undefined
              ? "không phân giải ra địa chỉ nào"
              : "phân giải ra địa chỉ nội bộ",
          ),
          [],
        );
        return;
      }
      if (options.all === true) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

const systemLookup: LookupFn = (hostname, options, callback) => {
  dnsLookup(hostname, options, callback);
};

export interface EgressFetchOptions {
  /** Tiêm được cho test; mặc định `dns.lookup` của hệ thống */
  lookup?: LookupFn;
  /** CA riêng (API server của cluster tự ký) — base64 PEM như `caData` của cluster */
  caData?: string;
}

export function createEgressFetch(
  options: EgressFetchOptions = {},
): typeof fetch {
  const agent = new Agent({
    connect: {
      lookup: guardedLookup(options.lookup ?? systemLookup),
      ...(options.caData === undefined
        ? {}
        : { ca: Buffer.from(options.caData, "base64").toString("utf8") }),
    },
  });
  const egressFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") {
      throw new EgressBlockedError(
        url.host,
        `chỉ cho https, không ${url.protocol}`,
      );
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && isBlockedAddress(host)) {
      throw new EgressBlockedError(url.host, "địa chỉ nội bộ");
    }
    /**
     * `fetch` của undici là CHÍNH hiện thực của `fetch` toàn cục trong Node; `RequestInit`
     * khai ở hai gói (undici-types của Node và undici) nên ép ở đúng một biên này.
     */
    return undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    });
  };
  return egressFetch;
}
