import { expect } from "vitest";
import type { Kube } from "../src/install.js";
import { eventually } from "./support.js";

/**
 * [Plan #65] Phép thử NetworkPolicy `postgres-clients` trên cụm THẬT - dùng chung cho kind (E2E rút gọn) và máy ảo.
 *
 * Hai bộ cưỡng chế khác nhau: kube-router của k3s trả REJECT, kindnet (kube-network-policies, kind ≥ v0.24) rơi gói.
 * Policy chỉ đúng nhờ đặc thù của một bên thì bên kia lộ ra.
 *
 * Ba điều làm phép thử không xanh giả:
 *
 *  - Đi bằng ClusterIP, không bằng tên. `pg_isready` thoát 2 cho cả "không phân giải được tên", "bị từ chối" lẫn
 *    "hết giờ"; một pod ở namespace khác gọi `postgres` gặp NXDOMAIN và thoát 2 dù policy mở toang.
 *  - Kẹp hai đầu bằng đối chứng dương. Mã 2 cũng ra khi postgres đang khởi động lại; dương ở cả trước lẫn sau chứng
 *    minh nó sống suốt quãng thử âm.
 *  - Lặp đối xứng. Bộ cưỡng chế cần một nhịp đồng bộ để thấy IP của pod mới: phía dương chịu được trễ đó (một lần
 *    thành công là đủ), phía âm phải không lọt LẦN NÀO trong cùng cửa sổ.
 */

const CLIENT_LABEL = "app.kubernetes.io/name";
/** Nhãn được phép mà không Service nào chọn: pod thử không thành endpoint nhận request thật trong lúc nó sống */
const ALLOWED_LABEL = "udp-migrate";
const OTHER_NAMESPACE = "udp-netpol-probe";
const ATTEMPTS = 10;
const PROBE = [
  "sh",
  "-c",
  `i=0; while [ "$i" -lt ${String(ATTEMPTS)} ]; do pg_isready --host="$1" --port=5432 --timeout=3 && exit 0; i=$((i+1)); sleep 2; done; exit 2`,
  "probe",
];

async function probe(
  kube: Kube,
  namespace: string,
  label: string,
  host: string,
): Promise<number> {
  const pod = `udp-netpol-probe-${String(Date.now())}`;
  try {
    kube.run([
      "run",
      pod,
      "-n",
      namespace,
      "--image=postgres:16-alpine",
      "--restart=Never",
      `--labels=${CLIENT_LABEL}=${label}`,
      "--command",
      "--",
      ...PROBE,
      host,
    ]);
    return await eventually(
      () => {
        const code = kube.ask([
          "get",
          "pod",
          pod,
          "-n",
          namespace,
          "-o",
          "jsonpath={.status.containerStatuses[0].state.terminated.exitCode}",
        ]);
        return code === null || code.trim() === "" ? undefined : Number(code);
      },
      180_000,
      `pod thử ${namespace}/${pod} kết thúc`,
    );
  } finally {
    kube.ask([
      "delete",
      "pod",
      pod,
      "-n",
      namespace,
      "--ignore-not-found",
      "--wait=false",
    ]);
  }
}

/** Chỉ client của database trong namespace của UDP tới được cổng 5432 - nhãn lạ và namespace khác thì không */
export async function expectPostgresOnlyForClients(
  kube: Kube,
  namespace: string,
): Promise<void> {
  const host = kube.ask([
    "get",
    "service",
    "postgres",
    "-n",
    namespace,
    "-o",
    "jsonpath={.spec.clusterIP}",
  ]);
  expect(host, "ClusterIP của Service postgres").toMatch(
    /^\d+\.\d+\.\d+\.\d+$/,
  );
  const ip = (host as string).trim();

  expect(await probe(kube, namespace, ALLOWED_LABEL, ip), "dương").toBe(0);
  expect(
    await probe(kube, namespace, "udp-netpol-probe", ip),
    "âm: nhãn lạ",
  ).toBe(2);

  // Ranh giới namespace: pod ngoài `udp` tự gán đúng nhãn được phép vẫn không qua (policy không có namespaceSelector)
  kube.ask([
    "delete",
    "namespace",
    OTHER_NAMESPACE,
    "--ignore-not-found",
    "--wait=true",
    "--timeout=60s",
  ]);
  kube.run(["create", "namespace", OTHER_NAMESPACE]);
  try {
    expect(
      await probe(kube, OTHER_NAMESPACE, ALLOWED_LABEL, ip),
      "âm: namespace khác, nhãn được phép",
    ).toBe(2);
  } finally {
    kube.ask([
      "delete",
      "namespace",
      OTHER_NAMESPACE,
      "--ignore-not-found",
      "--wait=false",
    ]);
  }

  expect(await probe(kube, namespace, ALLOWED_LABEL, ip), "dương lần hai").toBe(
    0,
  );
}
