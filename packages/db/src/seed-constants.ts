/**
 * Hằng của seed dev (`prisma/seed.ts`) — THUẦN, không import gì [v4.8].
 *
 * Cấu hình nằm ngoài database phải khớp dữ liệu seed: job `sample-app` của
 * Prometheus gắn `namespace` = `k8sNamespaceFor(SEED_PROJECT_NAME, SEED_IDS.project,
 * "dev")`, sample-app mặc định đánh giá `SEED_CHECKOUT_FLAG_KEY`. Test đọc hằng ở
 * đây (subpath `@udp/db/seed-constants`) mà không nạp entry chính của `@udp/db`
 * (validate `.env`) hay chạy seed (import `seed.ts` là kết nối và ghi database).
 *
 * UUID cố định để seed idempotent — KHÔNG dùng ngoài môi trường dev.
 */
export const SEED_PROJECT_NAME = "demo-service";

/** Flag BOOLEAN on/off, ACTIVE, bật ở dev — flag canary của sample-app */
export const SEED_CHECKOUT_FLAG_KEY = "checkout-v2";

export const SEED_IDS = {
  userOwner: "00000000-0000-4000-8000-000000000001",
  userAdmin: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000010",
  flagDarkMode: "00000000-0000-4000-8000-000000000020",
  flagCheckout: "00000000-0000-4000-8000-000000000021",
  segmentBeta: "00000000-0000-4000-8000-000000000030",
  // Variant cũng phải cố định. Để database tự sinh thì `serve` JSONB của rule
  // chứa UUID khác nhau trên mỗi máy, và không ai diff được hai database nữa —
  // đúng thứ nguyên tắc 1 của `prisma/seed.ts` muốn tránh.
  variantDarkOn: "00000000-0000-4000-8000-000000000040",
  variantDarkOff: "00000000-0000-4000-8000-000000000041",
  variantCheckoutLegacy: "00000000-0000-4000-8000-000000000042",
  variantCheckoutOptimized: "00000000-0000-4000-8000-000000000043",
  variantCheckoutExperimental: "00000000-0000-4000-8000-000000000044",
  // [v4.8] flag canary của sample-app (§13.4, E5)
  flagCheckoutV2: "00000000-0000-4000-8000-000000000022",
  variantCheckoutV2On: "00000000-0000-4000-8000-000000000045",
  variantCheckoutV2Off: "00000000-0000-4000-8000-000000000046",
  /** Rule phân phối on/off ở env dev — rule mà rollout FLAG_LEVEL của E5 ramp */
  ruleCheckoutV2: "00000000-0000-4000-8000-000000000050",
} as const;
