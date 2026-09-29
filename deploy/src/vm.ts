import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { base64Key, rsaPrivateKeyBase64Pem } from "@udp/config/env-schema";
import { z } from "zod";
import { generateSecrets, IMAGES } from "./cluster.js";

/**
 * Hằng và cấu hình của UDP trên máy ảo công khai (Plan #52: Oracle Cloud Always Free, k3s một node) — MỘT nơi cho
 * script phát hành, khôi phục, chẩn đoán, E2E và test của overlay `vm`.
 */

/** Context của kubeconfig riêng mà `deploy/vm/bootstrap.sh` viết — mọi lệnh kubectl của máy ảo ghim nó */
export const VM_CONTEXT = "udp-vm";
export const VM_KUBECONFIG = join(homedir(), ".kube", "udp-vm.yaml");
export const VM_KUBECTL_PIN: readonly string[] = [
  "--kubeconfig",
  VM_KUBECONFIG,
  "--context",
  VM_CONTEXT,
];

/** Cấu hình theo máy (QĐ-4) — `bootstrap.sh` tạo mẫu, người vận hành điền; không bao giờ nằm trong repo */
export const VM_SETTINGS_PATH =
  process.env["UDP_VM_SETTINGS"] ?? join(homedir(), "udp", "vm.env");

/** URL của Pre-Authenticated Request chỉ-ghi (QĐ-7) — tách khỏi `udp-secrets` vì người vận hành xoay nó */
export const BACKUP_SECRET = "udp-backup";
export const TLS_SECRET = "udp-tls";
export const INGRESS_NAME = "udp";
/** Ingress chỉ-HTTP chỉ để chuyển hướng sang HTTPS — Traefik không cho Ingress có `tls` nhận HTTP */
export const HTTP_REDIRECT_INGRESS = "udp-http";

/** Giá trị giữ chỗ của overlay; bản phát hành thay bằng giá trị của máy — còn sót là test đỏ */
export const PLACEHOLDER_HOST = "udp.invalid";

/** Issuer OIDC của Service 1 nằm dưới tiền tố này — Ingress route nó về S1 (QĐ-5) */
export const OIDC_PATH = "/oidc";

/** Bề mặt công khai DUY NHẤT (QĐ-5): tiền tố → Service. `/internal`, `/metrics`, probe và Prometheus không có ở đây */
export const PUBLIC_ROUTES: readonly { prefix: string; service: string }[] = [
  { prefix: "/", service: "portal" },
  { prefix: "/sdk", service: "flag-service" },
  { prefix: "/ofrep", service: "flag-service" },
  { prefix: OIDC_PATH, service: "core-backend" },
  { prefix: "/webhooks/flagger", service: "pd-controller" },
];

export const TLS_ISSUERS = [
  "letsencrypt",
  "letsencrypt-staging",
  "self-signed",
] as const;
export type TlsIssuer = (typeof TLS_ISSUERS)[number];

/** Tên ClusterIssuer của overlay/component cho một lựa chọn trong `vm.env` */
export const issuerName = (issuer: TlsIssuer): string => `udp-${issuer}`;

/** Bộ image của máy ảo: như #49 trừ `sample-app` — không chạy đồ thí nghiệm trên máy công khai (QĐ-6) */
export const VM_IMAGES = IMAGES.filter((i) => i.name !== "udp/sample-app");

/** Tên miền có ít nhất hai nhãn, chữ thường, kết thúc bằng một nhãn chữ — không scheme, cổng hay dấu chấm cuối */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const vmSettingsSchema = z
  .object({
    UDP_PUBLIC_HOST: z
      .string()
      .regex(HOSTNAME, "tên miền chữ thường, không scheme/cổng/dấu chấm cuối")
      .refine(
        (v) => v !== PLACEHOLDER_HOST,
        "chưa điền — vẫn là giá trị giữ chỗ",
      ),
    ACME_EMAIL: z.string().email(),
    TLS_ISSUER: z.enum(TLS_ISSUERS).default("letsencrypt"),
    UDP_BACKUP_UPLOAD_URL: z
      .string()
      .url()
      .refine((v) => /^https?:$/.test(new URL(v).protocol), "phải là http(s)")
      .refine(
        (v) => v.endsWith("/"),
        "phải kết thúc bằng `/` — tên bản sao lưu nối vào sau",
      ),
    /** Khôi phục trên máy mới (QĐ-7): KEK cũ, để credential đã mã hoá trong bản dump giải được */
    UDP_KEK_V1: base64Key(32).optional(),
    UDP_OIDC_SIGNING_KEY: rsaPrivateKeyBase64Pem().optional(),
  })
  .strict();

export type VmSettings = z.infer<typeof vmSettingsSchema>;

/** Đọc `vm.env` (định dạng dotenv); gõ sai tên biến hay thiếu biến ⇒ ném với danh sách lỗi */
export function parseVmSettings(text: string): VmSettings {
  const parsed = vmSettingsSchema.safeParse(parseEnv(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(tệp)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Cấu hình máy ảo không hợp lệ:\n${issues}`);
  }
  return parsed.data;
}

export function readVmSettings(path: string = VM_SETTINGS_PATH): VmSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Không đọc được ${path} — chạy deploy/vm/bootstrap.sh rồi điền tệp đó (deploy/README.md)`,
    );
  }
  return parseVmSettings(text);
}

