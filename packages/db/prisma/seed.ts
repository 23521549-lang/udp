import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import {
  BOOLEAN_VARIANTS,
  DEFAULT_ENVIRONMENTS,
  DEFAULT_RESOURCE_QUOTA,
  DEFAULT_STICKINESS_ATTRIBUTE,
  SDK_KEY,
} from "@udp/config";

/**
 * Dữ liệu mẫu cho môi trường dev.
 *
 * Hai nguyên tắc:
 *
 *  1. IDEMPOTENT — chạy bao nhiêu lần cũng ra cùng một kết quả. Đạt được bằng
 *     cách dùng UUID cố định + upsert, thay vì để database tự sinh id. Nhờ vậy
 *     `pnpm db:seed` an toàn để chạy lại bất cứ lúc nào.
 *
 *  2. KHÔNG HARDCODE giá trị nghiệp vụ — mọi hằng số lấy từ @udp/config.
 *     Đổi TOTAL_BUCKETS hay DEFAULT_ENVIRONMENTS thì seed tự theo.
 */

const prisma = new PrismaClient();

// UUID cố định để seed idempotent — KHÔNG dùng ngoài môi trường dev.
const ID = {
  userOwner: "00000000-0000-4000-8000-000000000001",
  userAdmin: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000010",
  flagDarkMode: "00000000-0000-4000-8000-000000000020",
  flagCheckout: "00000000-0000-4000-8000-000000000021",
  segmentBeta: "00000000-0000-4000-8000-000000000030",
} as const;

/** Mật khẩu dev — chỉ dùng ở máy cá nhân */
const DEV_PASSWORD = "udp12345678";

/**
 * SDK key cố định để test SDK ngay mà không phải vào Portal tạo.
 * Database chỉ lưu HASH — đúng như thiết kế §2.2, plaintext không nằm trong DB.
 */
