import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import {
  BOOLEAN_VARIANTS,
  DEFAULT_ENVIRONMENTS,
  DEFAULT_RESOURCE_QUOTA,
  DEFAULT_STICKINESS_ATTRIBUTE,
  DOMAIN_CATALOG_SEED,
  env,
  SDK_KEY,
  TOTAL_BUCKETS,
} from "@udp/config";
import { flagServeDbSchema, type FlagServe } from "@udp/shared-types/evaluation";
import { createPgAdapter } from "../src/adapter.js";
import { PrismaClient } from "../src/generated/prisma/client.js";

/**
 * Dữ liệu mẫu cho môi trường dev.
 *
 * Ba nguyên tắc:
 *
 *  1. IDEMPOTENT — chạy bao nhiêu lần cũng ra cùng kết quả, nhờ UUID cố định +
 *     upsert thay vì để database tự sinh id.
 *  2. KHÔNG HARDCODE giá trị nghiệp vụ — mọi hằng số lấy từ @udp/config.
 *  3. Seed phải MINH HỌA ĐƯỢC thiết kế, không chỉ làm database hết rỗng. Cụ thể
 *     là mô hình rule hai nửa của §6.4: "ai khớp" tách khỏi "phục vụ gì".
 */

// Migrate và seed dùng kết nối session mode (§15.3, prisma.config.ts).
// Ở đây đọc thẳng process.env vì seed chạy qua `prisma db seed` nên dotenv đã nạp.
const connectionString =
  process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Thiếu DATABASE_URL_DIRECT (hoặc DATABASE_URL) trong .env");
}

// Dung chung factory voi runtime: TLS xac thuc day du bang CA da ghim, tran pool
// tuong minh. Seed chi can vai ket noi nen dat 2.
const prisma = new PrismaClient({
  adapter: createPgAdapter({ connectionString, max: 2 }),
});

// UUID cố định để seed idempotent — KHÔNG dùng ngoài môi trường dev.
const ID = {
  userOwner: "00000000-0000-4000-8000-000000000001",
  userAdmin: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000010",
  flagDarkMode: "00000000-0000-4000-8000-000000000020",
  flagCheckout: "00000000-0000-4000-8000-000000000021",
  segmentBeta: "00000000-0000-4000-8000-000000000030",
  // Variant cũng phải cố định. Để database tự sinh thì `serve` JSONB của rule
  // chứa UUID khác nhau trên mỗi máy, và không ai diff được hai database nữa —
  // đúng thứ nguyên tắc 1 ở đầu file muốn tránh.
  variantDarkOn: "00000000-0000-4000-8000-000000000040",
  variantDarkOff: "00000000-0000-4000-8000-000000000041",
  variantCheckoutLegacy: "00000000-0000-4000-8000-000000000042",
  variantCheckoutOptimized: "00000000-0000-4000-8000-000000000043",
  variantCheckoutExperimental: "00000000-0000-4000-8000-000000000044",
} as const;

/** Mật khẩu dev — chỉ dùng ở máy cá nhân */
const DEV_PASSWORD = "udp12345678";

/**
 * SDK key cố định để test SDK ngay mà không phải vào Portal tạo.
 * Database chỉ lưu HASH — đúng như §2.2, plaintext không nằm trong DB.
 */