/** Tag bất biến của một bản phát hành (QĐ-3): 12 ký tự đầu của commit */
export function releaseTag(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`cần SHA đầy đủ 40 ký tự hex của commit, nhận "${sha}"`);
  }
  return sha.slice(0, 12);
}

export const publicOrigin = (settings: VmSettings): string =>
  `https://${settings.UDP_PUBLIC_HOST}`;

function newOidcSigningKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return Buffer.from(privateKey, "utf8").toString("base64");
}

/** Khoá mà `vm.env` được phép đặt sẵn cho Secret — chỉ dùng khi Secret còn chưa có khoá đó */
export const RECOVERY_KEYS = ["UDP_KEK_V1", "UDP_OIDC_SIGNING_KEY"] as const;

/**
 * Bộ bí mật của máy ảo (QĐ-8): bộ của #49 cộng khoá ký OIDC (issuer công khai, QĐ-5); khoá khôi phục trong
 * `vm.env` thay khoá sinh mới.
 */
export function generateVmSecrets(
  settings: VmSettings,
): Record<string, string> {
  const secrets: Record<string, string> = {
    ...generateSecrets(),
    UDP_OIDC_SIGNING_KEY: newOidcSigningKey(),
  };
  for (const key of RECOVERY_KEYS) {
    const value = settings[key];
    if (value !== undefined) secrets[key] = value;
  }
  return secrets;
}

/**
 * Khoá khôi phục mà `vm.env` đặt KHÁC giá trị Secret đang chạy. Đặt KEK vào `vm.env` sau khi Secret đã có sẽ bị
 * bỏ qua trong im lặng (Secret không bao giờ bị ghi đè) — người khôi phục tưởng credential giải được mà không.
 */
export function recoveryMismatches(
  settings: VmSettings,
  current: (key: string) => string | null,
): string[] {
  return RECOVERY_KEYS.filter((key) => {
    const wanted = settings[key];
    if (wanted === undefined) return false;
    const running = current(key);
    return running !== null && running !== wanted;
  });
}

export const backupSecretValues = (
  settings: VmSettings,
): Record<string, string> => ({
  UDP_BACKUP_UPLOAD_URL: settings.UDP_BACKUP_UPLOAD_URL,
});

export interface ReleaseInput {
  sha: string;
  settings: VmSettings;
  /** Đường tương đối từ thư mục bản phát hành tới `deploy/k8s/overlays/vm` */
  overlay: string;
  /** Đường tương đối từ thư mục bản phát hành tới `deploy/k8s/components` */
  components: string;
}

/** Component mang ClusterIssuer của một lựa chọn TLS — bản phát hành kèm đúng MỘT */
export const issuerComponent = (issuer: TlsIssuer): string =>
  issuer === "self-signed" ? "self-signed-tls" : "letsencrypt";

/**
 * Kustomization của MỘT bản phát hành (QĐ-4) — hàm thuần, ghi ra dạng JSON (JSON là YAML hợp lệ):
 * tag image theo commit, cấu hình theo host, host của Ingress thay giá trị giữ chỗ, và đúng một component issuer —
 * email ACME chỉ khi đó là Let's Encrypt.
 */
export function releaseKustomization(
  input: ReleaseInput,
): Record<string, unknown> {
  const { settings } = input;
  const host = settings.UDP_PUBLIC_HOST;
  const origin = publicOrigin(settings);
  const tag = releaseTag(input.sha);
  const ops = (list: readonly Record<string, unknown>[]): string =>
    JSON.stringify(list);
  const acme = settings.TLS_ISSUER !== "self-signed";
  return {
    apiVersion: "kustomize.config.k8s.io/v1beta1",
    kind: "Kustomization",
    resources: [input.overlay],
    components: [`${input.components}/${issuerComponent(settings.TLS_ISSUER)}`],
    images: VM_IMAGES.map((image) => ({ name: image.name, newTag: tag })),
    configMapGenerator: [
      {
        name: "udp-config",
        behavior: "merge",
        literals: [
          `CORS_ORIGIN=${origin}`,
          `COOKIE_DOMAIN=${host}`,
          `UDP_OIDC_ISSUER=${origin}${OIDC_PATH}`,
          `PD_CONTROLLER_WEBHOOK_URL=${origin}`,
        ],
      },
    ],
    patches: [
      {
        target: { kind: "Ingress", name: INGRESS_NAME },
        patch: ops([
          { op: "replace", path: "/spec/rules/0/host", value: host },
          { op: "replace", path: "/spec/tls/0/hosts/0", value: host },
          {
            op: "replace",
            path: "/metadata/annotations/cert-manager.io~1cluster-issuer",
            value: issuerName(settings.TLS_ISSUER),
          },
        ]),
      },
      {
        target: { kind: "Ingress", name: HTTP_REDIRECT_INGRESS },
        patch: ops([
          { op: "replace", path: "/spec/rules/0/host", value: host },
        ]),
      },
      ...(acme
        ? [
            {
              target: {
                kind: "ClusterIssuer",
                labelSelector: "udp.io/acme=true",
              },
              patch: ops([
                {
                  op: "replace",
                  path: "/spec/acme/email",
                  value: settings.ACME_EMAIL,
                },
              ]),
            },
          ]
        : []),
    ],
  };
}
