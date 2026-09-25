import type { DomainContractEnv } from "../contract/domain.js";
import type { AdapterFixture, DomainAdapterContext } from "../domain.js";
import { createFakeClusterAccess } from "./fake-cluster.js";

/**
 * Môi trường của bộ hợp đồng Domain Adapter, dựng MỘT chỗ (Plan #31 P2).
 *
 * Trước đây mỗi `contract.test.ts` tự dựng cluster giả, bối cảnh và egress giả — trăm dòng
 * khuôn nhân theo số adapter, và mỗi bản sao là một chỗ có thể lệch luật. Ở đây egress giả
 * suy THẲNG từ `fixture.externalHosts`: host đã khai được trả lời, mọi host khác bị từ chối
 * (khai rỗng ⇒ mọi lời gọi bị từ chối), nên lời khai của fixture và hành vi của môi trường
 * không thể lệch nhau. Adapter chỉ còn khai fixture và những binding nó `requires`.
 */

export interface DomainContractEnvOptions {
  /** Binding mà adapter `requires` — đọc từ bảng ở sản phẩm, khai tay ở test */
  resolved?: DomainAdapterContext["resolved"];
  /** Environment đích cho adapter `namespace`; adapter `cluster` để vắng */
  environment?: NonNullable<DomainAdapterContext["environment"]>;
  /** Phản hồi của host ĐÃ KHAI; mặc định `200 {}` */
  respond?: (url: string, init: RequestInit | undefined) => Response;
  /** Mọi lời gọi egress kèm `init` — để test soi header và thân request */
  requests?: { url: string; init: RequestInit | undefined }[];
}

export const CONTRACT_SYSTEM_NAMESPACE = "udp-system";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function domainContractEnv(
  fixture: AdapterFixture,
  options: DomainContractEnvOptions = {},
): DomainContractEnv {
  const cluster = createFakeClusterAccess({ clusterId: "c-hop-dong" });
  const progressLog: string[] = [];
  const fetchLog: string[] = [];
  const allowed = new Set(fixture.externalHosts);

  const context = (
    over: Partial<DomainAdapterContext> = {},
  ): DomainAdapterContext => ({
    k8s: cluster,
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    systemNamespace: CONTRACT_SYSTEM_NAMESPACE,
    region: "ap-southeast-1",
    quota: {
      maxNodes: 3,
      maxNodeSize: "medium",
      maxDatabases: 2,
      maxStorageGb: 50,
      maxLoadBalancers: 3,
    },
    resolved: options.resolved ?? {},
    tags: { "udp.project": "p-hop-dong" },
    progress: (m) => progressLog.push(m),
    /**
     * Egress guard GIẢ theo lời khai của fixture. Trả `Response` thật: lớp nền đọc `ok` và
     * `status`, một object thiếu hai trường đó làm adapter vỡ ở chỗ không liên quan.
     */
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      fetchLog.push(url);
      options.requests?.push({ url, init });
      const host = hostOf(url);
      if (!allowed.has(host)) {
        return Promise.reject(
          new Error(`egress tới "${host}" bị egress guard từ chối`),
        );
      }
      return Promise.resolve(
        options.respond?.(url, init) ?? new Response("{}", { status: 200 }),
      );
    },
    ...over,
  });

  return { cluster, fixture, context, progressLog, fetchLog };
}