const DEV_SERVER_KEY = `${SDK_KEY.serverPrefix}dev_0000000000000000000000000000`;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const slugifyNamespace = (project: string, env: string): string =>
  `udp-${project}-${env}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63);

// ============================================================
// Danh mục domain
// ============================================================

/**
 * Bảng `DomainCatalog` là khóa ngoại của `DomainConfig`, nên nó phải có dữ liệu
 * trước mọi thứ khác. Ở bản chạy thật, tiến trình khởi động đồng bộ bảng này từ
 * adapter registry; ở đây seed đóng vai trò đó cho tới khi registry tồn tại.
 *
 * Theo bất biến I29: chỉ UPSERT, không bao giờ DELETE — xóa hàng sẽ phá khóa
 * ngoại của những DomainConfig đã tồn tại.
 */
async function seedDomainCatalog(): Promise<void> {
  for (const entry of DOMAIN_CATALOG_SEED) {
    await prisma.domainCatalog.upsert({
      where: { domainType: entry.domainType },
      update: {
        tier: entry.tier,
        displayName: entry.displayName,
        defaultOrder: entry.defaultOrder,
        isAvailable: true,
      },
      create: entry,
    });
  }
}

// ============================================================
// Người dùng và project
// ============================================================

async function seedUsersAndProject() {
  // BCRYPT_ROUNDS chứ không phải 12 ghim cứng — nguyên tắc 2 của chính file này.
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, env.BCRYPT_ROUNDS);

  const owner = await prisma.user.upsert({
    where: { id: ID.userOwner },
    // Banner cuối seed IN RA mật khẩu và vai trò. Để `update: {}` thì đổi
    // DEV_PASSWORD rồi seed lại sẽ in mật khẩu MỚI trong khi database còn hash
    // CŨ — đăng nhập thất bại và nguyên nhân nằm ở chỗ khác hẳn.
    update: { passwordHash, platformRole: "USER" },
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
    update: { passwordHash, platformRole: "PLATFORM_ADMIN" },
    create: {
      id: ID.userAdmin,
      email: "admin@udp.local",
      name: "Platform Admin",
      passwordHash,
      platformRole: "PLATFORM_ADMIN",
    },
  });

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
      // WARN là mặc định cho BYOC: hết hạn thì cảnh báo, KHÔNG tự xóa tài nguyên
      // trong tài khoản của khách (§4.4).
      expiryAction: "WARN",
      members: { create: { userId: owner.id, projectRole: "OWNER" } },
    },
  });

  for (const spec of DEFAULT_ENVIRONMENTS) {
    await prisma.environment.upsert({
      where: { projectId_name: { projectId: project.id, name: spec.name } },
      // Đổi rank / isProduction trong DEFAULT_ENVIRONMENTS rồi seed lại PHẢI có
      // tác dụng. Để `update: {}` thì database giữ giá trị cũ và không báo gì —
      // seed vẫn "idempotent", nhưng idempotent về trạng thái CŨ.
      update: {
        rank: spec.rank,
        isProduction: spec.isProduction,
        autoDeploy: !spec.isProduction,
      },
      create: {
        projectId: project.id,
        name: spec.name,
        rank: spec.rank,
        isProduction: spec.isProduction,
        // Production không cho deploy tự động từ webhook (§8.3)
        autoDeploy: !spec.isProduction,
        k8sNamespace: slugifyNamespace(project.name, spec.name),
      },
    });
  }

  return { owner, project };
}

// ============================================================
// Feature flag
// ============================================================

/**
 * Validate `serve` TRƯỚC khi ghi xuống JSONB.
 *
 * Vì sao seed cũng phải validate chứ không chỉ service: cột `serve` là JSONB, nên
 * database nhận bất cứ hình dạng nào. Một lần gõ nhầm 20000/70000 sẽ được ghi
 * êm ru, và bug chỉ lộ ra khi SDK chia nhóm sai tỉ lệ — rất khó truy ngược.
 *
 * Dùng `safeParse` chứ không `parse`: seed được thiết kế idempotent và chạy lại
 * nhiều lần, nên khi hỏng phải nói rõ hỏng ở đâu thay vì ném một `ZodError` thô
 * giữa chừng.
 */
function checkedServe(serve: FlagServe): FlagServe {
  const result = flagServeDbSchema.safeParse(serve);
  if (!result.success) {
    const reason = result.error.issues.map((i) => i.message).join("; ");
    throw new Error(`serve không hợp lệ (${JSON.stringify(serve)}): ${reason}`);
  }
  return result.data;
}

/**
 * Flag `dark-mode` minh họa mô hình rule hai nửa của §6.4.
 *
 * Điểm đáng chú ý là rule thứ hai: canary 20% được biểu diễn bằng
 * `ruleType: ALL` (ai cũng khớp) + `serve` là một PHÂN PHỐI THEO TRỌNG SỐ.
 *
 * v3 có `ruleType: PERCENTAGE` gộp hai khái niệm vào một, và hệ quả là chia ba
 * variant bằng chuỗi rule cho ra 33/22/45 thay vì 33/33/34, vì rule thứ hai chỉ
 * nhận phần còn lại. Tách ra thì `ATTRIBUTE_BASED` + `distribution` diễn đạt được
 * "10% người dùng ở VN", điều mà v3 không làm được.
 *
 * Và quan trọng nhất: `serve.weights` CHÍNH LÀ thứ mà rollout FLAG_LEVEL ramp
 * (§7.7). Không tách hai nửa thì đóng góp C1 không có chỗ để tác động.
 */
async function seedDarkModeFlag(projectId: string) {
  const darkMode = await prisma.featureFlag.upsert({
    where: { id: ID.flagDarkMode },
    update: {},
    create: {
      id: ID.flagDarkMode,
      projectId,
      key: "dark-mode",
      description: "Giao diện tối — flag boolean đơn giản",
      flagType: "BOOLEAN",
      lifecycleStatus: "ACTIVE",
      stickinessAttribute: DEFAULT_STICKINESS_ATTRIBUTE,
      variants: {
        create: [
          { id: ID.variantDarkOn, key: BOOLEAN_VARIANTS.ON, value: true },
          { id: ID.variantDarkOff, key: BOOLEAN_VARIANTS.OFF, value: false },
        ],
      },
    },
    include: { variants: true },
  });

  const variantId = (key: string): string => {
    const found = darkMode.variants.find((v) => v.key === key);
    if (!found) throw new Error(`Không tìm thấy variant "${key}" của dark-mode`);
    return found.id;
  };

  const onId = variantId(BOOLEAN_VARIANTS.ON);
  const offId = variantId(BOOLEAN_VARIANTS.OFF);

  // Bước 3 của chuỗi tạo flag. `default_variant_id` là FK THẬT nên không gán
  // được ngay lúc INSERT flag — lúc đó variant chưa có id. Vì cột NULLABLE nên
  // ba bước INSERT flag → INSERT variant → UPDATE flag nằm gọn trong một
  // transaction; đó là lý do §2.2 không cần DEFERRABLE.
  await prisma.featureFlag.update({
    where: { id: darkMode.id },
    data: { defaultVariantId: offId },
  });

  // FlagEnvConfig cho TỪNG environment — bật ở dev, tắt ở staging và prod.
  // Đây chính là điều thiết kế v2 không biểu diễn được (ADR-04).
  for (const spec of DEFAULT_ENVIRONMENTS) {
    const environment = await prisma.environment.findUniqueOrThrow({
      where: { projectId_name: { projectId, name: spec.name } },
    });

    const cfg = await prisma.flagEnvConfig.upsert({
      where: {
        flagId_environmentId: {
          flagId: darkMode.id,
          environmentId: environment.id,
        },
      },
      // defaultVariantId nằm ở CẢ update lẫn create. Để riêng create thì hàng đã
      // tồn tại với default NULL sẽ không bao giờ được chữa, và seed mất tính
      // idempotent đúng ở chỗ nguyên tắc 1 của file này tuyên bố nó có.
      update: { defaultVariantId: offId },
      create: {
        flagId: darkMode.id,
        environmentId: environment.id,
        isEnabled: spec.name === "dev",
        defaultVariantId: offId,
      },
    });

    if (spec.name !== "dev") continue;

    const alreadySeeded = await prisma.flagTargetingRule.count({
      where: { flagEnvConfigId: cfg.id },
    });
    if (alreadySeeded > 0) continue;

    await prisma.flagTargetingRule.createMany({
      data: [
        {
          flagEnvConfigId: cfg.id,
          // NỬA MỘT: ai khớp — danh sách userId cụ thể
          ruleType: "USER_BASED",
          condition: { userIds: ["user-1", "user-2"] },
          // NỬA HAI: phục vụ gì — một variant duy nhất
          serve: checkedServe({ kind: "variant", variantId: onId }),
          // Salt cố định trong seed để chạy lại vẫn ra cùng nhóm. Ở code thật,
          // salt sinh ngẫu nhiên MỘT LẦN lúc tạo rule và KHÔNG đổi khi chỉnh
          // trọng số — đổi nó là bốc lại nhóm người dùng, vi phạm I1.
          bucketSalt: "seed-rule-user-based",
          description: "Nhóm nội bộ luôn thấy tính năng",
          priority: 0,
        },
        {
          flagEnvConfigId: cfg.id,
          // NỬA MỘT: mọi người đều khớp
          ruleType: "ALL",
          condition: {},
          // NỬA HAI: phân phối 20/80. Tổng weight = TOTAL_BUCKETS, không phải 100 —
          // 100_000 bucket cho phép ngưỡng tới 0,001%, nhu cầu thật khi canary
          // trên traffic lớn (§6.4).
          //
          // Dùng phép chia số nguyên thay vì `0.2 * TOTAL_BUCKETS`: nhân số thực
          // may mắn ra đúng với 0.2 và 0.8, nhưng `0.07 * 100_000` cho
          // 7000.000000000001 và `z.number().int()` sẽ từ chối. Bom hẹn giờ.
          serve: checkedServe({
            kind: "distribution",
            weights: [
              { variantId: onId, weight: (TOTAL_BUCKETS / 100) * 20 },
              { variantId: offId, weight: (TOTAL_BUCKETS / 100) * 80 },
            ],
          }),
          bucketSalt: "seed-rule-canary",
          description: "Canary 20% — đây là rule mà rollout FLAG_LEVEL sẽ ramp",
          priority: 1,
        },
      ],
    });
  }

  return darkMode;
}

/** Flag nhiều variant, còn DRAFT — SDK chưa nhận flag ở trạng thái này (§6.7) */
async function seedCheckoutFlag(projectId: string): Promise<void> {
  const checkout = await prisma.featureFlag.upsert({
    where: { id: ID.flagCheckout },
    update: {},
    create: {
      id: ID.flagCheckout,
      projectId,
      key: "checkout-algorithm",
      description: "Ba thuật toán checkout — flag nhiều variant",
      flagType: "STRING",
      lifecycleStatus: "DRAFT",
      // B2B: cả công ty cùng thấy hoặc cùng không, nên hash theo accountId
      stickinessAttribute: "accountId",
      variants: {
        create: [
          { id: ID.variantCheckoutLegacy, key: "legacy", value: "legacy" },
          { id: ID.variantCheckoutOptimized, key: "optimized", value: "optimized" },
          { id: ID.variantCheckoutExperimental, key: "experimental", value: "experimental" },
        ],
      },
    },
    include: { variants: true },
  });

  const legacy = checkout.variants.find((v) => v.key === "legacy");
  if (!legacy) throw new Error('Không tìm thấy variant "legacy" của checkout-algorithm');

  await prisma.featureFlag.update({
    where: { id: checkout.id },
    data: { defaultVariantId: legacy.id },
  });
}

async function seedSegment(projectId: string): Promise<void> {
  await prisma.segment.upsert({
    where: { id: ID.segmentBeta },
    update: {},
    create: {
      id: ID.segmentBeta,
      projectId,
      name: "beta-testers",
      description: "Người dùng gói premium ở Việt Nam",
      conditions: [
        { attribute: "plan", operator: "eq", value: "premium" },
        { attribute: "country", operator: "in", value: ["VN"] },
      ],
    },
  });
}

async function seedSdkKey(
  environmentId: string,
  createdById: string,
): Promise<void> {
  await prisma.sdkKey.upsert({
    where: { keyHash: sha256(DEV_SERVER_KEY) },
    // keySuffix nằm ở CẢ update lẫn create. Hàng đã tồn tại từ trước lần đổi cột
    // sẽ giữ giá trị cũ (tám ký tự ĐẦU) nếu chỉ đặt ở nhánh create, và seed mất
    // tính idempotent đúng ở chỗ nguyên tắc 1 của file này tuyên bố nó có.
    update: { keySuffix: DEV_SERVER_KEY.slice(-SDK_KEY.displaySuffixLength) },
    create: {
      environmentId,
      keyType: "SERVER",
      keyHash: sha256(DEV_SERVER_KEY),
      keySuffix: DEV_SERVER_KEY.slice(-SDK_KEY.displaySuffixLength),
      label: "seed — dev server key",
      createdById,
    },
  });
}

// ============================================================

async function main(): Promise<void> {
  await seedDomainCatalog();

  const { owner, project } = await seedUsersAndProject();

  const devEnv = await prisma.environment.findUniqueOrThrow({
    where: { projectId_name: { projectId: project.id, name: "dev" } },
  });

  await seedSdkKey(devEnv.id, owner.id);
  await seedDarkModeFlag(project.id);
  await seedCheckoutFlag(project.id);
  await seedSegment(project.id);

  console.log(`
Seed hoàn tất.

  Đăng nhập     dev@udp.local   / ${DEV_PASSWORD}
                admin@udp.local / ${DEV_PASSWORD}   (PLATFORM_ADMIN)

  Domain        ${DOMAIN_CATALOG_SEED.length} domain trong DomainCatalog
  Project       ${project.name} (${project.id})
  Environment   ${DEFAULT_ENVIRONMENTS.map((e) => e.name).join(", ")}

  SDK key (dev) ${DEV_SERVER_KEY}
                Database chỉ lưu hash — chuỗi này không đọc lại được từ DB.

  Flags         dark-mode           ACTIVE, bật ở dev
                                    rule 1: USER_BASED  → serve variant "on"
                                    rule 2: ALL         → serve distribution 20/80
                checkout-algorithm  DRAFT, 3 variant
`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
