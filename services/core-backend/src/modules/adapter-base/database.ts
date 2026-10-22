import { createHmac } from "node:crypto";
import { z } from "zod";
import { envLabelFor } from "@udp/config";
import type {
  AdapterEnvironment,
  ReadOnlyAdapterContext,
} from "@udp/adapter-core";
import type { CapabilityBinding, CapabilityId } from "@udp/shared-types";
import type { HelmChartRef } from "./helm.js";

/**
 * Phần chung của họ Database Operators (Plan #38 QĐ-2..QĐ-5).
 *
 * Operator cài bằng chart CHÍNH THỨC của nó, MỘT lần ở `udp-system`. Instance của mỗi environment
 * là chart `raw` mang CR của operator VIẾT RÕ trong mã adapter — không đoán tên giá trị của một
 * chart instance bên thứ ba, và CR đọc được, kiểm được. Instance cài vào namespace của environment
 * (`targetNamespace`), nên CR và Secret không mang namespace.
 *
 * Mật khẩu: operator tự sinh (CloudNativePG, K8ssandra) thì không có gì trong cấu hình; operator
 * đòi Secret có sẵn thì mật khẩu mỗi environment SUY từ MỘT bí mật cấu hình (`credentialSeed`) bằng
 * HMAC theo id environment — khác nhau giữa `dev` và `prod`, ổn định qua mọi lần áp (không drift
 * giả), và tới chart bằng `secretValuesFrom`, không bao giờ qua ConfigMap.
 */

/** Cấu hình chung của mọi instance: dung lượng mỗi bản sao, số bản sao ở production */
export const instanceFields = {
  storageGb: z.number().int().min(1).max(500).default(10),
  productionReplicas: z.number().int().min(1).max(5).default(3),
};

/** Bí mật gốc để suy mật khẩu từng environment */
export const credentialSeedField = z
  .string()
  .min(32)
  .max(256)
  .describe("secret");

export const replicasOf = (
  config: { productionReplicas: number },
  environment: AdapterEnvironment,
): number => (environment.isProduction ? config.productionReplicas : 1);

/** Mật khẩu của một environment: HMAC(seed, id env) — 32 ký tự base64url */
export const derivedPassword = (
  seed: string,
  environment: AdapterEnvironment,
): string =>
  createHmac("sha256", seed)
    .update(environment.id)
    .digest("base64url")
    .slice(0, 32);

/** `secretValues` của adapter: mật khẩu MỖI environment, khoá theo nhãn env */
export function passwordsByEnvironment(
  seed: string,
  ctx: ReadOnlyAdapterContext,
): Record<string, unknown> {
  return {
    credentials: Object.fromEntries(
      ctx.environments.map((e) => [
        envLabelFor(e.name),
        { password: derivedPassword(seed, e) },
      ]),
    ),
  };
}

/**
 * Secret đăng nhập dưới dạng template của chart `raw`: giá trị lấy từ `secretValues` lúc cài
 * (`index` vì nhãn env có thể mang dấu gạch).
 */
export function passwordSecretTemplate(
  name: string,
  environment: AdapterEnvironment,
  keys: Readonly<Record<string, string | "password">>,
): string {
  const label = envLabelFor(environment.name);
  const data = Object.entries(keys)
    .map(([key, value]) =>
      value === "password"
        ? `  ${key}: {{ index .Values.credentials "${label}" "password" | quote }}`
        : `  ${key}: ${JSON.stringify(value)}`,
    )
    .join("\n");
  return [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${name}`,
    "type: Opaque",
    "stringData:",
    data,
  ].join("\n");
}

/** Nhu cầu quota: một instance mỗi environment, dung lượng × mọi bản sao */
export function instanceDemand(
  config: { storageGb: number; productionReplicas: number },
  ctx: ReadOnlyAdapterContext,
  countsAsDatabase: boolean,
): { maxDatabases?: number; maxStorageGb: number } {
  const replicas = ctx.environments.reduce(
    (sum, e) => sum + replicasOf(config, e),
    0,
  );
  return {
    ...(countsAsDatabase ? { maxDatabases: ctx.environments.length } : {}),
    maxStorageGb: config.storageGb * replicas,
  };
}

/**
 * Binding THEO environment (QĐ-3): endpoint là DNS service trong namespace env; thông tin đăng
 * nhập chỉ bằng TÊN Secret (operator hay chart `raw` tạo nó trong CÙNG namespace).
 */
export function instanceBindings(
  ctx: ReadOnlyAdapterContext,
  options: {
    capability: Extract<CapabilityId, "db.instance" | "object.store">;
    providedBy: string;
    service: string;
    port: number;
    engine: string;
    secretName: string;
  },
): CapabilityBinding[] {
  return ctx.environments.map((e) => ({
    id: options.capability,
    version: "1.0.0",
    providedBy: options.providedBy,
    environmentId: e.id,
    endpoint: `${options.service}.${e.k8sNamespace}.svc.cluster.local:${String(options.port)}`,
    attributes: {
      engine: options.engine,
      port: String(options.port),
      secretName: options.secretName,
    },
  }));
}

/** Yêu cầu dung lượng của một PVC */
export const volumeClaim = (storageGb: number) => ({
  accessModes: ["ReadWriteOnce"],
  resources: { requests: { storage: `${String(storageGb)}Gi` } },
});
