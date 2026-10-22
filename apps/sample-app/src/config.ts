import { z } from "zod";

/**
 * Cấu hình của ứng dụng khách mẫu — đọc `process.env` như MỌI ứng dụng khách
 * (§11), không qua `@udp/config`: entry đó validate `.env` của chính UDP (database,
 * bí mật nội bộ) mà một ứng dụng khách không có và không được có.
 */

/** Tên workload hợp lệ của Kubernetes (DNS-1123) — `service_name` phải khớp `workloadName` */
const WORKLOAD_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const schema = z.object({
  UDP_FLAG_HOST: z.string().url(),
  UDP_SDK_KEY: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  OTEL_SERVICE_NAME: z.string().regex(WORKLOAD_NAME).default("sample-app"),
  CHAOS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  CHECKOUT_FLAG_KEY: z.string().min(1).default("checkout-v2"),
  /** ≥ 100: ở canary 20% còn ~20 user dò nằm ở nhánh `on` (T3 của E5) */
  PROBE_USERS: z.coerce.number().int().min(100).max(10_000).default(200),
});

export type SampleAppConfig = z.infer<typeof schema>;

export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): SampleAppConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Cấu hình sample-app sai: ${problems}`);
  }
  return parsed.data;
}
