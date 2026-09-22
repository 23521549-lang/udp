import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { SEED_CHECKOUT_FLAG_KEY, SEED_IDS } from "@udp/db/seed-constants";

/**
 * Dựng MỘT rollout FLAG_LEVEL cho E5 đúng tham số của
 * `docs/measurements/E5-preregistration.md` §2 [v4.8] — qua API THẬT của
 * Service 1 (đăng nhập, cookie + CSRF), không ghi thẳng database.
 *
 *   pnpm --filter @udp/experiments e5-setup --password <mật khẩu dev của seed>
 *
 * Tiền đề: seed dev + `rehash`; S1, S2, S3, Prometheus, hai sample-app và tải
 * đang chạy (≥ 5 phút lưu lượng để probe pha 1 thấy workload). Rule được ramp là
 * rule phân phối cố định của seed (`SEED_IDS.ruleCheckoutV2`, baseline on 0%).
 * In ra id session để truyền cho `e5 --session`.
 */

const { values } = parseArgs({
  options: {
    email: { type: "string", default: "dev@udp.local" },
    password: { type: "string" },
    core: { type: "string", default: env.CORE_BACKEND_URL },
    workload: { type: "string", default: "sample-app" },
  },
});
if (values.password === undefined) {
  console.error("thiếu --password (mật khẩu dev mà seed in ra)");
  process.exit(1);
}

/** Tham số cố định của file đăng ký trước — đổi ở đây là một amendment */
const PREREGISTERED = {
  thresholds: {
    errorRate: 0.05,
    relativeErrorRate: 1.5,
    latencyP99Ms: 500,
    minErrors: 5,
    maxConsecutiveBreaches: 2,
  },
  stepPercent: 20,
  stepIntervalSeconds: 3_600,
  analysisIntervalSeconds: 30,
  metricWindowSeconds: 60,
  warmUpRequests: 100,
} as const;

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL_DIRECT,
  max: 1,
  cacheKey: `__udp_prisma_e5setup_${randomUUID()}`,
});

try {
  const devEnv = await admin.environment.findFirstOrThrow({
    where: { projectId: SEED_IDS.project, name: "dev" },
    select: { id: true },
  });
  const config = await admin.flagEnvConfig.findFirstOrThrow({
    where: {
      environmentId: devEnv.id,
      flag: { key: SEED_CHECKOUT_FLAG_KEY, projectId: SEED_IDS.project },
    },
    select: { id: true },
  });

  const login = await fetch(`${values.core}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: values.email, password: values.password }),
  });
  if (!login.ok) throw new Error(`đăng nhập S1 → ${String(login.status)}`);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const cookies = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const created = await fetch(
    `${values.core}/api/v1/projects/${SEED_IDS.project}/rollouts`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        scope: "FLAG_LEVEL",
        strategy: "CANARY",
        envId: devEnv.id,
        flagEnvConfigId: config.id,
        targetingRuleId: SEED_IDS.ruleCheckoutV2,
        targetVariantId: SEED_IDS.variantCheckoutV2On,
        workloadName: values.workload,
        ...PREREGISTERED,
      }),
    },
  );
  const body = (await created.json()) as { rollout?: { id: string } };
  if (!created.ok || body.rollout === undefined) {
    throw new Error(
      `tạo rollout → ${String(created.status)}: ${JSON.stringify(body)}`,
    );
  }
  console.log(body.rollout.id);
} finally {
  await admin.$disconnect();
}
