import { Agent, fetch as undiciFetch } from "undici";
import type { KubeTransport } from "./direct.js";

/**
 * Vận chuyển tới API server của MỘT cluster, tin ĐÚNG CA của cluster đó (ADR-06: "TLS bằng CA của cluster") —
 * không tin kho CA của hệ điều hành, không đi http.
 *
 * Service 3 dùng nó với `apiEndpoint`/`caData` mà Service 1 cấp cùng token (Plan #51 QĐ-3). Service 1 KHÔNG dùng
 * nó: S1 còn gọi URL do người dùng nhập, nên đi `createEgressFetch` có chặn SSRF theo DNS (§12 T11).
 */
export function caPinnedTransport(caData: string): KubeTransport {
  const agent = new Agent({
    connect: { ca: Buffer.from(caData, "base64").toString("utf8") },
  });
  return {
    request(url, init) {
      if (new URL(url).protocol !== "https:") {
        return Promise.reject(
          new Error(`API server chỉ nói https, không ${new URL(url).protocol}`),
        );
      }
      /**
       * `fetch` của undici là CHÍNH hiện thực của `fetch` toàn cục trong Node; `RequestInit` khai ở hai gói
       * (undici-types của Node và undici) nên ép ở đúng một biên này — cùng lý do với egress của S1.
       */
      return undiciFetch(url, {
        ...(init as unknown as Parameters<typeof undiciFetch>[1]),
        dispatcher: agent,
      });
    },
  };
}
