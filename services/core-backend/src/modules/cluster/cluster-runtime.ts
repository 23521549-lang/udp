import type { ClusterAccess, ClusterInfo } from "@udp/adapter-core";
import { createEgressFetch } from "../../core/egress/egress.js";
import { bootstrapManifests, type BootstrapInput } from "./bootstrap.js";
import {
  createDirectClusterAccess,
  type KubeTransport,
} from "./cluster-access.js";
import { adminTokenSource, tokenRequestSource } from "./token-source.js";

/**
 * Truy cập cluster của tenant cho worker (Plan #28 QĐ-4) — cổng tiêm được: bản thật nói
 * chuyện với API server qua `fetch` có CA của cluster và egress guard; test tiêm transport
 * giả ở tầng HTTP. Chạy trên cluster thật là nợ `I32-cluster`.
 */

export interface AdminToken {
  token: string;
  expiresAt: Date;
}

export interface ClusterRuntime {
  /** Áp tập manifest bootstrap (server-side apply, idempotent) bằng token admin */
  bootstrap(
    info: ClusterInfo,
    admin: AdminToken,
    input: BootstrapInput,
  ): Promise<void>;
  /** ClusterAccess cho các pha sau: bound SA token theo identity, không bao giờ token admin */
  accessFor(info: ClusterInfo, admin: AdminToken): ClusterAccess;
  /**
   * [v4.11, Plan #40] Xoá namespace của một environment vừa bỏ — bằng token ADMIN như
   * `bootstrap`: xoá namespace là quyền cấp cluster mà §12.2 không cho SA nào của UDP. Mọi thứ
   * `bootstrap` dựng cho environment đều nằm trong namespace đó. Đã không còn ⇒ thành công.
   */
  removeNamespace(
    info: ClusterInfo,
    admin: AdminToken,
    namespace: string,
  ): Promise<void>;
}

export function createClusterRuntime(
  transportFor: (info: ClusterInfo) => KubeTransport,
): ClusterRuntime {
  /** Client mang token ADMIN — chỉ cho hai việc cấp cluster: bootstrap và xoá namespace */
  const adminClient = (info: ClusterInfo, admin: AdminToken) =>
    createDirectClusterAccess({
      clusterId: info.clusterId,
      apiEndpoint: info.apiEndpoint,
      transport: transportFor(info),
      tokens: adminTokenSource(admin.token, admin.expiresAt),
    }).getClient("tooling");

  return {
    async bootstrap(info, admin, input) {
      const client = await adminClient(info, admin);
      // Tuần tự theo thứ tự của danh sách: namespace và SA trước Role, Role trước binding
      for (const manifest of bootstrapManifests(input)) {
        await client.write("apply", manifest.ref, manifest.body);
      }
    },

    async removeNamespace(info, admin, namespace) {
      const client = await adminClient(info, admin);
      await client.write("delete", {
        apiVersion: "v1",
        kind: "Namespace",
        name: namespace,
      });
    },

    accessFor(info, admin) {
      const transport = transportFor(info);
      return createDirectClusterAccess({
        clusterId: info.clusterId,
        apiEndpoint: info.apiEndpoint,
        transport,
        tokens: tokenRequestSource({
          apiEndpoint: info.apiEndpoint,
          transport,
          authority: () => Promise.resolve(admin.token),
        }),
      });
    },
  };
}

/** Transport thật: HTTPS tới API server, tin CA của CHÍNH cluster đó, qua egress guard */
export const egressTransport = (info: ClusterInfo): KubeTransport => {
  const guarded = createEgressFetch({ caData: info.caData });
  return { request: (url, init) => guarded(url, init) };
};
