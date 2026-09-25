import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import adapter from "./index.js";

/**
 * [v4.10] Bộ hợp đồng chạy cho adapter THẬT — và tệp này nằm CẠNH adapter.
 *
 * Vị trí của tệp không phải chuyện thẩm mỹ: đây chính là đường rò thứ chín (D-7). Bản cũ
 * của `vitest.config.ts` khai `include: ["tests/**"]`, nên một contract test đặt ở đây
 * **không bao giờ chạy** và vitest không báo gì. `include` đã được mở một lần ở P17 cho cả
 * `src/modules/**`, và tệp này là **tệp thật đầu tiên** khớp mẫu đó — tức nó cũng là phép
 * đo chứng minh mẫu ấy không phải một dòng cấu hình xanh vĩnh viễn.
 *
 * `AdapterFixture` ở đây khai bề mặt tác dụng của adapter, và mỗi danh sách là một khẳng
 * định chứ không phải một chỗ trống (SPEC §2.5):
 *
 *  - `externalHosts` RỖNG: Prometheus cài bằng chart, không gọi API nào ra Internet. Bộ
 *    hợp đồng biến điều đó thành "mọi lời gọi egress là đỏ".
 *  - `quotaDimensions` có `maxStorageGb`: Prometheus giữ metrics trên PVC, nên nó phải
 *    TỪ CHỐI khi chiều đó bằng 0.
 */

function fixture(): AdapterFixture {
  return {
    validConfig: { retentionDays: 15, dashboards: true, storageGb: 20 },
    invalidConfigs: [
      /** Ngoài khoảng cho phép — 0 ngày nghĩa là không giữ gì */
      { retentionDays: 0, storageGb: 20 },
      /** Sai kiểu */
      { retentionDays: "mười lăm", storageGb: 20 },
      /** Thiếu trường bắt buộc */
      { dashboards: true },
      /** Vượt trần: một PVC 5 TiB gần như luôn là một lỗi gõ */
      { retentionDays: 15, storageGb: 5000 },
    ],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: [
      {
        prefix: "kubectl.kubernetes.io/",
        reason:
          "kubectl tự thêm last-applied-configuration mỗi lần ai đó chạy apply bằng tay",
      },
      {
        prefix: "helm.sh/",
        reason: "Helm tự gắn nhãn revision, đổi mỗi lần nâng cấp chart",
      },
    ],
    driftMutations: [
      {
        name: "sửa tay retention trong ConfigMap giá trị",
        apply: async (client) => {
          await client.write(
            "patch",
            {
              apiVersion: "v1",
              kind: "ConfigMap",
              namespace: SYSTEM_NS,
              name: "udp-prometheus-values",
            },
            { chartVersion: "0.0.0-ai-do-sua-tay" },
          );
        },
      },
      {
        name: "xoá hẳn ConfigMap giá trị",
        apply: async (client) => {
          await client.write("delete", {
            apiVersion: "v1",
            kind: "ConfigMap",
            namespace: SYSTEM_NS,
            name: "udp-prometheus-values",
          });
        },
      },
    ],
  };
}

/** Binding mà adapter `requires`: Grafana kéo dashboard từ registry của project */
const REGISTRY = {
  id: "registry.oci",
  version: "1.0.0",
  providedBy: "container_registry:harbor",
  endpoint: "harbor.udp-system:443",
} as const;

describe("prometheus-grafana", () => {
  runDomainAdapterContract(
    adapter,
    () =>
      domainContractEnv(fixture(), { resolved: { "registry.oci": REGISTRY } }),
    { describe, it },
  );
});
