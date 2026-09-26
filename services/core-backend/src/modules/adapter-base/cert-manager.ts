import type { HelmCompanion } from "./helm.js";

/**
 * cert-manager — thành phần NỀN của nhiều operator (webhook của Azure Service Operator, K8ssandra):
 * MỘT định nghĩa cho mọi adapter dùng nó. Hai bản cert-manager trong một cluster tranh CRD và
 * webhook; hai adapter khai hai phiên bản khác nhau thì mỗi lần áp lại đổi bản của nhau. Khai ở
 * một chỗ thì cùng tên release, cùng chart, cùng giá trị — áp lần hai là không đổi gì.
 */
export const certManagerCompanion: HelmCompanion = {
  releaseName: "udp-cert-manager",
  chart: {
    name: "cert-manager",
    version: "v1.16.1",
    repo: "https://charts.jetstack.io",
  },
  values: () => ({ crds: { enabled: true } }),
  before: true,
  shared: true,
};