const DEV_SERVER_KEY = `${SDK_KEY.serverPrefix}dev_0000000000000000000000000000`;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const slugifyNamespace = (project: string, env: string): string =>
  `udp-${project}-${env}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 12);

  // ---------- Người dùng ----------
  const owner = await prisma.user.upsert({
    where: { id: ID.userOwner },
    update: {},
    create: {
      id: ID.userOwner,
      email: "dev@udp.local",
      name: "Dev User",
      passwordHash,
      platformRole: "USER",
    },
  });

  await prisma.user.upsert({
    where: { id: ID.userAdmin },
    update: {},
    create: {
      id: ID.userAdmin,
      email: "admin@udp.local",
      name: "Platform Admin",
      passwordHash,
      platformRole: "PLATFORM_ADMIN",
    },
  });

  // ---------- Project ----------
  const project = await prisma.project.upsert({
    where: { id: ID.project },
    update: {},
    create: {
      id: ID.project,
      ownerId: owner.id,
      name: "demo-service",
      creationMode: "CREATE_NEW",
      languageRuntime: "nodejs",
      status: "ACTIVE",
      resourceQuota: DEFAULT_RESOURCE_QUOTA,
      members: {
        create: { userId: owner.id, projectRole: "OWNER" },
      },
    },
  });

  // ---------- Environment (dev / staging / prod) ----------
  for (const spec of DEFAULT_ENVIRONMENTS) {
    await prisma.environment.upsert({
      where: { projectId_name: { projectId: project.id, name: spec.name } },
      update: {},
      create: {
        projectId: project.id,
        name: spec.name,
        rank: spec.rank,
        isProduction: spec.isProduction,
        k8sNamespace: slugifyNamespace(project.name, spec.name),
      },
    });
  }

  const devEnv = await prisma.environment.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "dev" } },
  });

  // ---------- SDK key ----------
  await prisma.sdkKey.upsert({
    where: { keyHash: sha256(DEV_SERVER_KEY) },
    update: {},
    create: {
      environmentId: devEnv.id,
      keyType: "SERVER",
      keyHash: sha256(DEV_SERVER_KEY),
      keyPrefix: DEV_SERVER_KEY.slice(0, SDK_KEY.displayPrefixLength),
      label: "seed — dev server key",
      createdById: owner.id,
    },
  });

  // ---------- Flag 1: boolean, bật ở dev, canary 20% ----------
  const darkMode = await prisma.featureFlag.upsert({
    where: { id: ID.flagDarkMode },
    update: {},
    create: {
      id: ID.flagDarkMode,
      projectId: project.id,
      key: "dark-mode",
      description: "Giao diện tối — flag boolean đơn giản",
      flagType: "BOOLEAN",
      defaultVariantKey: BOOLEAN_VARIANTS.OFF,
      lifecycleStatus: "ACTIVE",
      stickinessAttribute: DEFAULT_STICKINESS_ATTRIBUTE,
      variants: {
        create: [
          { key: BOOLEAN_VARIANTS.ON, value: true },
          { key: BOOLEAN_VARIANTS.OFF, value: false },
        ],
      },
    },
  });

  // FlagEnvConfig cho TỪNG environment — bật ở dev, tắt ở staging và prod.
  // Đây chính là điều thiết kế v2 không biểu diễn được (ADR-04).
  for (const spec of DEFAULT_ENVIRONMENTS) {
    const env = await prisma.environment.findUniqueOrThrow({
      where: { projectId_name: { projectId: project.id, name: spec.name } },
    });

    const cfg = await prisma.flagEnvConfig.upsert({
      where: {
        flagId_environmentId: { flagId: darkMode.id, environmentId: env.id },
      },
      update: {},
      create: {
        flagId: darkMode.id,
        environmentId: env.id,
        isEnabled: spec.name === "dev",
        defaultVariantKey: BOOLEAN_VARIANTS.OFF,
      },
    });

    // Chỉ dev có rule canary 20%
    if (spec.name !== "dev") continue;

    const existing = await prisma.flagTargetingRule.count({
      where: { flagEnvConfigId: cfg.id },
    });
    if (existing > 0) continue;

    await prisma.flagTargetingRule.createMany({
      data: [
        {
          flagEnvConfigId: cfg.id,
          ruleType: "USER_BASED",
          condition: { userIds: ["user-1", "user-2"] },
          variantKey: BOOLEAN_VARIANTS.ON,
          // Salt cố định trong seed để chạy lại vẫn ra cùng nhóm người dùng.
          // Ở code thật, salt sinh ngẫu nhiên MỘT LẦN lúc tạo rule và không đổi
          // khi chỉnh percentage — nếu đổi, nhóm người dùng bị xáo lại (I1).
          bucketSalt: "seed-rule-user-based",
          description: "Nhóm nội bộ luôn thấy tính năng",
          priority: 0,
        },
        {
          flagEnvConfigId: cfg.id,
          ruleType: "PERCENTAGE",
          condition: { percentage: 20 },
          variantKey: BOOLEAN_VARIANTS.ON,
          bucketSalt: "seed-rule-percentage",
          description: "Canary 20%",
          priority: 1,
        },
      ],
    });
  }

  // ---------- Flag 2: multivariate, còn DRAFT ----------
  await prisma.featureFlag.upsert({
    where: { id: ID.flagCheckout },
    update: {},
    create: {
      id: ID.flagCheckout,
      projectId: project.id,
      key: "checkout-algorithm",
      description: "Ba thuật toán checkout — flag nhiều variant",
      flagType: "STRING",
      defaultVariantKey: "legacy",
      lifecycleStatus: "DRAFT",
      stickinessAttribute: "accountId",
      variants: {
        create: [
          { key: "legacy", value: "legacy" },
          { key: "optimized", value: "optimized" },
          { key: "experimental", value: "experimental" },
        ],
      },
    },
  });

  // ---------- Segment tái sử dụng ----------
  await prisma.segment.upsert({
    where: { id: ID.segmentBeta },
    update: {},
    create: {
      id: ID.segmentBeta,
      projectId: project.id,
      name: "beta-testers",
      description: "Người dùng gói premium ở Việt Nam",
      conditions: [
        { attribute: "plan", operator: "eq", value: "premium" },
        { attribute: "country", operator: "in", value: ["VN"] },
      ],
    },
  });

  console.log(`
Seed hoàn tất.

  Đăng nhập     dev@udp.local   / ${DEV_PASSWORD}
                admin@udp.local / ${DEV_PASSWORD}   (PLATFORM_ADMIN)

  Project       ${project.name} (${project.id})
  Environment   ${DEFAULT_ENVIRONMENTS.map((e) => e.name).join(", ")}

  SDK key (dev) ${DEV_SERVER_KEY}
                Database chỉ lưu hash — chuỗi này không đọc lại được từ DB.

  Flags         dark-mode           ACTIVE, bật ở dev, canary 20%
                checkout-algorithm  DRAFT, 3 variant
`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());