import type { ClusterAccess } from "@udp/adapter-core";

/**
 * `fetch` tới một service TRONG cluster tenant qua proxy của API server (ADR-06, Plan #39 QĐ-3).
 *
 * Endpoint của binding là DNS service trong cluster (`http://<service>.<namespace>[.svc…]:<port>`)
 * — không tới được từ ngoài cluster. `fetch` này đổi URL mà provider dựng (cùng đường, cùng query)
 * thành một lời `proxyService`, nên provider Prometheus dùng nguyên mã của nó.
 */

export type ServiceTarget = Parameters<ClusterAccess["proxyService"]>[0];

export function serviceTargetOf(baseUrl: string): ServiceTarget {
  const url = new URL(baseUrl);
  const [service, namespace] = url.hostname.split(".");
  if (
    service === undefined ||
    service === "" ||
    namespace === undefined ||
    namespace === ""
  ) {
    throw new Error(
      `Endpoint trong cluster không có dạng <service>.<namespace>: ${url.hostname}`,
    );
  }
  const scheme = url.protocol === "https:" ? "https" : "http";
  const port =
    url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
  return { namespace, service, port, scheme };
}

export function serviceProxyFetch(
  access: () => Promise<ClusterAccess>,
  target: ServiceTarget,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    return (await access()).proxyService(
      target,
      `${url.pathname}${url.search}`,
      init,
    );
  };
}
