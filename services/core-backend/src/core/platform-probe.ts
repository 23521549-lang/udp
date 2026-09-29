import { readFile } from "node:fs/promises";
import { caPinnedTransport, type KubeTransport } from "@udp/cluster-access";
import type { AdminPlatformWire } from "@udp/shared-types/wire";

/**
 * [v4.11, Plan #53 QĐ-6] Tín hiệu của CHÍNH cụm đang chạy UDP (máy ảo Oracle Always Free, cụm kind) —
 * không phải cụm của khách. Đọc Kubernetes API bằng ServiceAccount CHỈ-ĐỌC của Service 1
 * (`deploy/k8s/base/core-backend-rbac.yaml`): node và số đo của node (metrics-server), PVC của
 * PostgreSQL, CronJob sao lưu, Certificate của Ingress.
 *
 * Mỗi tín hiệu ĐỘC LẬP và không bao giờ đoán: đọc không được thì `unavailable` kèm lý do —
 * `NOT_IN_CLUSTER` (chạy ngoài cụm: máy dev, test), `NOT_CONFIGURED` (API trả 404: kind không có
 * cert-manager hay CronJob sao lưu, không có metrics-server), `FORBIDDEN` (403: RBAC thiếu), còn lại
 * `UNAVAILABLE`.
 *
 * Vận chuyển: `caPinnedTransport` với CA của chính cụm (`ca.crt` mà kubelet gắn vào pod). Đích là
 * API server trong cụm (`KUBERNETES_SERVICE_HOST`, do kubelet đặt) — không phải một URL người dùng
 * nhập, nên không cần egress guard chống SSRF như các lời gọi ra ngoài khác của Service 1.
 */

export type PlatformSignals = Omit<AdminPlatformWire, "release" | "checkedAt">;

export interface PlatformProbe {
  read(): Promise<PlatformSignals>;
}

type Unavailable = Extract<PlatformSignals["node"], { state: "unavailable" }>;
type Reason = Unavailable["reason"];
const unavailable = (reason: Reason): Unavailable => ({
  state: "unavailable",
  reason,
});

/** Chạy ngoài cụm: mọi tín hiệu nói đúng điều đó */
export const outsideClusterProbe: PlatformProbe = {
  read: () =>
    Promise.resolve({
      node: unavailable("NOT_IN_CLUSTER"),
      postgresVolume: unavailable("NOT_IN_CLUSTER"),
      backup: unavailable("NOT_IN_CLUSTER"),
      certificate: unavailable("NOT_IN_CLUSTER"),
    }),
};

/** Tên đối tượng của triển khai — CÙNG tên với manifest của `deploy/k8s` */
export const PLATFORM_OBJECTS = {
  postgresPvc: "data-postgres-0",
  backupCronJob: "udp-backup",
  certificate: "udp-tls",
} as const;

class KubeReadError extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}

/**
 * Số lượng của Kubernetes (`2`, `1500m`, `123456789n`, `12Gi`, `12582912Ki`, `20G`) ⇒ số thực theo
 * đơn vị gốc (lõi CPU, byte). Một chuỗi không đọc được là `NaN` — bên gọi coi là không có số.
 */
export function parseQuantity(q: string): number {
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(q.trim());
  if (m === null) return Number.NaN;
  const value = Number(m[1]);
  const unit = m[2] ?? "";
  const factor: Record<string, number> = {
    "": 1,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
  };
  const f = factor[unit];
  return f === undefined ? Number.NaN : value * f;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isoOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s !== null && !Number.isNaN(Date.parse(s))
    ? new Date(s).toISOString()
    : null;
};

export interface InClusterOptions {
  /** `https://10.43.0.1:443` */
  apiServer: string;
  namespace: string;
  transport: KubeTransport;
  /** Đọc lại MỖI lần: kubelet xoay token của ServiceAccount định kỳ */
  token: () => Promise<string>;
}

