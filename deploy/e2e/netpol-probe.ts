import { expect } from "vitest";
import type { Kube } from "../src/install.js";
import { eventually } from "./support.js";

/**
 * Phép thử NetworkPolicy trên cụm THẬT - dùng chung cho kind (E2E rút gọn) và máy ảo. [Plan #65] `postgres-clients`;
 * [Plan #66] cổng nội bộ của Service 1 và Service 2.
 *
 * Hai bộ cưỡng chế khác nhau: kube-router của k3s trả REJECT, kindnet (kube-network-policies, kind ≥ v0.24) rơi gói.
 * Policy chỉ đúng nhờ đặc thù của một bên thì bên kia lộ ra.
 *
 * Ba điều làm phép thử không xanh giả:
 *
 *  - Đi bằng ClusterIP, không bằng tên. `pg_isready` và `wget` thoát cùng một mã cho "không phân giải được tên", "bị
 *    từ chối" lẫn "hết giờ"; một pod ở namespace khác gọi tên ngắn gặp NXDOMAIN dù policy mở toang.
 *  - Kẹp hai đầu bằng đối chứng dương. Mã "không tới" cũng ra khi đích đang khởi động lại; dương ở cả trước lẫn sau
 *    chứng minh nó sống suốt quãng thử âm.
 *  - Lặp đối xứng. Bộ cưỡng chế cần một nhịp đồng bộ để thấy IP của pod mới: phía dương chịu được trễ đó (một lần
 *    thành công là đủ), phía âm phải không lọt LẦN NÀO trong cùng cửa sổ.
 */

const CLIENT_LABEL = "app.kubernetes.io/name";
/** Nhãn được phép mà không Service nào chọn: pod thử không thành endpoint nhận request thật trong lúc nó sống */
const ALLOWED_LABEL = "udp-migrate";
const FOREIGN_LABEL = "udp-netpol-probe";
const OTHER_NAMESPACE = "udp-netpol-probe";
const ATTEMPTS = 10;

/** 0: postgres nhận kết nối; 2: không trong `ATTEMPTS` lượt */
const PG_PROBE = [
  "sh",
  "-c",
  `i=0; while [ "$i" -lt ${String(ATTEMPTS)} ]; do pg_isready --host="$1" --port=5432 --timeout=3 && exit 0; i=$((i+1)); sleep 2; done; exit 2`,
  "probe",
];

/**
 * 0: `/healthz` trả lời 2xx; 3: có listener trả lời nhưng mã HTTP sai (đỏ ở CẢ hai phía); 2: không tới trong
 * `ATTEMPTS` lượt. `wget` của busybox thoát 1 cho cả HTTP 4xx/5xx lẫn bị chặn, nên phân loại bằng câu nó in ra
 * (`networking/wget.c`, busybox 1.36); `-T` phủ cả bước kết nối, nên rơi gói cũng kết thúc sau `-T` giây.
 */
const HTTP_PROBE = [
  "sh",
  "-c",
  `i=0; while [ "$i" -lt ${String(ATTEMPTS)} ]; do out=$(wget -q -T 3 -O /dev/null "http://$1/healthz" 2>&1) && exit 0; case "$out" in *"server returned error"*) echo "$out"; exit 3;; esac; i=$((i+1)); sleep 2; done; echo "$out"; exit 2`,
  "probe",
];

/** Chạy `command` trong một pod `postgres:16-alpine` mang nhãn cho trước; trả mã thoát của container */
async function probe(
  kube: Kube,
  namespace: string,
  label: string,
  command: readonly string[],
  target: string,
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
      ...command,
      target,
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

/** `<ClusterIP>:<cổng đầu tiên>` của một Service */
export function endpointOf(
  kube: Kube,
  namespace: string,
  service: string,
): string {
  const out = kube.ask([
    "get",
    "service",
    service,
    "-n",
    namespace,
    "-o",
    "jsonpath={.spec.clusterIP}:{.spec.ports[0].port}",
  ]);
  expect(out, `ClusterIP của Service ${service}`).toMatch(
    /^\d+\.\d+\.\d+\.\d+:\d+$/,
  );
  return (out as string).trim();
}

/** Namespace tạm cho phép thử ranh giới namespace - xoá trước khi tạo (lượt trước có thể để sót) và xoá sau */
async function inOtherNamespace(
  kube: Kube,
  body: (namespace: string) => Promise<void>,
): Promise<void> {
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
    await body(OTHER_NAMESPACE);
  } finally {
    kube.ask([
      "delete",
      "namespace",
      OTHER_NAMESPACE,
      "--ignore-not-found",
      "--wait=false",
    ]);
  }
}

