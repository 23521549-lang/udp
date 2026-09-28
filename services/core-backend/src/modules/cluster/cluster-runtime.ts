import {
  IDENTITY_SERVICE_ACCOUNTS,
  type ClusterAccess,
  type ClusterInfo,
  type ControlPlaneIdentity,
} from "@udp/adapter-core";
import {
  adminTokenSource,
  createDirectClusterAccess,
  tokenRequestSource,
  type BoundToken,
  type KubeTransport,
} from "@udp/cluster-access";
import { createEgressFetch } from "../../core/egress/egress.js";
import { bootstrapManifests, type BootstrapInput } from "./bootstrap.js";

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
   * [v4.11, Plan #51] Bound SA token 1 giờ của MỘT identity, xin bằng token quản trị — cho route
   * `POST /internal/clusters/:id/token` (Service 3 tự nói với cluster, ADR-06). Không lưu ở đâu cả (I24).
   */
  boundToken(
    info: ClusterInfo,
    admin: AdminToken,
    identity: ControlPlaneIdentity,
  ): Promise<BoundToken>;
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

/** `TokenRequest` bằng token quản trị — nguồn token của mọi identity sau bootstrap */
const boundTokens = (
  info: ClusterInfo,
  admin: AdminToken,
  transport: KubeTransport,
) =>
  tokenRequestSource({
    apiEndpoint: info.apiEndpoint,
    transport,
    authority: () => Promise.resolve(admin.token),
  });

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
        tokens: boundTokens(info, admin, transport),
      });
    },
    boundToken(info, admin, identity) {
      return boundTokens(info, admin, transportFor(info)).requestBoundToken(
        IDENTITY_SERVICE_ACCOUNTS[identity],
      );
    },
  };
}

/** Transport thật: HTTPS tới API server, tin CA của CHÍNH cluster đó, qua egress guard */
export const egressTransport = (info: ClusterInfo): KubeTransport => {
  const guarded = createEgressFetch({ caData: info.caData });
  return { request: (url, init) => guarded(url, init) };
};
