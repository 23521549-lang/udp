import type { AdapterFixture, ObjectRef } from "@udp/adapter-core";
import { CONTRACT_SYSTEM_NAMESPACE } from "@udp/adapter-core/testing";

/**
 * Mảnh `AdapterFixture` dùng chung cho `contract.test.ts` của họ Helm (Plan #31 P2) — CHỈ test
 * import tệp này; mã sản phẩm không bao giờ.
 *
 * Lớp nền Helm ghi cùng một bộ đối tượng cho mọi adapter (`HelmRelease`, ConfigMap giá trị,
 * `Secret` khi có bí mật), nên cách "sửa tay" chúng cũng là một: viết một lần ở đây thay vì
 * chép vào sáu mươi tệp test, và mỗi loại trôi có đúng một ô (I32 chiều a).
 */

type Mutations = AdapterFixture["driftMutations"];
type Client = Parameters<Mutations[number]["apply"]>[0];

/** Hai prefix mà lớp nền Helm của mọi adapter bỏ qua khi so drift — mỗi cái kèm lý do */
export const HELM_IGNORED_PREFIXES: AdapterFixture["ignoredLabelPrefixes"] = [
  {
    prefix: "kubectl.kubernetes.io/",
    reason:
      "kubectl tự thêm last-applied-configuration mỗi lần ai đó apply bằng tay",
  },
  {
    prefix: "helm.sh/",
    reason: "Helm tự gắn nhãn revision, đổi mỗi lần nâng cấp chart",
  },
];

/** Prefix mà lớp nền `RegistryAdapter` bỏ qua — ConfigMap mô tả chỉ bị kubectl chạm */
export const REGISTRY_IGNORED_PREFIXES: AdapterFixture["ignoredLabelPrefixes"] =
  [
    {
      prefix: "kubectl.kubernetes.io/",
      reason:
        "kubectl tự thêm last-applied-configuration mỗi lần ai đó apply bằng tay",
    },
  ];

/** Sửa tay ConfigMap mô tả mà lớp nền `RegistryAdapter` ghi cho `toolId` (Plan #35) */
export function registryDriftMutations(
  toolId: string,
  namespace: string = CONTRACT_SYSTEM_NAMESPACE,
): Mutations {
  const described = {
    apiVersion: "v1",
    kind: "ConfigMap",
    namespace,
    name: `udp-registry-${toolId}`,
  };
  return [
    {
      name: "sửa tay địa chỉ registry trong ConfigMap mô tả",
      apply: (c) =>
        c.write("patch", described, { registry: { server: "ai-do.vi-du" } }),
    },
    {
      name: "xoá hẳn ConfigMap mô tả registry",
      apply: (c) => c.write("delete", described),
    },
  ];
}

const ref = (kind: string, name: string, namespace: string): ObjectRef => ({
  apiVersion: kind === "HelmRelease" ? "helm.toolkit.fluxcd.io/v2" : "v1",
  kind,
  namespace,
  name,
});

/**
 * Sửa tay từng đối tượng mà lớp nền Helm ghi cho `releaseName` — và cho MỖI release đi kèm
 * (Plan #32): trôi ở bất kỳ release nào của nhóm cũng phải bị thấy.
 */
export function helmDriftMutations(
  releaseName: string,
  options: {
    secrets?: boolean;
    namespace?: string;
    companions?: readonly string[];
  } = {},
): Mutations {
  const ns = options.namespace ?? CONTRACT_SYSTEM_NAMESPACE;
  return [
    {
      name: "sửa tay chartVersion trong ConfigMap giá trị",
      apply: (c) =>
        c.write("patch", ref("ConfigMap", `${releaseName}-values`, ns), {
          chartVersion: "0.0.0-ai-do-sua-tay",
        }),
    },
    {
      name: "xoá hẳn HelmRelease (workload không còn chạy)",
      apply: (c) => c.write("delete", ref("HelmRelease", releaseName, ns)),
    },
    ...(options.companions ?? []).flatMap((companion) => [
      {
        name: `xoá hẳn HelmRelease đi kèm ${companion}`,
        apply: (c: Client) =>
          c.write("delete", ref("HelmRelease", companion, ns)),
      },
      {
        name: `sửa tay ConfigMap giá trị của ${companion}`,
        apply: (c: Client) =>
          c.write("patch", ref("ConfigMap", `${companion}-values`, ns), {
            chartVersion: "0.0.0-ai-do-sua-tay",
          }),
      },
    ]),
    ...(options.secrets === true
      ? [
          {
            name: "xoá Secret của release (agent mất khoá)",
            apply: (c: Client) =>
              c.write("delete", ref("Secret", `${releaseName}-secrets`, ns)),
          },
        ]
      : []),
  ];
}