/** [Plan #65] Chỉ client của database trong namespace của UDP tới được cổng 5432 - nhãn lạ và namespace khác thì không */
export async function expectPostgresOnlyForClients(
  kube: Kube,
  namespace: string,
): Promise<void> {
  const ip = endpointOf(kube, namespace, "postgres").split(":")[0] as string;

  expect(
    await probe(kube, namespace, ALLOWED_LABEL, PG_PROBE, ip),
    "dương",
  ).toBe(0);
  expect(
    await probe(kube, namespace, FOREIGN_LABEL, PG_PROBE, ip),
    "âm: nhãn lạ",
  ).toBe(2);
  // Ranh giới namespace: pod ngoài `udp` tự gán đúng nhãn được phép vẫn không qua (policy không có namespaceSelector)
  await inOtherNamespace(kube, async (other) => {
    expect(
      await probe(kube, other, ALLOWED_LABEL, PG_PROBE, ip),
      "âm: namespace khác, nhãn được phép",
    ).toBe(2);
  });
  expect(
    await probe(kube, namespace, ALLOWED_LABEL, PG_PROBE, ip),
    "dương lần hai",
  ).toBe(0);
}

/**
 * Mã HTTP mà pod Service 3 THẬT nhận được (`kubectl exec`), hoặc chuỗi lỗi kết nối. Phía dương đi bằng pod thật chứ
 * không bằng pod thử: hai nhãn được phép (`core-backend`, `pd-controller`) đều là nhãn mà một Service chọn, nên một pod
 * thử mang chúng sẽ thành endpoint nhận request thật trong lúc nó sống.
 */
function fromServiceThree(
  kube: Kube,
  namespace: string,
  url: string,
): string | null {
  return kube.ask([
    "exec",
    "deploy/pd-controller",
    "-n",
    namespace,
    "--",
    "node",
    "-e",
    "fetch(process.argv[1]).then((r) => console.log(r.status), (e) => console.log('ERR ' + String(e.cause?.code ?? e)))",
    url,
  ]);
}

async function expectStatusFromServiceThree(
  kube: Kube,
  namespace: string,
  url: string,
  status: number,
): Promise<void> {
  const seen = await eventually(
    () => {
      const out = fromServiceThree(kube, namespace, url)?.trim();
      return out === String(status) ? out : undefined;
    },
    60_000,
    `Service 3 nhận ${String(status)} từ ${url}`,
  );
  expect(seen).toBe(String(status));
}

/**
 * [Plan #66] Cổng nội bộ chỉ cho bên gọi thật; cổng công khai không phục vụ `/internal`.
 *
 * Dương bằng Service 3 thật tới cổng nội bộ của CẢ HAI service (Service 1 ← Service 3 không có đường E2E nào khác chạm
 * tới). Chốt `internalPortOnly` đo cùng lúc: route nội bộ có thật trả 401 (thiếu token và bí mật - Plan #67) qua cổng nội bộ, 404 qua cổng
 * công khai. Âm bằng pod thử nhãn lạ và namespace khác; đối chứng: cổng công khai vẫn mở cho mọi nguồn (luật 1).
 */
export async function expectInternalPortsOnlyForCallers(
  kube: Kube,
  namespace: string,
): Promise<void> {
  const flagInternal = endpointOf(kube, namespace, "internal-flag-service");
  const coreInternal = endpointOf(kube, namespace, "internal-core-backend");
  const flagPublic = endpointOf(kube, namespace, "flag-service");
  const positive = async (): Promise<void> => {
    await expectStatusFromServiceThree(
      kube,
      namespace,
      `http://${flagInternal}/healthz`,
      200,
    );
    await expectStatusFromServiceThree(
      kube,
      namespace,
      `http://${coreInternal}/healthz`,
      200,
    );
  };

  await positive();
  await expectStatusFromServiceThree(
    kube,
    namespace,
    `http://${flagInternal}/internal/stale-flags`,
    401,
  );
  await expectStatusFromServiceThree(
    kube,
    namespace,
    `http://${flagPublic}/internal/stale-flags`,
    404,
  );

  expect(
    await probe(kube, namespace, FOREIGN_LABEL, HTTP_PROBE, flagInternal),
    "âm: nhãn lạ tới cổng nội bộ",
  ).toBe(2);
  await inOtherNamespace(kube, async (other) => {
    expect(
      await probe(kube, other, "pd-controller", HTTP_PROBE, flagInternal),
      "âm: namespace khác, nhãn của bên gọi",
    ).toBe(2);
    expect(
      await probe(kube, other, FOREIGN_LABEL, HTTP_PROBE, flagPublic),
      "đối chứng: cổng công khai mở cho mọi nguồn",
    ).toBe(0);
  });

  await positive();
}
