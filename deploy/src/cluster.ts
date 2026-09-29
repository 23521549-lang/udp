import { randomBytes } from "node:crypto";
import { k8sNamespaceFor } from "@udp/config/constants";
import { SEED_IDS, SEED_PROJECT_NAME } from "@udp/db/seed-constants";

/**
 * Hằng của bản triển khai UDP trong cluster (Plan #49) — MỘT nơi cho script dựng cụm, manifest (qua
 * test) và job migrate. Đổi ở đây mà quên manifest thì `tests/manifests.test.ts` đỏ.
 */

export const NAMESPACE = "udp";
/** Secret không commit: script sinh lần đầu, giữ nguyên các lần sau (dữ liệu PostgreSQL sống trên PVC) */
export const SECRET_NAME = "udp-secrets";
export const KIND_CLUSTER = "udp";
/**
 * Context kubeconfig mà `kind create cluster` tạo. MỌI lệnh kubectl của UDP ghim nó: context HIỆN TẠI của máy có
 * thể là một cụm cloud thật, và áp manifest demo (seed, mật khẩu sinh tại chỗ) vào đó là lỗi không lấy lại được.
 */
export const KUBE_CONTEXT = `kind-${KIND_CLUSTER}`;

/** Cổng trên máy của hai NodePort (`extraPortMappings` của kind) — banner của `up`, E2E và E9 đọc cùng chỗ */
export const HOST_PORTS = { portal: 8080, flagService: 3002 } as const;

/** Namespace env dev của project seed — sample-app chạy ở đó để nhãn `namespace` khớp dữ liệu (§7.4) */
export const SAMPLE_NAMESPACE = k8sNamespaceFor(
  SEED_PROJECT_NAME,
  SEED_IDS.project,
  "dev",
);

const POSTGRES_HOST = "postgres";
const DATABASE = "udp";
/** Owner của database trong cluster — cũng là POSTGRES_USER của image chính thức */
export const DATABASE_OWNER = "udp";

/** base64url: không ký tự nào phải thoát trong chuỗi kết nối hay trong SQL */
const secret = (bytes: number): string =>
  randomBytes(bytes).toString("base64url");

const urlOf = (user: string, password: string): string =>
  `postgresql://${user}:${password}@${POSTGRES_HOST}:5432/${DATABASE}`;

/**
 * Bộ bí mật của một cluster mới. PostgreSQL chạy TRONG cụm nên không có pooler: chuỗi "pooled" và
 * chuỗi session trùng nhau, và `LISTEN/NOTIFY` dùng được (§15.3) — hai cờ tăng tốc bật ở ConfigMap.
 */
export function generateSecrets(): Record<string, string> {
  const owner = secret(24);
  const s1 = secret(24);
  const s2 = secret(24);
  const s3 = secret(24);
  return {
    POSTGRES_PASSWORD: owner,
    UDP_S1_DB_PASSWORD: s1,
    UDP_S2_DB_PASSWORD: s2,
    UDP_S3_DB_PASSWORD: s3,
    DATABASE_URL: urlOf(DATABASE_OWNER, owner),
    DATABASE_URL_DIRECT: urlOf(DATABASE_OWNER, owner),
    DATABASE_URL_S1: urlOf("udp_s1", s1),
    DATABASE_URL_S2: urlOf("udp_s2", s2),
    DATABASE_URL_S2_DIRECT: urlOf("udp_s2", s2),
    DATABASE_URL_S3: urlOf("udp_s3", s3),
    DATABASE_URL_S3_DIRECT: urlOf("udp_s3", s3),
    JWT_ACCESS_SECRET: secret(48),
    JWT_REFRESH_SECRET: secret(48),
    UDP_KEK_V1: randomBytes(32).toString("base64"),
    INTERNAL_SERVICE_SECRET: secret(48),
  };
}

export interface ImageSpec {
  /** Tên image, không tag — trùng tên trong manifest */
  name: string;
  dockerfile: string;
  args: Readonly<Record<string, string>>;
}

/** Tag của image build tại chỗ — không registry nào, `kind load` nạp thẳng vào node */
export const IMAGE_TAG = "local";

const service = (name: string, pkg: string, dir: string): ImageSpec => ({
  name: `udp/${name}`,
  dockerfile: "deploy/docker/service.Dockerfile",
  args: { PKG: pkg, DIR: dir },
});

export const IMAGES: readonly ImageSpec[] = [
  service("core-backend", "@udp/core-backend", "services/core-backend"),
  service("flag-service", "@udp/flag-service", "services/flag-service"),
  service("pd-controller", "@udp/pd-controller", "services/pd-controller"),
  service("sample-app", "@udp/sample-app", "apps/sample-app"),
  {
    name: "udp/portal",
    dockerfile: "deploy/docker/portal.Dockerfile",
    args: {},
  },
  {
    name: "udp/migrate",
    dockerfile: "deploy/docker/migrate.Dockerfile",
    args: {},
  },
];

/** Máy ảo dùng tag theo commit (Plan #52 QĐ-3) */
export const imageRefWithTag = (image: ImageSpec, tag: string): string =>
  `${image.name}:${tag}`;

export const imageRef = (image: ImageSpec): string =>
  imageRefWithTag(image, IMAGE_TAG);
