import { createHash } from "node:crypto";
import {
  readOnlyContext,
  type ClusterAccess,
  type DomainAdapter,
  type DomainToolConfig,
  type ObjectRef,
  type ReadOnlyClusterAccess,
} from "@udp/adapter-core";
import { REGISTRY_PULL_SECRET } from "../cluster/bootstrap.js";

/**
 * Khoá kéo image của project (Plan #35 QĐ-2, QĐ-3) — adapter KHAI cách dựng nó (export
 * `pullCredential`), nền tảng PHÂN PHỐI nó vào `udp-registry-pull` của mọi namespace environment.
 *
 * `.dockerconfigjson` chứa được nhiều `auths`, nên khoá của MỌI registry đang bật gộp vào một
 * Secret — không phải chọn provider. `udp-tooling` chỉ `get`/`update`/`patch` được đúng Secret
 * tên đó ở namespace environment (§12.2 sửa ở D-P26); bootstrap tạo nó rỗng, ở đây chỉ có patch.
 * Khoá chỉ sống trong bộ nhớ worker giữa lúc mở cấu hình và lúc patch.
 */

export interface PullCredential {
  /** Máy chủ registry như `docker login` dùng: `ghcr.io`, `https://index.docker.io/v1/` */
  server: string;
  username: string;
  password: string;
}

/** Export `pullCredential` của một adapter registry — `null` khi cấu hình không có khoá */
export type PullCredentialDeclaration = (
  config: DomainToolConfig,
) => PullCredential | null;

/** `.dockerconfigjson` — không khoá nào thì `{"auths":{}}`, không bao giờ vắng; theo thứ tự server */
export function dockerConfigOf(credentials: readonly PullCredential[]): string {
  const auths: Record<string, Record<string, string>> = {};
  for (const c of [...credentials].sort((a, b) =>
    a.server.localeCompare(b.server),
  )) {
    auths[c.server] = {
      username: c.username,
      password: c.password,
      auth: Buffer.from(`${c.username}:${c.password}`).toString("base64"),
    };
  }
  return JSON.stringify({ auths });
}

const refOf = (namespace: string): ObjectRef => ({
  apiVersion: "v1",
  kind: "Secret",
  namespace,
  name: REGISTRY_PULL_SECRET,
});

/** Ghi khoá (hay rỗng) vào `udp-registry-pull` của từng environment */
export async function syncRegistryPull(
  access: ClusterAccess,
  namespaces: readonly string[],
  credentials: readonly PullCredential[],
): Promise<void> {
  const client = await access.getClient("tooling");
  const data = dockerConfigOf(credentials);
  for (const namespace of namespaces) {
    await client.write("patch", refOf(namespace), {
      stringData: { ".dockerconfigjson": data },
    });
  }
}

/**
 * [Plan #61 61d-3b] Bản sao `udp-registry-pull` ở namespace HỆ THỐNG — nơi Kyverno đọc thông tin đăng nhập registry.
 *
 * Vì sao cần một hàm riêng chứ không thêm `systemNamespace` vào danh sách của `syncRegistryPull`: hai namespace đi
 * bằng hai verb khác nhau, vì hai quyền khác nhau. Ở namespace environment, `udp-tooling` chỉ `get/update/patch`
 * đúng Secret tên đó (§12.2 sửa ở D-P26) và bootstrap tạo nó rỗng trước — nên ở đó là `patch`. Ở `udp-system`,
 * `udp-tooling` có đủ quyền trên `secrets` nhưng bootstrap KHÔNG tạo Secret này, và bootstrap chỉ chạy lúc
 * PROVISION hay lúc thêm environment — nên thêm nó vào bootstrap thì cụm đang chạy không bao giờ nhận. `apply` với
 * thân đầy đủ giải quyết cả hai: không cần bootstrap lại, và hội tụ ở mỗi lượt áp.
 *
 * [CT-2] Kyverno đọc Secret bằng SecretLister của CHÍNH nó với namespace của nó làm mặc định
 * (`regcreds.RemoteOptsFromIvpolCredentials(..., config.KyvernoNamespace())`), nên bản ở namespace environment
 * policy không thấy. Hai release Kyverno được cài vào `ctx.systemNamespace` (`scope: "cluster"`), nên đây đúng là
 * namespace của Kyverno.
 *
 * Không mở rộng phạm vi lộ bí mật: trong `udp-system` chỉ `udp-tooling` đọc được Secret, và nó đã đọc được chính
 * những khoá này ở mọi namespace environment.
 */
export async function syncRegistryPullSystem(
  access: ClusterAccess,
  systemNamespace: string,
  credentials: readonly PullCredential[],
): Promise<void> {
  const client = await access.getClient("tooling");
  await client.write("apply", refOf(systemNamespace), {
    metadata: { name: REGISTRY_PULL_SECRET, namespace: systemNamespace },
    type: "kubernetes.io/dockerconfigjson",
    stringData: { ".dockerconfigjson": dockerConfigOf(credentials) },
  });
}

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** Namespace nào có `udp-registry-pull` LỆCH khoá mong muốn — so băm, không trả giá trị */
export async function registryPullDrift(
  access: ReadOnlyClusterAccess,
  namespaces: readonly string[],
  credentials: readonly PullCredential[],
): Promise<string[]> {
  const client = await access.getClient("tooling");
  const want = digest(dockerConfigOf(credentials));
  const drifted: string[] = [];
  for (const namespace of namespaces) {
    const found = await client.read<{ stringData?: Record<string, string> }>(
      "get",
      refOf(namespace),
    );
    const have = found?.stringData?.[".dockerconfigjson"];
    if (have === undefined || digest(have) !== want) drifted.push(namespace);
  }
  return drifted;
}

/**
 * Bọc `detectDrift` của một adapter registry: sạch ở phần của nó thì còn phải thấy
 * `udp-registry-pull` của mọi environment khớp khoá mong muốn. Chi tiết chỉ nêu namespace.
 */
export function withRegistryPullDrift(
  adapter: DomainAdapter,
  namespaces: readonly string[],
  credentials: readonly PullCredential[],
): DomainAdapter {
  return {
    ...adapter,
    detectDrift: async (ctx, config) => {
      const inner = await adapter.detectDrift(readOnlyContext(ctx), config);
      if (inner.status !== "SUCCESS" || inner.data?.drifted !== false) {
        return inner;
      }
      const drifted = await registryPullDrift(ctx.k8s, namespaces, credentials);
      return drifted.length === 0
        ? inner
        : {
            ...inner,
            data: {
              drifted: true,
              details: `${REGISTRY_PULL_SECRET} lệch ở ${drifted.join(", ")}`,
            },
          };
    },
  };
}

/** Khoá kéo của mọi domain đang bật có khai `pullCredential` — cấu hình đã MỞ bí mật */
export function pullCredentialsOf(
  domains: readonly {
    pullCredential: PullCredentialDeclaration | undefined;
    config: DomainToolConfig;
  }[],
): PullCredential[] {
  return domains.flatMap((d) => {
    const credential = d.pullCredential?.(d.config) ?? null;
    return credential === null ? [] : [credential];
  });
}