export function inClusterPlatformProbe(opts: InClusterOptions): PlatformProbe {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await opts.transport.request(`${opts.apiServer}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${await opts.token()}`,
          Accept: "application/json",
        },
      });
    } catch {
      throw new KubeReadError("UNAVAILABLE");
    }
    if (res.status === 404) throw new KubeReadError("NOT_CONFIGURED");
    if (res.status === 401 || res.status === 403) {
      throw new KubeReadError("FORBIDDEN");
    }
    if (!res.ok) throw new KubeReadError("UNAVAILABLE");
    try {
      return obj(await res.json());
    } catch {
      throw new KubeReadError("UNAVAILABLE");
    }
  };
  const settle = async <T extends { state: "ok" }>(
    read: () => Promise<T>,
  ): Promise<T | Unavailable> => {
    try {
      return await read();
    } catch (e) {
      return unavailable(e instanceof KubeReadError ? e.reason : "UNAVAILABLE");
    }
  };
  const ns = encodeURIComponent(opts.namespace);

  const node = () =>
    settle(async () => {
      const nodes = arr((await get("/api/v1/nodes")).items).map(obj);
      const usage = arr(
        (await get("/apis/metrics.k8s.io/v1beta1/nodes")).items,
      ).map(obj);
      const capacity = (key: string): number =>
        nodes.reduce(
          (s, n) =>
            s + parseQuantity(str(obj(obj(n.status).capacity)[key]) ?? ""),
          0,
        );
      const used = (key: string): number =>
        usage.reduce(
          (s, u) => s + parseQuantity(str(obj(u.usage)[key]) ?? ""),
          0,
        );
      const cpuCores = capacity("cpu");
      const memoryBytes = capacity("memory");
      const cpuUsedCores = used("cpu");
      const memoryUsedBytes = used("memory");
      if (
        nodes.length === 0 ||
        ![cpuCores, memoryBytes, cpuUsedCores, memoryUsedBytes].every(
          Number.isFinite,
        )
      ) {
        throw new KubeReadError("UNAVAILABLE");
      }
      const first = str(obj(nodes[0]?.metadata).name) ?? "node";
      return {
        state: "ok" as const,
        name:
          nodes.length === 1
            ? first
            : `${first} (+${String(nodes.length - 1)})`,
        cpuCores,
        cpuUsedCores: Math.round(cpuUsedCores * 1000) / 1000,
        memoryBytes: Math.round(memoryBytes),
        memoryUsedBytes: Math.round(memoryUsedBytes),
      };
    });

  const postgresVolume = () =>
    settle(async () => {
      const pvc = await get(
        `/api/v1/namespaces/${ns}/persistentvolumeclaims/${PLATFORM_OBJECTS.postgresPvc}`,
      );
      const capacityBytes = parseQuantity(
        str(obj(obj(pvc.status).capacity).storage) ?? "",
      );
      if (!Number.isFinite(capacityBytes) || capacityBytes <= 0) {
        throw new KubeReadError("UNAVAILABLE");
      }
      return { state: "ok" as const, capacityBytes: Math.round(capacityBytes) };
    });

  const backup = () =>
    settle(async () => {
      const cron = await get(
        `/apis/batch/v1/namespaces/${ns}/cronjobs/${PLATFORM_OBJECTS.backupCronJob}`,
      );
      const jobs = arr(
        (await get(`/apis/batch/v1/namespaces/${ns}/jobs`)).items,
      ).map(obj);
      // Lần thất bại gần nhất: Job của CronJob này (ownerReference) có điều kiện Failed
      const failures = jobs
        .filter((j) =>
          arr(obj(j.metadata).ownerReferences).some(
            (o) =>
              str(obj(o).kind) === "CronJob" &&
              str(obj(o).name) === PLATFORM_OBJECTS.backupCronJob,
          ),
        )
        .flatMap((j) =>
          arr(obj(j.status).conditions)
            .map(obj)
            .filter((c) => c.type === "Failed" && c.status === "True")
            .map((c) => isoOrNull(c.lastTransitionTime))
            .filter((t): t is string => t !== null),
        )
        .sort();
      return {
        state: "ok" as const,
        schedule: str(obj(cron.spec).schedule) ?? "",
        lastScheduleAt: isoOrNull(obj(cron.status).lastScheduleTime),
        lastSuccessAt: isoOrNull(obj(cron.status).lastSuccessfulTime),
        lastFailureAt: failures[failures.length - 1] ?? null,
      };
    });

  const certificate = () =>
    settle(async () => {
      const cert = await get(
        `/apis/cert-manager.io/v1/namespaces/${ns}/certificates/${PLATFORM_OBJECTS.certificate}`,
      );
      const ready = arr(obj(cert.status).conditions)
        .map(obj)
        .some((c) => c.type === "Ready" && c.status === "True");
      return {
        state: "ok" as const,
        name: PLATFORM_OBJECTS.certificate,
        ready,
        notAfter: isoOrNull(obj(cert.status).notAfter),
        issuer: str(obj(obj(cert.spec).issuerRef).name),
      };
    });

  return {
    async read() {
      const [n, p, b, c] = await Promise.all([
        node(),
        postgresVolume(),
        backup(),
        certificate(),
      ]);
      return { node: n, postgresVolume: p, backup: b, certificate: c };
    },
  };
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * Probe theo môi trường chạy: trong pod (kubelet đặt `KUBERNETES_SERVICE_HOST` và gắn token + CA của
 * ServiceAccount) ⇒ đọc API server của cụm; ngoài cụm ⇒ `outsideClusterProbe`.
 */
export async function platformProbeFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PlatformProbe> {
  const host = environment.KUBERNETES_SERVICE_HOST;
  if (host === undefined || host === "") return outsideClusterProbe;
  let ca: string;
  let namespace: string;
  try {
    ca = await readFile(`${SA_DIR}/ca.crt`, "utf8");
    namespace = (await readFile(`${SA_DIR}/namespace`, "utf8")).trim();
  } catch {
    // Pod chạy với automountServiceAccountToken: false — không có gì để đọc bằng
    return outsideClusterProbe;
  }
  const port = environment.KUBERNETES_SERVICE_PORT ?? "443";
  const hostPart = host.includes(":") ? `[${host}]` : host;
  return inClusterPlatformProbe({
    apiServer: `https://${hostPart}:${port}`,
    namespace,
    transport: caPinnedTransport(Buffer.from(ca, "utf8").toString("base64")),
    token: async () => (await readFile(`${SA_DIR}/token`, "utf8")).trim(),
  });
}
