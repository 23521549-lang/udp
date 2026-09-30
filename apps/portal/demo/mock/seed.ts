import type {
  AdminUserWire,
  AuditEntryWire,
  CloudCredentialWire,
  DeploymentWire,
  DomainCatalogEntryWire,
  DomainConfigFieldWire,
  FlagDetailWire,
  GrantableProjectRoleWire,
  JobDetailWire,
  ProjectClusterWire,
  ProjectDomainWire,
  ProjectInvitationWire,
  ProjectRoleWire,
  ProjectStatusWire,
  ProvisionPreviewWire,
  PublicEnvironmentWire,
  RolloutDetailWire,
  RolloutEventWire,
  RuleWire,
  SdkKeyWire,
  SegmentDetailWire,
  TeamInvitationWire,
  TeamRoleWire,
} from "@udp/shared-types/wire";
import { refreshMyAccess } from "./access";
import {
  dateDaysAgo,
  daysAgo,
  hoursAgo,
  hoursAhead,
  iso,
  minutesAgo,
  OPENED_AT,
} from "./clock";
import type {
  Db,
  DomainState,
  FlagRecord,
  InvitationToken,
  JobRecord,
  LiveRollout,
  ProjectRecord,
  TeamRecord,
} from "./db";
import { DEMO_INVITE_TOKEN } from "./demo-invite";
import { golden } from "./goldens";
import { crowd } from "./people";
import { between, hex, pick, prng, uuid } from "./random";

/**
 * Dữ liệu mẫu của bản xem thử: một nền tảng đang được một nhóm thương mại điện tử dùng thật — sáu project ở đủ
 * trạng thái (đang chạy, đang dựng, nháp, lỗi), flag đủ bốn kiểu với rule thật, rollout đang tiến, lịch sử deploy
 * ba mươi ngày cho DORA, domain đang chạy và lệch cấu hình. Mọi con số là MINH HOẠ.
 */

const rng = prng(20260929);
const newId = (): string => uuid(rng);

// ------------------------------------------------------------- người

interface Person {
  id: string;
  name: string;
  email: string;
  admin: boolean;
  joinedDaysAgo: number;
}

const person = (
  name: string,
  email: string,
  joinedDaysAgo: number,
  admin = false,
): Person => ({ id: newId(), name, email, admin, joinedDaysAgo });

const ANH = person("Nguyễn Minh Anh", "anh.nguyen@udp.dev", 420, true);
const BAO = person("Trần Quốc Bảo", "bao.tran@udp.dev", 380);
const HA = person("Lê Thu Hà", "ha.le@udp.dev", 350);
const HUY = person("Phạm Đức Huy", "huy.pham@udp.dev", 300);
const LAN = person("Võ Ngọc Lan", "lan.vo@udp.dev", 210);
const KHANH = person("Đặng Gia Khánh", "khanh.dang@udp.dev", 400, true);
const TUNG = person("Bùi Thanh Tùng", "tung.bui@udp.dev", 120);
const LINH = person("Hoàng Mai Linh", "linh.hoang@udp.dev", 90);
const PHAT = person("Ngô Tấn Phát", "phat.ngo@udp.dev", 45);
const YEN = person("Đỗ Hải Yến", "yen.do@udp.dev", 12);
const PEOPLE = [ANH, BAO, HA, HUY, LAN, KHANH, TUNG, LINH, PHAT, YEN];

// ------------------------------------------------------------- catalog domain

const CATALOG = golden<{ domains: DomainCatalogEntryWire[] }>(
  "GET /domains/catalog",
).domains;

// ------------------------------------------------------------- khung project

type Provider = "AWS" | "GCP" | "AZURE";
type EnvName = "dev" | "staging" | "prod";
const ENV_NAMES: readonly EnvName[] = ["dev", "staging", "prod"];

interface ProjectSpec {
  name: string;
  runtime: "nodejs" | "python";
  mode: "CREATE_NEW" | "IMPORT_EXISTING";
  status: ProjectStatusWire;
  /** `null` ⇒ người xem không là thành viên — chỉ trang quản trị thấy */
  myRole: ProjectRoleWire | null;
  owner: Person;
  members: [Person, Exclude<ProjectRoleWire, "OWNER">][];
  cloud?: { provider: Provider; region: string; validated: boolean };
  ageDays: number;
  maxNodes?: number;
  expiresInHours?: number;
  /** Mặc định là repo mẫu trên GitHub cùng tên */
  repoUrl?: string | null;
}

const AUTH_KIND = {
  AWS: "AWS_ROLE",
  GCP: "GCP_WIF",
  AZURE: "AZURE_FEDERATED",
} as const;

function clusterOf(spec: ProjectSpec): ProjectClusterWire | null {
  const { cloud } = spec;
  if (cloud === undefined || spec.status !== "ACTIVE") return null;
  const endpoint = {
    AWS: `https://${hex(rng, 32).toUpperCase()}.gr7.${cloud.region}.eks.amazonaws.com`,
    GCP: `https://34.126.${String(between(rng, 10, 250))}.${String(between(rng, 10, 250))}`,
    AZURE: `https://udp-${spec.name}-${hex(rng, 8)}.hcp.${cloud.region}.azmk8s.io:443`,
  }[cloud.provider];
  return {
    clusterId: `udp-${spec.name}`,
    apiEndpoint: endpoint,
    provider: cloud.provider,
    region: cloud.region,
  };
}

function environmentsOf(
  name: string,
  projectId: string,
): PublicEnvironmentWire[] {
  return ENV_NAMES.map((env, rank) => ({
    id: newId(),
    name: env,
    k8sNamespace: `udp-${name}-${projectId.slice(0, 6)}-${env}`,
    isProduction: env === "prod",
    rank,
    autoDeploy: env !== "prod",
  }));
}

function sdkKeysOf(env: PublicEnvironmentWire, creator: Person): SdkKeyWire[] {
  const key = (
    keyType: "SERVER" | "CLIENT",
    label: string | null,
    createdDaysAgo: number,
    revokedDaysAgo?: number,
  ): SdkKeyWire => {
    const suffix = hex(rng, 6);
    return {
      id: newId(),
      environmentId: env.id,
      keyType,
      label,
      keySuffix: suffix,
      maskedKey: `${keyType === "SERVER" ? "udp_sk" : "udp_ck"}_…${suffix}`,
      status: revokedDaysAgo === undefined ? "active" : "revoked",
      createdBy: { id: creator.id, name: creator.name },
      createdAt: daysAgo(createdDaysAgo),
      lastUsedAt:
        revokedDaysAgo === undefined
          ? minutesAgo(between(rng, 1, 30))
          : daysAgo(revokedDaysAgo + 1),
      revokedAt: revokedDaysAgo === undefined ? null : daysAgo(revokedDaysAgo),
    };
  };
  return [
    key("SERVER", `${env.name}-backend`, 90),
    key("CLIENT", `${env.name}-web`, 60),
    key("SERVER", "ci-smoke-test", 40, 21),
  ];
}

function cloudOf(spec: ProjectSpec): CloudCredentialWire | null {
  const { cloud } = spec;
  if (cloud === undefined) return null;
  return {
    provider: cloud.provider,
    mode: "BYOC",
    authKind: AUTH_KIND[cloud.provider],
    federated: true,
    region: cloud.region,
    fingerprint: hex(rng, 12),
    lastValidatedAt: cloud.validated ? hoursAgo(between(rng, 2, 40)) : null,
    createdAt: daysAgo(spec.ageDays - 1),
    createdBy: { id: spec.owner.id, email: spec.owner.email },
  };
}

// ------------------------------------------------------------- flag

type FlagValue = boolean | string | number | Record<string, unknown>;
type FlagType = FlagDetailWire["flagType"];

interface RuleSpec {
  type: RuleWire["ruleType"];
  when?: { attribute: string; operator: string; value: unknown }[];
  users?: string[];
  segment?: string;
  /** Key variant, hoặc chia tỉ lệ `[key, phần trăm]` */
  serve: string | [string, number][];
  description?: string;
}

interface FlagSpec {
  key: string;
  type: FlagType;
  description: string;
  variants?: [string, FlagValue][];
  default: string;
  lifecycle?: FlagDetailWire["lifecycleStatus"];
  permanent?: boolean;
  ageDays: number;
  /** Bật ở dev, staging, prod */
  enabled: [boolean, boolean, boolean];
  rules?: Partial<Record<EnvName, RuleSpec[]>>;
  /** Lượt đánh giá mỗi ngày ở prod (0 = không ai đọc) */
  traffic: number;
  /** Tỉ lệ variant quan sát được ở prod */
  mix?: Record<string, number>;
  stale?: FlagRecord["stale"];
  lastEvaluatedDaysAgo?: number;
}

const BOOL: [string, FlagValue][] = [
  ["off", false],
  ["on", true],
];

const ENV_TRAFFIC: Record<EnvName, number> = {
  dev: 0.04,
  staging: 0.12,
  prod: 1,
};

function seriesOf(base: number): number[] {
  const out: number[] = [];
  for (let d = 29; d >= 0; d--) {
    const weekday = new Date(OPENED_AT - d * 86_400_000).getUTCDay();
    const weekly = weekday === 0 || weekday === 6 ? 0.62 : 1;
    out.push(Math.round(base * weekly * (0.85 + rng() * 0.3)));
  }
  return out;
}

function buildFlag(
  spec: FlagSpec,
  environments: PublicEnvironmentWire[],
  segmentIds: Record<string, string>,
): FlagRecord {
  const variants = (spec.variants ?? BOOL).map(([key, value]) => ({
    id: newId(),
    key,
    value,
  }));
  const variantId = (key: string): string => {
    const found = variants.find((v) => v.key === key);
    if (found === undefined)
      throw new Error(`${spec.key}: không có variant ${key}`);
    return found.id;
  };
  const lifecycle = spec.lifecycle ?? "ACTIVE";
  const createdAt = daysAgo(spec.ageDays);
  const updatedAt = hoursAgo(Math.min(spec.ageDays * 24, between(rng, 3, 150)));

  const rules: Record<string, RuleWire[]> = {};
  const rulesUpdatedAt: Record<string, string> = {};
  const daily: Record<string, number[]> = {};
  const mix: Record<string, Record<string, number>> = {};
  const envs = environments.map((env, i) => {
    const envName = env.name as EnvName;
    const envRules = (spec.rules?.[envName] ?? []).map(
      (r, index): RuleWire => ({
        id: newId(),
        priority: (index + 1) * 10,
        ruleType: r.type,
        condition:
          r.type === "ALL"
            ? {}
            : r.type === "USER_BASED"
              ? { userIds: r.users ?? [] }
              : r.type === "SEGMENT"
                ? { segmentId: segmentIds[r.segment ?? ""] ?? newId() }
                : { all: r.when ?? [] },
        serve:
          typeof r.serve === "string"
            ? { kind: "variant", variantId: variantId(r.serve) }
            : {
                kind: "distribution",
                weights: r.serve.map(([key, percent]) => ({
                  weight: percent * 1000,
                  variantId: variantId(key),
                })),
              },
        description: r.description ?? null,
      }),
    );
    rules[env.id] = envRules;
    rulesUpdatedAt[env.id] = updatedAt;
    const live = lifecycle !== "ARCHIVED" && spec.traffic > 0;
    daily[env.id] = seriesOf(live ? spec.traffic * ENV_TRAFFIC[envName] : 0);
    mix[env.id] = spec.mix ?? { [spec.default]: 1 };
    return {
      environment: {
        id: env.id,
        name: env.name,
        isProduction: env.isProduction,
      },
      configId: newId(),
      isEnabled: spec.enabled[i] ?? false,
      defaultVariantId: null,
      isTracked: false,
      ruleCount: envRules.length,
      updatedAt,
    };
  });

  return {
    detail: {
      id: newId(),
      key: spec.key,
      flagType: spec.type,
      description: spec.description,
      lifecycleStatus: lifecycle,
      stickinessAttribute: "targetingKey",
      defaultVariantId: variantId(spec.default),
      permanent: spec.permanent ?? false,
      activatedAt: lifecycle === "DRAFT" ? null : daysAgo(spec.ageDays - 1),
      createdAt,
      updatedAt,
      variants,
      envs,
    },
    rules,
    rulesUpdatedAt,
    daily,
    mix,
    lastEvaluatedAt:
      spec.traffic > 0
        ? minutesAgo(between(rng, 1, 9))
        : spec.lastEvaluatedDaysAgo === undefined
          ? null
          : daysAgo(spec.lastEvaluatedDaysAgo),
    ...(spec.stale === undefined ? {} : { stale: spec.stale }),
  };
}

const CHECKOUT_FLAGS: FlagSpec[] = [
  {
    key: "new-checkout-flow",
    type: "BOOLEAN",
    description:
      "Luồng thanh toán một trang thay cho ba bước cũ, đang canary ở prod",
    default: "off",
    ageDays: 21,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      staging: [{ type: "ALL", serve: "on" }],
      prod: [
        {
          type: "ALL",
          serve: [
            ["on", 30],
            ["off", 70],
          ],
          description: "Canary do UDP điều khiển",
        },
      ],
    },
    traffic: 48_200,
    mix: { on: 0.3, off: 0.7 },
  },
  {
    key: "payment-provider",
    type: "STRING",
    description: "Cổng thanh toán mặc định theo thị trường và gói khách hàng",
    variants: [
      ["vnpay", "vnpay"],
      ["momo", "momo"],
      ["zalopay", "zalopay"],
      ["stripe", "stripe"],
    ],
    default: "vnpay",
    ageDays: 160,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "momo" }],
      staging: [
        {
          type: "ATTRIBUTE_BASED",
          when: [{ attribute: "country", operator: "eq", value: "VN" }],
          serve: "momo",
        },
      ],
      prod: [
        {
          type: "SEGMENT",
          segment: "enterprise-accounts",
          serve: "stripe",
          description: "Khách doanh nghiệp thanh toán quốc tế",
        },
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "country", operator: "eq", value: "VN" },
            {
              attribute: "platform",
              operator: "in",
              value: ["ios", "android"],
            },
          ],
          serve: "momo",
          description: "Ví điện tử cho di động trong nước",
        },
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "country", operator: "in", value: ["SG", "MY", "TH"] },
          ],
          serve: "stripe",
        },
      ],
    },
    traffic: 61_500,
    mix: { vnpay: 0.41, momo: 0.46, stripe: 0.11, zalopay: 0.02 },
  },
  {
    key: "checkout-button-color",
    type: "STRING",
    description: "Màu nút Thanh toán: thử nghiệm A/B đã chốt xanh lá",
    variants: [
      ["blue", "#2563eb"],
      ["green", "#16a34a"],
    ],
    default: "green",
    ageDays: 75,
    enabled: [true, true, true],
    rules: {
      staging: [
        {
          type: "ATTRIBUTE_BASED",
          when: [{ attribute: "cohort", operator: "eq", value: "exp-2026-07" }],
          serve: [
            ["blue", 50],
            ["green", 50],
          ],
        },
      ],
    },
    traffic: 39_900,
    mix: { green: 1 },
    stale: "SETTLED",
  },
  {
    key: "max-cart-items",
    type: "NUMBER",
    description: "Số món tối đa trong giỏ, tăng cho khách doanh nghiệp",
    variants: [
      ["standard", 50],
      ["large", 200],
    ],
    default: "standard",
    ageDays: 200,
    enabled: [true, true, true],
    rules: {
      prod: [
        { type: "SEGMENT", segment: "enterprise-accounts", serve: "large" },
      ],
    },
    traffic: 22_300,
    mix: { standard: 0.93, large: 0.07 },
  },
  {
    key: "free-shipping-threshold",
    type: "NUMBER",
    description: "Ngưỡng miễn phí vận chuyển (VND)",
    variants: [
      ["300k", 300_000],
      ["500k", 500_000],
      ["0", 0],
    ],
    default: "500k",
    ageDays: 140,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "SEGMENT",
          segment: "high-value-customers",
          serve: "0",
          description: "Khách giá trị cao luôn miễn phí vận chuyển",
        },
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "city", operator: "in", value: ["HCM", "HN", "DN"] },
          ],
          serve: "300k",
        },
      ],
    },
    traffic: 31_800,
    mix: { "500k": 0.52, "300k": 0.39, "0": 0.09 },
  },
  {
    key: "recommendation-engine",
    type: "JSON",
    description: "Cấu hình gợi ý sản phẩm ở giỏ hàng",
    variants: [
      ["v1", { model: "collab-filter-v1", topK: 4, fallback: "bestsellers" }],
      [
        "v2",
        {
          model: "two-tower-v2",
          topK: 8,
          fallback: "bestsellers",
          diversity: 0.3,
        },
      ],
    ],
    default: "v1",
    ageDays: 33,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "v2" }],
      staging: [{ type: "ALL", serve: "v2" }],
      prod: [
        {
          type: "SEGMENT",
          segment: "beta-testers",
          serve: "v2",
          description: "Nhóm thử nghiệm nội bộ",
        },
      ],
    },
    traffic: 28_700,
    mix: { v1: 0.97, v2: 0.03 },
  },
  {
    key: "beta-wallet",
    type: "BOOLEAN",
    description: "Ví UDP Pay cho nhóm beta",
    default: "off",
    ageDays: 18,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      prod: [
        { type: "SEGMENT", segment: "beta-testers", serve: "on" },
        { type: "SEGMENT", segment: "internal-staff", serve: "on" },
      ],
    },
    traffic: 12_400,
    mix: { off: 0.96, on: 0.04 },
  },
  {
    key: "dark-mode",
    type: "BOOLEAN",
    description: "Giao diện tối cho web và app",
    default: "on",
    ageDays: 110,
    enabled: [true, true, true],
    rules: {
      prod: [
        { type: "ALL", serve: "on", description: "Đã lên 100% qua canary" },
      ],
    },
    traffic: 44_100,
    mix: { on: 1 },
    stale: "SETTLED",
  },
  {
    key: "rate-limit-strategy",
    type: "STRING",
    description: "Thuật toán giới hạn tần suất của API giỏ hàng",
    variants: [
      ["token-bucket", "token-bucket"],
      ["sliding-window", "sliding-window"],
    ],
    default: "token-bucket",
    ageDays: 95,
    enabled: [true, true, true],
    rules: {
      staging: [{ type: "ALL", serve: "sliding-window" }],
    },
    traffic: 18_900,
    mix: { "token-bucket": 1 },
  },
  {
    key: "search-v2",
    type: "BOOLEAN",
    description: "Tìm kiếm ngữ nghĩa: canary prod bị rollback tự động",
    default: "off",
    ageDays: 12,
    enabled: [true, true, false],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      staging: [{ type: "ALL", serve: "on" }],
    },
    traffic: 9_800,
    mix: { off: 1 },
  },
  {
    key: "address-autocomplete",
    type: "BOOLEAN",
    description:
      "Công tắc khẩn cấp cho gợi ý địa chỉ (phụ thuộc dịch vụ bản đồ)",
    default: "on",
    permanent: true,
    ageDays: 300,
    enabled: [true, true, true],
    traffic: 27_600,
    mix: { on: 1 },
  },
  {
    key: "express-delivery",
    type: "BOOLEAN",
    description: "Giao hàng hoả tốc 2 giờ, đang chờ đối tác vận chuyển",
    default: "off",
    lifecycle: "DRAFT",
    ageDays: 4,
    enabled: [true, false, false],
    rules: {
      dev: [
        {
          type: "USER_BASED",
          users: ["user-qa-01", "user-qa-02", "user-qa-07"],
          serve: "on",
        },
      ],
    },
    traffic: 0,
  },
  {
    key: "loyalty-points",
    type: "BOOLEAN",
    description: "Tích điểm thành viên: bản nháp chưa ai đụng tới",
    default: "off",
    lifecycle: "DRAFT",
    ageDays: 64,
    enabled: [false, false, false],
    traffic: 0,
    stale: "STALE_DRAFT",
  },
  {
    key: "legacy-coupon-api",
    type: "BOOLEAN",
    description: "Đường gọi API mã giảm giá cũ",
    default: "off",
    ageDays: 240,
    enabled: [false, false, false],
    traffic: 0,
    stale: "UNUSED",
    lastEvaluatedDaysAgo: 47,
  },
  {
    key: "holiday-banner-2025",
    type: "BOOLEAN",
    description: "Banner Tết 2025",
    default: "off",
    lifecycle: "ARCHIVED",
    ageDays: 280,
    enabled: [false, false, false],
    traffic: 0,
  },
  {
    key: "min-app-version",
    type: "STRING",
    description: "Phiên bản app tối thiểu được thanh toán trong app",
    variants: [
      ["2.8", "2.8.0"],
      ["3.0", "3.0.0"],
    ],
    default: "2.8",
    ageDays: 58,
    enabled: [true, true, true],
    rules: {
      prod: [{ type: "SEGMENT", segment: "legacy-app-versions", serve: "3.0" }],
    },
    traffic: 15_200,
    mix: { "2.8": 0.88, "3.0": 0.12 },
  },
];

/** Bộ flag gọn cho các project khác — cùng khuôn, ít hơn */
function smallFlagSet(
  domain: "payment" | "mobile" | "billing" | "draft" | "search" | "web",
): FlagSpec[] {
  const common: FlagSpec[] = [
    {
      key: "maintenance-mode",
      type: "BOOLEAN",
      description: "Tạm ngưng nhận giao dịch mới",
      default: "off",
      permanent: true,
      ageDays: 80,
      enabled: [true, true, true],
      traffic: 8_000,
      mix: { off: 1 },
    },
  ];
  const specific: Record<typeof domain, FlagSpec[]> = {
    payment: [
      {
        key: "3ds-v2",
        type: "BOOLEAN",
        description: "Xác thực 3-D Secure 2 cho thẻ quốc tế",
        default: "off",
        ageDays: 40,
        enabled: [true, true, true],
        rules: {
          prod: [
            {
              type: "ATTRIBUTE_BASED",
              when: [
                {
                  attribute: "cardNetwork",
                  operator: "in",
                  value: ["visa", "mastercard"],
                },
              ],
              serve: [
                ["on", 50],
                ["off", 50],
              ],
            },
          ],
        },
        traffic: 14_000,
        mix: { on: 0.5, off: 0.5 },
      },
      {
        key: "settlement-batch-size",
        type: "NUMBER",
        description: "Số giao dịch mỗi lô đối soát",
        variants: [
          ["500", 500],
          ["2000", 2000],
        ],
        default: "500",
        ageDays: 70,
        enabled: [true, true, true],
        traffic: 900,
        mix: { "500": 1 },
      },
      {
        key: "fraud-model",
        type: "JSON",
        description: "Ngưỡng mô hình chống gian lận",
        variants: [
          ["strict", { threshold: 0.62, reviewQueue: true }],
          ["balanced", { threshold: 0.78, reviewQueue: true }],
        ],
        default: "balanced",
        ageDays: 55,
        enabled: [true, true, true],
        traffic: 14_000,
        mix: { balanced: 1 },
      },
    ],
    mobile: [
      {
        key: "home-feed-v3",
        type: "BOOLEAN",
        description: "Bố cục trang chủ mới cho app",
        default: "off",
        ageDays: 16,
        enabled: [true, true, true],
        rules: {
          prod: [
            {
              type: "ATTRIBUTE_BASED",
              when: [
                {
                  attribute: "appVersion",
                  operator: "semverGt",
                  value: "3.1.0",
                },
              ],
              serve: "on",
            },
          ],
        },
        traffic: 52_000,
        mix: { on: 0.34, off: 0.66 },
      },
      {
        key: "image-cdn",
        type: "STRING",
        description: "CDN ảnh sản phẩm",
        variants: [
          ["cloudfront", "cloudfront"],
          ["bunny", "bunny"],
        ],
        default: "cloudfront",
        ageDays: 120,
        enabled: [true, true, true],
        traffic: 52_000,
        mix: { cloudfront: 1 },
      },
    ],
    billing: [
      {
        key: "invoice-pdf-v2",
        type: "BOOLEAN",
        description: "Mẫu hoá đơn PDF mới",
        default: "off",
        ageDays: 25,
        enabled: [true, false, false],
        traffic: 0,
        lastEvaluatedDaysAgo: 9,
      },
    ],
    search: [
      {
        key: "semantic-ranking",
        type: "BOOLEAN",
        description: "Xếp hạng kết quả theo ngữ nghĩa thay cho BM25",
        default: "off",
        ageDays: 9,
        enabled: [true, true, true],
        rules: {
          dev: [{ type: "ALL", serve: "on" }],
          prod: [
            {
              type: "ALL",
              serve: [
                ["on", 20],
                ["off", 80],
              ],
              description: "Canary do UDP điều khiển",
            },
          ],
        },
        traffic: 73_000,
        mix: { on: 0.2, off: 0.8 },
      },
      {
        key: "typo-tolerance",
        type: "NUMBER",
        description: "Số ký tự sai tối đa được bỏ qua khi tìm",
        variants: [
          ["strict", 1],
          ["loose", 2],
        ],
        default: "strict",
        ageDays: 140,
        enabled: [true, true, true],
        traffic: 73_000,
        mix: { strict: 1 },
      },
    ],
    web: [
      {
        key: "hero-banner-variant",
        type: "STRING",
        description: "Ảnh bìa trang chủ cho chiến dịch 10/10",
        variants: [
          ["classic", "classic"],
          ["sale-1010", "sale-1010"],
        ],
        default: "classic",
        ageDays: 6,
        enabled: [true, true, false],
        traffic: 0,
        lastEvaluatedDaysAgo: 1,
      },
      {
        key: "newsletter-popup",
        type: "BOOLEAN",
        description: "Hộp đăng ký bản tin khi rời trang",
        default: "off",
        ageDays: 45,
        enabled: [true, true, true],
        rules: {
          prod: [
            {
              type: "ATTRIBUTE_BASED",
              when: [{ attribute: "returning", operator: "eq", value: false }],
              serve: "on",
            },
          ],
        },
        traffic: 21_000,
        mix: { off: 0.64, on: 0.36 },
      },
    ],
    draft: [
      {
        key: "report-export",
        type: "BOOLEAN",
        description: "Xuất báo cáo CSV",
        default: "off",
        lifecycle: "DRAFT",
        ageDays: 3,
        enabled: [true, false, false],
        traffic: 0,
      },
    ],
  };
  return [...common, ...specific[domain]];
}

// ------------------------------------------------------------- segment

interface SegmentSpec {
  name: string;
  description: string;
  all?: { attribute: string; operator: string; value: unknown }[];
  userIds?: string[];
  ageDays: number;
}

const CHECKOUT_SEGMENTS: SegmentSpec[] = [
  {
    name: "beta-testers",
    description: "Khách đăng ký chương trình dùng thử tính năng mới",
    userIds: [
      "cus-10231",
      "cus-10388",
      "cus-11002",
      "cus-11574",
      "cus-12090",
      "cus-12211",
      "cus-13007",
      "cus-13450",
      "cus-14118",
      "cus-14902",
      "cus-15533",
      "cus-16021",
    ],
    ageDays: 60,
  },
  {
    name: "enterprise-accounts",
    description: "Tài khoản gói doanh nghiệp",
    all: [{ attribute: "plan", operator: "eq", value: "enterprise" }],
    ageDays: 150,
  },
  {
    name: "high-value-customers",
    description: "Tổng chi tiêu từ 10 triệu đồng",
    all: [{ attribute: "lifetimeValue", operator: "gte", value: 10_000_000 }],
    ageDays: 130,
  },
  {
    name: "internal-staff",
    description: "Nhân viên, theo email công ty",
    all: [{ attribute: "email", operator: "endsWith", value: "@udp.dev" }],
    ageDays: 200,
  },
  {
    name: "vn-mobile-users",
    description: "Người dùng app di động tại Việt Nam",
    all: [
      { attribute: "country", operator: "eq", value: "VN" },
      { attribute: "platform", operator: "in", value: ["ios", "android"] },
    ],
    ageDays: 95,
  },
  {
    name: "legacy-app-versions",
    description: "App dưới 3.0, sắp ngừng hỗ trợ",
    all: [{ attribute: "appVersion", operator: "semverLt", value: "3.0.0" }],
    ageDays: 45,
  },
];

function buildSegment(spec: SegmentSpec): SegmentDetailWire {
  const conditions = { all: spec.all ?? [], userIds: spec.userIds ?? [] };
  const at = daysAgo(spec.ageDays);
  return {
    id: newId(),
    name: spec.name,
    description: spec.description,
    createdAt: at,
    updatedAt: daysAgo(Math.max(0, spec.ageDays - between(rng, 1, 20))),
    summary: {
      conditionCount: conditions.all.length,
      userIdCount: conditions.userIds.length,
      hasRegex: conditions.all.some((c) => c.operator === "regex"),
      payloadBytes: JSON.stringify(conditions).length,
    },
    conditions: conditions as SegmentDetailWire["conditions"],
    usage: { flagCount: 0, productionFlagCount: 0, flags: [] },
  };
}

/** `usage` của segment đếm từ rule SEGMENT của flag — cùng cách Service 1 đếm */
export function refreshSegmentUsage(p: ProjectRecord): void {
  for (const segment of p.segments) {
    const flags = p.flags.filter(
      (f) => f.detail.lifecycleStatus !== "ARCHIVED",
    );
    const users = flags.flatMap((f) => {
      const envs = p.environments.filter((env) =>
        (f.rules[env.id] ?? []).some(
          (r) =>
            r.ruleType === "SEGMENT" &&
            (r.condition as { segmentId?: string }).segmentId === segment.id,
        ),
      );
      return envs.length === 0
        ? []
        : [
            {
              flagId: f.detail.id,
              flagKey: f.detail.key,
              lifecycleStatus: f.detail.lifecycleStatus,
              envs: envs.map((e) => ({
                id: e.id,
                name: e.name,
                isProduction: e.isProduction,
              })),
            },
          ];
    });
    segment.usage = {
      flagCount: users.length,
      productionFlagCount: users.filter((u) =>
        u.envs.some((e) => e.isProduction),
      ).length,
      flags: users,
    };
  }
}

// ------------------------------------------------------------- deployment + DORA

function deploymentsFor(
  env: PublicEnvironmentWire,
  workload: string,
  perDay: number,
  failRate: number,
  logs: ProjectRecord["deploymentLogs"],
  repo: string,
): DeploymentWire[] {
  // Lịch 30 ngày: mỗi lần lỗi kéo theo một bản sửa sau 30–80 phút (MTTR của DORA có mẫu thật)
  const latest = OPENED_AT - 600_000;
  const plan: { at: number; failed: boolean }[] = [];
  for (let d = 29; d >= 0; d--) {
    const count = rng() < perDay % 1 ? Math.ceil(perDay) : Math.floor(perDay);
    for (let i = 0; i < count; i++) {
      const at = OPENED_AT - d * 86_400_000 - between(rng, 1, 20) * 3_600_000;
      if (at > latest) continue;
      const failed = rng() < failRate;
      plan.push({ at, failed });
      const fix = at + between(rng, 30, 80) * 60_000;
      if (failed && fix < latest) plan.push({ at: fix, failed: false });
    }
  }
  // Phiên bản tăng theo ĐÚNG thứ tự thời gian
  plan.sort((a, b) => a.at - b.at);

  const out: DeploymentWire[] = [];
  let minor = 12;
  let patch = 0;
  for (const { at: startMs, failed } of plan) {
    patch += 1;
    if (patch > 9) {
      minor += 1;
      patch = 0;
    }
    const tag = `v1.${String(minor)}.${String(patch)}`;
    const sha = hex(rng, 12);
    const id = newId();
    const endMs = startMs + between(rng, 180, 720) * 1000;
    const started = {
      id: newId(),
      eventType: "DEPLOY_START" as const,
      occurredAt: iso(startMs),
    };
    const concluded = {
      id: newId(),
      eventType: failed
        ? ("DEPLOY_FAILURE" as const)
        : ("DEPLOY_SUCCESS" as const),
      occurredAt: iso(endMs),
    };
    out.push({
      deploymentId: id,
      status: concluded.eventType,
      workloadName: workload,
      imageTag: tag,
      commitSha: sha,
      triggeredBy: "WEBHOOK",
      rolloutSessionId: null,
      restoresDeploymentId: null,
      startedAt: iso(startMs),
      lastEventAt: iso(endMs),
      events: [started, concluded],
    });
    const common = {
      triggeredBy: "WEBHOOK" as const,
      workloadName: workload,
      imageTag: tag,
      commitSha: sha,
    };
    logs[id] = [
      {
        ...started,
        ...common,
        pipelineId: `run-${String(between(rng, 18_000, 19_999))}`,
        detail: {
          repo,
          ref: "main",
          environment: env.name,
          token: "[REDACTED]",
        },
      },
      {
        ...concluded,
        ...common,
        pipelineId: null,
        detail: failed
          ? {
              reason: pick(rng, [
                "Readiness probe thất bại: GET /healthz trả 503 sau 120 giây",
                "Image không kéo được: manifest unknown",
                "Rollout vượt progressDeadlineSeconds (600)",
              ]),
            }
          : { readyReplicas: env.isProduction ? 4 : 2 },
      },
    ];
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// ------------------------------------------------------------- domain

interface DomainPick {
  tool: string;
  config?: Record<string, unknown>;
  status?: ProjectDomainWire["status"];
}

const SAMPLE_STRINGS: Record<string, (project: string) => string> = {
  repository: (p) => `udp-demo/${p}`,
  owner: () => "udp-demo",
  repoUrl: () => "https://github.com/udp-demo/gitops-environments",
  registryName: () => "udpdemo",
  projectId: () => "udp-demo-prod",
};

function toolConfigOf(
  fields: DomainConfigFieldWire[],
  project: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.key in overrides) {
      config[field.key] = overrides[field.key];
      continue;
    }
    if (field.secret === true) {
      if (field.required) config[field.key] = { $udpSecret: "kept" };
      continue;
    }
    if (field.default !== undefined) {
      config[field.key] = field.default;
      continue;
    }
    if (!field.required) continue;
    switch (field.kind) {
      case "string":
        config[field.key] = (SAMPLE_STRINGS[field.key] ?? (() => field.key))(
          project,
        );
        break;
      case "number":
        config[field.key] = field.min ?? 1;
        break;
      case "boolean":
        config[field.key] = false;
        break;
      case "enum":
        config[field.key] = field.options?.[0] ?? "";
        break;
      case "json":
        config[field.key] = {};
        break;
    }
  }
  return config;
}

export function domainsOf(
  project: string,
  picks: Partial<Record<string, DomainPick>>,
  preferences: DomainState["preferences"],
  updatedDaysAgo: number,
): DomainState {
  const drift: DomainState["drift"] = {};
  const versions: DomainState["versions"] = {};
  const domains = [...CATALOG]
    .sort((a, b) => a.defaultOrder - b.defaultOrder)
    .map((entry): ProjectDomainWire => {
      const choice = picks[entry.domainType];
      const tool = entry.tools.find((t) => t.toolId === choice?.tool);
      if (choice === undefined || tool === undefined) {
        return {
          domainType: entry.domainType,
          isEnabled: false,
          selectedTool: null,
          toolConfig: null,
          status: null,
          adapterVersion: null,
          updatedAt: null,
        };
      }
      drift[entry.domainType] = {
        verdict: "CLEAN",
        message: null,
        at: minutesAgo(between(rng, 20, 340)),
      };
      versions[entry.domainType] = {
        domainType: entry.domainType,
        toolId: tool.toolId,
        current: tool.version,
        available: [],
      };
      return {
        domainType: entry.domainType,
        isEnabled: true,
        selectedTool: tool.toolId,
        toolConfig:
          tool.config.kind === "object"
            ? toolConfigOf(tool.config.fields, project, choice.config)
            : (choice.config ?? {}),
        status: choice.status ?? "ACTIVE",
        adapterVersion: tool.version,
        updatedAt: daysAgo(updatedDaysAgo),
      };
    });
  return { domainSetVersion: 7, domains, preferences, drift, versions };
}

// ------------------------------------------------------------- provisioning

const AWS_STEPS = {
  network: [
    ["vpc", "VPC", "vpc"],
    ["subnet-public-a", "Subnet", "subnet"],
    ["subnet-public-b", "Subnet", "subnet"],
    ["subnet-private-a", "Subnet", "subnet"],
    ["subnet-private-b", "Subnet", "subnet"],
    ["igw", "InternetGateway", "igw"],
    ["eip", "ElasticIp", "eipalloc"],
    ["nat", "NatGateway", "nat"],
    ["rtb-public", "RouteTable", "rtb"],
    ["rtb-private", "RouteTable", "rtb"],
  ],
  cluster: [
    ["sg", "SecurityGroup", "sg"],
    ["iam-cluster", "IamRole", "arn:aws:iam::381492000150:role/udp"],
    ["iam-node", "IamRole", "arn:aws:iam::381492000150:role/udp"],
    [
      "cluster",
      "EksCluster",
      "arn:aws:eks:ap-southeast-1:381492000150:cluster/udp",
    ],
    [
      "oidc",
      "OidcProvider",
      "arn:aws:iam::381492000150:oidc-provider/oidc.eks",
    ],
    [
      "nodegroup",
      "EksNodegroup",
      "arn:aws:eks:ap-southeast-1:381492000150:nodegroup/udp",
    ],
  ],
} as const;

const GCP_STEPS = {
  network: [
    ["vpc", "Network", "projects/udp-demo-prod/global/networks/udp"],
    [
      "subnet",
      "Subnetwork",
      "projects/udp-demo-prod/regions/asia-southeast1/subnetworks/udp",
    ],
    [
      "router",
      "Router",
      "projects/udp-demo-prod/regions/asia-southeast1/routers/udp",
    ],
    ["nat", "RouterNat", "udp-nat"],
  ],
  cluster: [
    [
      "service-account",
      "ServiceAccount",
      "udp-nodes@udp-demo-prod.iam.gserviceaccount.com",
    ],
    [
      "cluster",
      "GkeCluster",
      "projects/udp-demo-prod/locations/asia-southeast1/clusters/udp",
    ],
    [
      "node-pool",
      "GkeNodePool",
      "projects/udp-demo-prod/locations/asia-southeast1/clusters/udp/nodePools/default",
    ],
  ],
} as const;

const AZURE_STEPS = {
  network: [
    [
      "resource-group",
      "ResourceGroup",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp",
    ],
    [
      "vnet",
      "VirtualNetwork",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp/providers/Microsoft.Network/virtualNetworks/udp",
    ],
    [
      "subnet-nodes",
      "Subnet",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp/providers/Microsoft.Network/virtualNetworks/udp/subnets/nodes",
    ],
    [
      "public-ip",
      "PublicIpAddress",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp/providers/Microsoft.Network/publicIPAddresses/udp-nat",
    ],
    [
      "nat-gateway",
      "NatGateway",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp/providers/Microsoft.Network/natGateways/udp",
    ],
  ],
  cluster: [
    [
      "identity",
      "UserAssignedIdentity",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp/providers/Microsoft.ManagedIdentity/userAssignedIdentities/udp",
    ],
    [
      "aks-cluster",
      "ManagedCluster",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp/providers/Microsoft.ContainerService/managedClusters/udp",
    ],
    [
      "node-pool",
      "AgentPool",
      "/subscriptions/5f2c8a31-0d7e-4b6f-9a1e-3c2b7d4e9f10/resourceGroups/udp/providers/Microsoft.ContainerService/managedClusters/udp/agentPools/default",
    ],
  ],
} as const;

const STEPS = { AWS: AWS_STEPS, GCP: GCP_STEPS, AZURE: AZURE_STEPS };

type Resource = JobDetailWire["resources"][number];

export function resourcesOf(
  provider: Provider,
  status: Resource["status"],
  at: string,
): Resource[] {
  const steps = STEPS[provider];
  const make =
    (step: "NETWORK" | "CLUSTER") =>
    ([name, kind, prefix]: readonly [string, string, string]): Resource => ({
      step,
      kind,
      name,
      status,
      providerId:
        provider === "AWS" && !prefix.includes(":")
          ? `${prefix}-0${hex(rng, 16)}`
          : `${prefix}`,
      updatedAt: at,
    });
  return [
    ...steps.network.map(make("NETWORK")),
    ...steps.cluster.map(make("CLUSTER")),
  ];
}

function previewOf(
  provider: Provider,
  region: string,
  blockers: ProvisionPreviewWire["blockers"],
  nodeCount: number,
): ProvisionPreviewWire {
  const steps = STEPS[provider];
  const perNode = { AWS: 121.47, GCP: 97.09, AZURE: 110.96 }[provider];
  const breakdown = [
    {
      item: "control-plane",
      monthlyUsd: provider === "AWS" ? 73 : provider === "GCP" ? 73 : 0,
    },
    { item: "nat-gateway", monthlyUsd: provider === "AWS" ? 32.85 : 32.4 },
    { item: "load-balancer", monthlyUsd: provider === "AWS" ? 16.43 : 18.26 },
    { item: "nodes", monthlyUsd: Math.round(perNode * nodeCount * 100) / 100 },
  ];
  return {
    provider,
    region,
    cluster: { nodeSize: "medium", nodeCount },
    cost: {
      monthlyUsd:
        Math.round(breakdown.reduce((s, b) => s + b.monthlyUsd, 0) * 100) / 100,
      breakdown,
      isEstimate: true,
      pricingAsOf: "2026-09-01",
    },
    steps: {
      network: steps.network.map(([name]) => name),
      cluster: steps.cluster.map(([name]) => name),
    },
    deployOrder: [
      ["container_registry:ghcr"],
      ["monitoring:prometheus-grafana", "logging:loki"],
      ["service_mesh:istio", "ingress:nginx"],
      ["progressive_delivery:argo-rollouts"],
    ],
    estimatedMinutes:
      provider === "AWS" ? { min: 15, max: 25 } : { min: 8, max: 14 },
    requiresConfirmation: true,
    blockers,
  };
}

function job(
  type: JobDetailWire["job"]["jobType"],
  state: JobDetailWire["job"]["state"],
  createdDaysAgo: number,
  monthlyUsd: number | null,
): JobDetailWire["job"] {
  return {
    id: newId(),
    jobType: type,
    state,
    attempt: 0,
    confirmedMonthlyUsd: monthlyUsd,
    lastError: null,
    cancellable: !["DONE", "FAILED", "COMPENSATION_FAILED"].includes(state),
    createdAt: daysAgo(createdDaysAgo),
    updatedAt: daysAgo(Math.max(0, createdDaysAgo - 0.02)),
  };
}

// ------------------------------------------------------------- rollout

interface RolloutSpec {
  flag?: string;
  env: EnvName;
  scope: RolloutDetailWire["scope"];
  strategy: RolloutDetailWire["strategy"];
  status: RolloutDetailWire["status"];
  percent: number;
  controlMode?: RolloutDetailWire["controlMode"];
  workload: string;
  versions?: [string, string];
  startedHoursAgo: number;
  failReason?: string;
  /** Mốc % đã đi qua (sự kiện PROMOTE) */
  steps: number[];
  end?: "COMPLETE" | "ROLLBACK" | "PAUSE";
  live?: { step: number; everySeconds: number; upTo: number };
}

function snapshot(
  canaryErrorRate: number,
  baselineErrorRate: number,
  at: string,
  workload: string,
): RolloutDetailWire["latestMetricSnapshot"] {
  const requests = between(rng, 900, 2400);
  return {
    canary: {
      requestCount: requests,
      errorCount: Math.round(requests * canaryErrorRate),
      errorRate: canaryErrorRate,
      latencyP99Ms: between(rng, 180, 420),
      hasData: true,
    },
    baseline: {
      requestCount: requests * 3,
      errorCount: Math.round(requests * 3 * baselineErrorRate),
      errorRate: baselineErrorRate,
      latencyP99Ms: between(rng, 170, 380),
      hasData: true,
    },
    zScore: Math.round((canaryErrorRate - baselineErrorRate) * 1000) / 10,
    queries: {
      canary: [
        `sum(rate(http_requests_total{namespace="…",service_name="${workload}",ff_variant="canary",code=~"5.."}[1m]))`,
      ],
      baseline: [
        `sum(rate(http_requests_total{namespace="…",service_name="${workload}",ff_variant="baseline",code=~"5.."}[1m]))`,
      ],
    },
    windowSeconds: 60,
    at,
  };
}

function buildRollout(
  p: ProjectRecord,
  spec: RolloutSpec,
  owner: Person,
): { detail: RolloutDetailWire; live?: LiveRollout } {
  const env = p.environments.find((e) => e.name === spec.env);
  if (env === undefined) throw new Error(`không có env ${spec.env}`);
  const flag = p.flags.find((f) => f.detail.key === spec.flag);
  const startMs = OPENED_AT - spec.startedHoursAgo * 3_600_000;
  const stepMs = (spec.startedHoursAgo * 3_600_000) / (spec.steps.length + 1);
  const events: RolloutEventWire[] = spec.steps.map((percent, i) => {
    const at = iso(startMs + stepMs * (i + 1));
    return {
      id: newId(),
      action: "PROMOTE",
      isIntent: false,
      processedAt: at,
      trafficPercentage: percent,
      reason: `Canary khoẻ: lỗi ${(0.2 + rng() * 0.6).toFixed(2)}% ≤ ngưỡng 5%, p99 trong ngưỡng`,
      triggeredBy: "AUTO",
      actorUserId: null,
      causedByEventId: null,
      metricSnapshot: snapshot(0.004, 0.005, at, spec.workload) ?? null,
      createdAt: at,
    };
  });
  if (spec.end !== undefined) {
    const at = iso(startMs + stepMs * (spec.steps.length + 0.6));
    events.push({
      id: newId(),
      action: spec.end,
      isIntent: spec.end === "PAUSE",
      processedAt: at,
      trafficPercentage: spec.end === "ROLLBACK" ? 0 : spec.percent,
      reason:
        spec.end === "ROLLBACK"
          ? (spec.failReason ?? null)
          : spec.end === "PAUSE"
            ? "Tạm dừng để kiểm tra log thanh toán"
            : "Đạt 100%, đóng session",
      triggeredBy: spec.end === "PAUSE" ? "MANUAL" : "AUTO",
      actorUserId: spec.end === "PAUSE" ? owner.id : null,
      causedByEventId: null,
      metricSnapshot:
        spec.end === "ROLLBACK"
          ? (snapshot(0.078, 0.006, at, spec.workload) ?? null)
          : null,
      createdAt: at,
    });
  }
  const targetRule = flag?.rules[env.id]?.[0];
  const detail: RolloutDetailWire = {
    id: newId(),
    projectId: p.project.id,
    environment: { id: env.id, name: env.name, isProduction: env.isProduction },
    scope: spec.scope,
    controlMode: spec.controlMode ?? "udp-driven",
    strategy: spec.strategy,
    status: spec.status,
    currentTrafficPercentage: spec.percent,
    baselinePercentage: spec.strategy === "CANARY" ? 100 - spec.percent : null,
    ...(flag === undefined || targetRule === undefined
      ? {}
      : {
          flag: {
            id: flag.detail.id,
            key: flag.detail.key,
            targetVariant:
              flag.detail.variants.find((v) => v.key !== "off")?.key ?? "on",
            targetingRuleId: targetRule.id,
          },
        }),
    workloadName: spec.workload,
    ...(spec.versions === undefined
      ? {}
      : { versionOld: spec.versions[0], versionNew: spec.versions[1] }),
    thresholds: {
      errorRate: 0.05,
      minErrors: 5,
      latencyP99Ms: 800,
      relativeErrorRate: 1.5,
      maxConsecutiveBreaches: 2,
    },
    stepPercent: 10,
    stepIntervalSeconds: 300,
    analysisIntervalSeconds: 30,
    warmUpRequests: 200,
    metricWindowSeconds: 60,
    maxDurationSeconds: 86_400,
    ...(spec.failReason === undefined ? {} : { failReason: spec.failReason }),
    ...(spec.status === "IN_PROGRESS" || spec.status === "PAUSED"
      ? {
          lastDecision: {
            decision:
              spec.status === "PAUSED"
                ? ("HOLD" as const)
                : ("PROMOTE" as const),
            reason:
              spec.status === "PAUSED"
                ? "Session đang tạm dừng theo yêu cầu"
                : "Lỗi canary 0,41% so với baseline 0,48%: trong ngưỡng, sẵn sàng bậc tiếp",
            breach: false,
            breachStreak: 0,
            breachAt: null,
            at: minutesAgo(1),
          },
          latestMetricSnapshot: snapshot(
            0.0041,
            0.0048,
            minutesAgo(1),
            spec.workload,
          ),
        }
      : {}),
    events,
    createdAt: iso(startMs),
    updatedAt:
      events.length > 0
        ? (events[events.length - 1]?.createdAt ?? iso(startMs))
        : iso(startMs),
  };
  if (
    spec.live === undefined ||
    flag === undefined ||
    targetRule === undefined
  ) {
    return { detail };
  }
  const target = flag.detail.variants.find((v) => v.key === "on");
  const other = flag.detail.variants.find((v) => v.key === "off");
  if (target === undefined || other === undefined) return { detail };
  return {
    detail,
    live: {
      startedAt: OPENED_AT,
      from: spec.percent,
      step: spec.live.step,
      everySeconds: spec.live.everySeconds,
      upTo: spec.live.upTo,
      flagId: flag.detail.id,
      ruleId: targetRule.id,
      targetVariantId: target.id,
      otherVariantId: other.id,
    },
  };
}

// ------------------------------------------------------------- audit

function auditOf(p: ProjectRecord, actors: Person[]): AuditEntryWire[] {
  const flagKeys = p.flags.map((f) => f.detail);
  const out: AuditEntryWire[] = [];
  const push = (
    minutes: number,
    action: string,
    actor: Person | null,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown,
    environmentId: string | null = null,
  ) =>
    out.push({
      id: newId(),
      action,
      actorType: actor === null ? "SYSTEM" : "USER",
      actorUserId: actor?.id ?? null,
      targetType,
      targetId,
      environmentId,
      before,
      after,
      occurredAt: minutesAgo(minutes),
    });
  const prod = p.environments.find((e) => e.isProduction);
  const first = flagKeys[0];
  if (first !== undefined && prod !== undefined) {
    push(
      4,
      "rollout.promote",
      null,
      "RolloutSession",
      newId(),
      { trafficPercentage: 20 },
      { trafficPercentage: 30 },
      prod.id,
    );
    push(
      38,
      "flag.env.update",
      pick(rng, actors),
      "FlagEnvironmentConfig",
      first.id,
      { isEnabled: false },
      { isEnabled: true },
      prod.id,
    );
  }
  for (const [i, flag] of flagKeys.slice(1, 7).entries()) {
    push(
      90 + i * 170,
      "flag.rules.replace",
      pick(rng, actors),
      "Flag",
      flag.id,
      { ruleCount: 1 },
      { ruleCount: 2 },
      prod?.id ?? null,
    );
  }
  push(
    1_600,
    "sdk_key.create",
    pick(rng, actors),
    "SdkKey",
    newId(),
    null,
    { keyType: "CLIENT", label: "prod-web" },
    prod?.id ?? null,
  );
  push(2_900, "member.add", actors[0] ?? null, "ProjectMember", newId(), null, {
    projectRole: "DEVELOPER",
  });
  push(
    4_400,
    "domain.update",
    actors[0] ?? null,
    "ProjectDomain",
    newId(),
    { selectedTool: "loki", isEnabled: false },
    { selectedTool: "loki", isEnabled: true },
  );
  push(
    7_200,
    "project.quota.update",
    actors[0] ?? null,
    "Project",
    p.project.id,
    { maxNodes: 3 },
    { maxNodes: p.project.resourceQuota.maxNodes },
  );
  push(
    12_000,
    "project.provision",
    actors[0] ?? null,
    "Project",
    p.project.id,
    null,
    { confirmedMonthlyUsd: p.preview.cost.monthlyUsd },
  );
  return out;
}

// ------------------------------------------------------------- lắp project

interface Extras {
  flags: FlagSpec[];
  segments: SegmentSpec[];
  domains: Partial<Record<string, DomainPick>>;
  preferences: DomainState["preferences"];
  deploysPerDay: [number, number, number];
  workload: string;
  /** Workload khác của project — mỗi cái một nhịp deploy bằng nửa workload chính */
  extraWorkloads?: string[];
  rollouts: RolloutSpec[];
  cost: number;
}

function buildProject(spec: ProjectSpec, extras: Extras): ProjectRecord {
  const id = newId();
  const environments = environmentsOf(spec.name, id);
  const cloud = cloudOf(spec);
  const provider = spec.cloud?.provider ?? "AWS";
  const region = spec.cloud?.region ?? "ap-southeast-1";
  const repo =
    spec.repoUrl === undefined
      ? `https://github.com/udp-demo/${spec.name}`
      : spec.repoUrl;
  const segments = extras.segments.map(buildSegment);
  const segmentIds = Object.fromEntries(segments.map((s) => [s.name, s.id]));
  const flags = extras.flags.map((f) => buildFlag(f, environments, segmentIds));
  const deploymentLogs: ProjectRecord["deploymentLogs"] = {};
  const running = spec.status === "ACTIVE";
  const workloads = [extras.workload, ...(extras.extraWorkloads ?? [])];
  const deployments = Object.fromEntries(
    environments.map((env, i) => [
      env.id,
      running
        ? workloads
            .flatMap((workload, w) =>
              deploymentsFor(
                env,
                workload,
                (extras.deploysPerDay[i] ?? 0) * (w === 0 ? 1 : 0.5),
                env.isProduction ? 0.08 : 0.12,
                deploymentLogs,
                repo ?? spec.name,
              ),
            )
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        : [],
    ]),
  );
  const blockers: ProvisionPreviewWire["blockers"] =
    spec.status === "DRAFT"
      ? spec.cloud?.validated === true
        ? []
        : ["cloud-not-validated"]
      : spec.status === "ERROR"
        ? ["orphans-pending"]
        : ["project-not-draft"];
  const preview = previewOf(
    provider,
    region,
    blockers,
    spec.maxNodes === undefined ? 2 : 3,
  );

  const record: ProjectRecord = {
    project: {
      id,
      name: spec.name,
      ownerId: spec.owner.id,
      creationMode: spec.mode,
      languageRuntime: spec.runtime,
      repoUrl: repo,
      status: spec.status,
      resourceQuota: {
        maxNodes: spec.maxNodes ?? 3,
        maxNodeSize: spec.maxNodes === undefined ? "medium" : "large",
        maxDatabases: 2,
        maxStorageGb: 100,
        maxLoadBalancers: 3,
      },
      expiresAt:
        spec.expiresInHours === undefined
          ? null
          : hoursAhead(spec.expiresInHours),
      createdAt: daysAgo(spec.ageDays),
      myRole: spec.myRole ?? "VIEWER",
    },
    environments,
    cluster: clusterOf(spec),
    members: [
      {
        userId: spec.owner.id,
        projectRole: "OWNER",
        createdAt: daysAgo(spec.ageDays),
        user: {
          id: spec.owner.id,
          email: spec.owner.email,
          name: spec.owner.name,
        },
      },
      ...spec.members.map(([m, role], i) => ({
        userId: m.id,
        projectRole: role,
        createdAt: daysAgo(Math.max(0, spec.ageDays - 3 - i * 7)),
        user: { id: m.id, email: m.email, name: m.name },
      })),
    ],
    audit: [],
    sdkKeys: Object.fromEntries(
      environments.map((env) => [
        env.id,
        running ? sdkKeysOf(env, spec.owner) : [],
      ]),
    ),
    flags,
    segments,
    rollouts: [],
    liveRollouts: {},
    deployments,
    deploymentLogs,
    domains: domainsOf(
      spec.name,
      running ? extras.domains : {},
      running ? extras.preferences : [],
      Math.min(spec.ageDays, 12),
    ),
    jobs: [],
    cloud,
    cost: running
      ? {
          provider: "opencost",
          days: 1,
          currency: "USD",
          totalUsd: 0,
          daily: [],
          environments: environments.map((env, i) => {
            const share = [0.12, 0.23, 0.65][i] ?? 0.2;
            const total = extras.cost * share;
            return {
              environmentId: env.id,
              name: env.name,
              totalUsd: total,
              cpuUsd: total * 0.55,
              ramUsd: total * 0.28,
              storageUsd: total * 0.11,
              networkUsd: total * 0.06,
            };
          }),
        }
      : null,
    preview,
    cicd: running
      ? {
          provider: "github-actions",
          webhookPath: `/api/v1/webhooks/cicd/${id}/github-actions`,
          secretSet: true,
        }
      : null,
    adminOnly: spec.myRole === null,
    teamGrants: [],
    invitations: [],
  };

  refreshSegmentUsage(record);

  if (running) {
    const provisionedAt = spec.ageDays - 1;
    record.jobs.push({
      detail: {
        job: job("PROVISION", "DONE", provisionedAt, preview.cost.monthlyUsd),
        resources: resourcesOf(
          provider,
          "READY",
          daysAgo(provisionedAt - 0.01),
        ),
        domains: record.domains.domains
          .filter((d) => d.isEnabled)
          .map((d) => ({
            domainType: d.domainType,
            status: "ACTIVE" as const,
            message: null,
          })),
      },
    });
    record.jobs.push({
      detail: {
        job: job("DOMAIN_APPLY", "DONE", 12, null),
        resources: [],
        domains: [{ domainType: "LOGGING", status: "ACTIVE", message: null }],
      },
    });
  }

  for (const r of extras.rollouts) {
    const built = buildRollout(record, r, spec.owner);
    record.rollouts.push(built.detail);
    if (built.live !== undefined)
      record.liveRollouts[built.detail.id] = built.live;
    const flag = record.flags.find((f) => f.detail.key === r.flag);
    const env = flag?.detail.envs.find((e) => e.environment.name === r.env);
    if (
      env !== undefined &&
      (r.status === "IN_PROGRESS" || r.status === "PAUSED")
    ) {
      env.isTracked = true;
    }
  }
  record.audit = auditOf(record, [spec.owner, ...spec.members.map(([m]) => m)]);
  return record;
}

// ------------------------------------------------------------- các project

function checkoutService(): ProjectRecord {
  const p = buildProject(
    {
      name: "checkout-service",
      runtime: "nodejs",
      mode: "CREATE_NEW",
      status: "ACTIVE",
      myRole: "OWNER",
      owner: ANH,
      members: [
        [BAO, "MAINTAINER"],
        [HA, "DEVELOPER"],
        [HUY, "DEVELOPER"],
        [LAN, "VIEWER"],
      ],
      cloud: { provider: "AWS", region: "ap-southeast-1", validated: true },
      ageDays: 120,
      maxNodes: 6,
    },
    {
      flags: CHECKOUT_FLAGS,
      segments: CHECKOUT_SEGMENTS,
      domains: {
        CONTAINER_REGISTRY: { tool: "ghcr" },
        CICD: { tool: "github-actions" },
        MONITORING: {
          tool: "prometheus-grafana",
          config: { retentionDays: 15, storageGb: 50 },
        },
        LOGGING: { tool: "loki", config: { retentionHours: 336 } },
        TRACING: { tool: "tempo" },
        SERVICE_MESH: { tool: "istio", config: { tracingSamplingPercent: 5 } },
        INGRESS: { tool: "nginx" },
        PROGRESSIVE_DELIVERY: { tool: "argo-rollouts" },
        GITOPS: { tool: "argo-cd" },
        SECRETS: { tool: "vault" },
        SECURITY: {
          tool: "trivy",
          status: "ERROR",
          config: { severities: ["CRITICAL", "HIGH"] },
        },
        POLICY: {
          tool: "kyverno",
          config: { validationFailureAction: "Enforce" },
        },
        DATABASE: { tool: "cloudnative-pg", config: { storageGb: 40 } },
        COST: { tool: "opencost" },
      },
      preferences: [
        {
          capabilityId: "metrics.query",
          providerToolId: "monitoring:prometheus-grafana",
        },
        {
          capabilityId: "traffic.control",
          providerToolId: "progressive_delivery:argo-rollouts",
        },
      ],
      deploysPerDay: [2.6, 1.4, 0.7],
      workload: "checkout-api",
      extraWorkloads: ["checkout-worker", "checkout-web"],
      rollouts: [
        {
          flag: "new-checkout-flow",
          env: "prod",
          scope: "FLAG_LEVEL",
          strategy: "CANARY",
          status: "IN_PROGRESS",
          percent: 30,
          workload: "checkout-api",
          startedHoursAgo: 0.6,
          steps: [10, 20, 30],
          live: { step: 10, everySeconds: 45, upTo: 70 },
        },
        {
          flag: "payment-provider",
          env: "dev",
          scope: "FLAG_LEVEL",
          strategy: "CANARY",
          status: "PAUSED",
          percent: 50,
          workload: "checkout-api",
          startedHoursAgo: 5,
          steps: [10, 20, 30, 40, 50],
          end: "PAUSE",
        },
        {
          env: "staging",
          scope: "SERVICE_LEVEL",
          strategy: "CANARY",
          status: "IN_PROGRESS",
          percent: 40,
          workload: "checkout-api",
          versions: ["v1.15.8", "v1.16.0"],
          startedHoursAgo: 1.4,
          steps: [20, 40],
        },
        {
          flag: "search-v2",
          env: "staging",
          scope: "FLAG_LEVEL",
          strategy: "CANARY",
          status: "FAILED",
          percent: 0,
          workload: "search-api",
          startedHoursAgo: 30,
          steps: [10, 20],
          end: "ROLLBACK",
          failReason:
            "Tỉ lệ lỗi canary 7,8% vượt ngưỡng 5% hai lần liên tiếp, tự rollback về 0%",
        },
        {
          flag: "checkout-button-color",
          env: "staging",
          scope: "FLAG_LEVEL",
          strategy: "ATTRIBUTE_SPLIT",
          status: "DONE",
          percent: 100,
          workload: "checkout-web",
          startedHoursAgo: 240,
          steps: [50],
          end: "COMPLETE",
        },
        {
          flag: "dark-mode",
          env: "prod",
          scope: "FLAG_LEVEL",
          strategy: "CANARY",
          status: "DONE",
          percent: 100,
          workload: "checkout-web",
          startedHoursAgo: 900,
          steps: [10, 25, 50, 75, 100],
          end: "COMPLETE",
        },
      ],
      cost: 5.8,
    },
  );
  addPendingProdDeploy(p);
  addAutoRollback(p);
  p.domains.drift["GITOPS"] = {
    verdict: "DRIFTED",
    message:
      "Application checkout-api lệch Git: Deployment/checkout-api replicas 4 ≠ 3; ConfigMap/checkout-api-env thêm khoá FEATURE_X",
    at: minutesAgo(26),
  };
  p.domains.drift["SECURITY"] = {
    verdict: "SCAN_FAILED",
    message:
      "trivy-operator: CrashLoopBackOff, không đủ bộ nhớ cho cơ sở dữ liệu lỗ hổng (limit 256Mi)",
    at: minutesAgo(12),
  };
  const monitoring = p.domains.versions["MONITORING"];
  if (monitoring !== undefined) {
    monitoring.available = [
      {
        version: "1.1.0",
        provides: [
          { id: "metrics.query", version: "2.1.0" },
          { id: "metrics.scrape", version: "1.0.0" },
        ],
        changes: [],
        validation: {
          valid: true,
          errors: [],
          warnings: [],
          deployOrder: [
            ["monitoring:prometheus-grafana"],
            ["progressive_delivery:argo-rollouts"],
          ],
        },
      },
    ];
  }
  return p;
}

/** Deploy prod chờ duyệt: prod không tự deploy (§8.3) — nút "Duyệt" có việc để làm */
function addPendingProdDeploy(p: ProjectRecord): void {
  const prod = p.environments.find((e) => e.isProduction);
  if (prod === undefined) return;
  const id = newId();
  const at = minutesAgo(14);
  const event = {
    id: newId(),
    eventType: "DEPLOY_PENDING" as const,
    occurredAt: at,
  };
  p.deployments[prod.id]?.unshift({
    deploymentId: id,
    status: "DEPLOY_PENDING",
    workloadName: "checkout-api",
    imageTag: "v1.16.0",
    commitSha: "9f3c2ab41d07",
    triggeredBy: "WEBHOOK",
    rolloutSessionId: null,
    restoresDeploymentId: null,
    startedAt: at,
    lastEventAt: at,
    events: [event],
  });
  p.deploymentLogs[id] = [
    {
      ...event,
      triggeredBy: "WEBHOOK",
      workloadName: "checkout-api",
      imageTag: "v1.16.0",
      commitSha: "9f3c2ab41d07",
      pipelineId: "run-19944",
      detail: {
        repo: "udp-demo/checkout-service",
        ref: "main",
        reason: "prod không tự deploy, chờ người có quyền duyệt",
      },
    },
  ];
}

/** Rollback tự động nối với rollout thất bại — MTTR của DORA có mẫu để đo */
function addAutoRollback(p: ProjectRecord): void {
  const failed = p.rollouts.find((r) => r.status === "FAILED");
  if (failed === undefined) return;
  const list = p.deployments[failed.environment.id];
  const restored = list?.find((d) => d.status === "DEPLOY_SUCCESS");
  if (list === undefined || restored === undefined) return;
  const at = failed.updatedAt;
  const id = newId();
  const event = { id: newId(), eventType: "ROLLBACK" as const, occurredAt: at };
  list.push({
    deploymentId: id,
    status: "ROLLBACK",
    workloadName: failed.workloadName,
    imageTag: restored.imageTag,
    commitSha: restored.commitSha,
    triggeredBy: "AUTO",
    rolloutSessionId: failed.id,
    restoresDeploymentId: restored.deploymentId,
    startedAt: at,
    lastEventAt: at,
    events: [event],
  });
  list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  p.deploymentLogs[id] = [
    {
      ...event,
      triggeredBy: "AUTO",
      workloadName: failed.workloadName,
      imageTag: restored.imageTag,
      commitSha: restored.commitSha,
      pipelineId: null,
      detail: {
        rolloutSessionId: failed.id,
        reason: failed.failReason ?? "rollback",
      },
    },
  ];
}

const STANDARD_DOMAINS: Partial<Record<string, DomainPick>> = {
  CONTAINER_REGISTRY: { tool: "ghcr" },
  CICD: { tool: "github-actions" },
  MONITORING: { tool: "prometheus-grafana", config: { retentionDays: 7 } },
  LOGGING: { tool: "loki" },
  INGRESS: { tool: "nginx" },
  PROGRESSIVE_DELIVERY: { tool: "argo-rollouts" },
  SERVICE_MESH: { tool: "istio" },
};

function paymentGateway(): ProjectRecord {
  return buildProject(
    {
      name: "payment-gateway",
      runtime: "python",
      mode: "IMPORT_EXISTING",
      status: "ACTIVE",
      myRole: "MAINTAINER",
      owner: KHANH,
      members: [
        [ANH, "MAINTAINER"],
        [PHAT, "DEVELOPER"],
      ],
      cloud: { provider: "GCP", region: "asia-southeast1", validated: true },
      ageDays: 90,
    },
    {
      flags: smallFlagSet("payment"),
      segments: [],
      domains: {
        ...STANDARD_DOMAINS,
        SECRETS: { tool: "vault" },
        DATABASE: { tool: "cloudnative-pg" },
      },
      preferences: [],
      deploysPerDay: [1.6, 0.9, 0.4],
      workload: "payment-api",
      extraWorkloads: ["payment-webhooks"],
      rollouts: [
        {
          flag: "3ds-v2",
          env: "prod",
          scope: "FLAG_LEVEL",
          strategy: "CANARY",
          status: "DONE",
          percent: 100,
          workload: "payment-api",
          startedHoursAgo: 120,
          steps: [10, 30, 50],
          end: "COMPLETE",
        },
      ],
      cost: 4.2,
    },
  );
}

function notificationWorker(): ProjectRecord {
  const p = buildProject(
    {
      name: "notification-worker",
      runtime: "nodejs",
      mode: "CREATE_NEW",
      status: "PROVISIONING",
      myRole: "OWNER",
      owner: ANH,
      members: [[HUY, "DEVELOPER"]],
      cloud: { provider: "AZURE", region: "southeastasia", validated: true },
      ageDays: 2,
    },
    {
      flags: [],
      segments: [],
      domains: {},
      preferences: [],
      deploysPerDay: [0, 0, 0],
      workload: "notification-worker",
      rollouts: [],
      cost: 0,
    },
  );
  const plan = resourcesOf("AZURE", "READY", minutesAgo(0));
  const live: JobRecord = {
    detail: {
      job: {
        ...job("PROVISION", "NETWORK", 0, p.preview.cost.monthlyUsd),
        createdAt: minutesAgo(3),
        updatedAt: minutesAgo(1),
      },
      resources: [],
      domains: [],
    },
    live: {
      schedule: [
        { state: "NETWORK", at: 0 },
        { state: "CLUSTER", at: 50 },
        { state: "CLUSTER_ACCESS", at: 140 },
        { state: "DOMAINS", at: 165 },
        { state: "DONE", at: 210 },
      ],
      plan,
      domains: [
        { domainType: "CONTAINER_REGISTRY", status: "ACTIVE", message: null },
        { domainType: "MONITORING", status: "ACTIVE", message: null },
        { domainType: "LOGGING", status: "ACTIVE", message: null },
      ],
    },
  };
  p.jobs.push(live);
  return p;
}

function mobileBff(): ProjectRecord {
  const p = buildProject(
    {
      name: "mobile-bff",
      runtime: "nodejs",
      mode: "CREATE_NEW",
      status: "ACTIVE",
      myRole: "DEVELOPER",
      owner: HA,
      members: [
        [ANH, "DEVELOPER"],
        [LINH, "DEVELOPER"],
        [YEN, "VIEWER"],
      ],
      cloud: { provider: "AWS", region: "ap-southeast-1", validated: true },
      ageDays: 60,
    },
    {
      flags: smallFlagSet("mobile"),
      segments: [],
      domains: STANDARD_DOMAINS,
      preferences: [],
      deploysPerDay: [3.1, 1.2, 0.5],
      workload: "mobile-bff",
      extraWorkloads: ["image-resizer"],
      rollouts: [],
      cost: 3.1,
    },
  );
  const failed = job("DOMAIN_APPLY", "FAILED", 5, null);
  failed.attempt = 3;
  failed.lastError = {
    step: "DOMAINS",
    message:
      "istio: istiod không Ready sau 600 giây: webhook sidecar-injector từ chối pod (thiếu CPU request trên node t3.medium)",
    orphans: [],
    at: daysAgo(4.9),
  };
  p.jobs.push({
    detail: {
      job: failed,
      resources: [],
      domains: [
        {
          domainType: "SERVICE_MESH",
          status: "ERROR",
          message: "istiod không Ready sau 600 giây",
        },
      ],
    },
  });
  return p;
}

function analyticsApi(): ProjectRecord {
  return buildProject(
    {
      name: "analytics-api",
      runtime: "python",
      mode: "CREATE_NEW",
      status: "DRAFT",
      myRole: "OWNER",
      owner: ANH,
      members: [[TUNG, "MAINTAINER"]],
      cloud: { provider: "AWS", region: "ap-southeast-1", validated: false },
      ageDays: 5,
    },
    {
      flags: smallFlagSet("draft"),
      segments: [],
      domains: {},
      preferences: [],
      deploysPerDay: [0, 0, 0],
      workload: "analytics-api",
      rollouts: [],
      cost: 0,
    },
  );
}

function legacyBilling(): ProjectRecord {
  const p = buildProject(
    {
      name: "legacy-billing",
      runtime: "nodejs",
      mode: "IMPORT_EXISTING",
      status: "ERROR",
      myRole: "OWNER",
      owner: ANH,
      members: [[BAO, "MAINTAINER"]],
      cloud: { provider: "AWS", region: "ap-southeast-1", validated: true },
      ageDays: 30,
      expiresInHours: 20,
    },
    {
      flags: smallFlagSet("billing"),
      segments: [],
      domains: {},
      preferences: [],
      deploysPerDay: [0, 0, 0],
      workload: "billing-api",
      rollouts: [],
      cost: 0,
    },
  );
  const failed = job(
    "PROVISION",
    "COMPENSATION_FAILED",
    1,
    p.preview.cost.monthlyUsd,
  );
  failed.attempt = 3;
  failed.lastError = {
    step: "CLUSTER",
    message:
      "EKS CreateCluster: ResourceLimitExceeded, tài khoản đã có 100 cluster ở ap-southeast-1; bù trừ không xoá được NAT gateway",
    orphans: ["nat", "eip"],
    at: hoursAgo(23),
  };
  const resources = resourcesOf("AWS", "DELETED", hoursAgo(23)).map((r) =>
    r.name === "nat" || r.name === "eip"
      ? { ...r, status: "ORPHAN_SUSPECTED" as const }
      : r,
  );
  p.jobs.push({ detail: { job: failed, resources, domains: [] } });
  return p;
}

function adminOnlyProject(
  name: string,
  owner: Person,
  status: ProjectStatusWire,
  provider: Provider | undefined,
): ProjectRecord {
  return buildProject(
    {
      name,
      runtime: "nodejs",
      mode: "CREATE_NEW",
      status,
      myRole: null,
      owner,
      members: [],
      ...(provider === undefined
        ? {}
        : {
            cloud: {
              provider,
              region: provider === "GCP" ? "asia-southeast1" : "ap-southeast-1",
              validated: true,
            },
          }),
      ageDays: 70,
    },
    {
      flags: [],
      segments: [],
      domains: STANDARD_DOMAINS,
      preferences: [],
      deploysPerDay: [1, 0.5, 0.2],
      workload: name,
      rollouts: [],
      cost: 2,
    },
  );
}

// ------------------------------------------------------------- đội mở rộng (Plan #53 QĐ-10)

/**
 * Đám đông người dùng của các nhóm khác — hạt giống RIÊNG, nên id và số của nhóm có tên ở trên không đổi khi
 * đám đông đổi cỡ.
 */
const crowdRng = prng(20261001);
const CROWD: Person[] = crowd(
  crowdRng,
  120,
  new Set(PEOPLE.map((p) => p.email)),
).map((m) => ({ id: uuid(crowdRng), ...m }));

const crowdAt = (i: number): Person => {
  const p = CROWD[i % CROWD.length];
  if (p === undefined) throw new Error("đám đông rỗng");
  return p;
};

/** Các bộ công cụ thật mà các nhóm hay chọn — gộp lại phủ gần hết catalog §5.5 */
const AWS_DATADOG: Partial<Record<string, DomainPick>> = {
  CONTAINER_REGISTRY: { tool: "ecr" },
  CICD: { tool: "gitlab-ci" },
  MONITORING: { tool: "datadog", config: { site: "datadoghq.com" } },
  LOGGING: { tool: "datadog-logs" },
  INGRESS: { tool: "traefik" },
  SERVICE_MESH: { tool: "linkerd" },
  PROGRESSIVE_DELIVERY: { tool: "flagger" },
  SECRETS: { tool: "aws-secrets-manager" },
  COST: { tool: "kubecost" },
};

const GCP_NATIVE: Partial<Record<string, DomainPick>> = {
  CONTAINER_REGISTRY: { tool: "gcp-artifact-registry" },
  CICD: { tool: "tekton" },
  MONITORING: { tool: "victoria-metrics" },
  LOGGING: { tool: "loki" },
  TRACING: { tool: "jaeger" },
  INGRESS: { tool: "nginx" },
  GITOPS: { tool: "flux" },
  SECRETS: { tool: "gcp-secret-manager" },
  POLICY: { tool: "gatekeeper" },
  DATABASE: { tool: "redis" },
};

const AZURE_ENTERPRISE: Partial<Record<string, DomainPick>> = {
  CONTAINER_REGISTRY: { tool: "acr" },
  CICD: { tool: "jenkins" },
  MONITORING: { tool: "newrelic" },
  LOGGING: { tool: "elk" },
  TRACING: { tool: "zipkin" },
  INGRESS: { tool: "nginx" },
  SERVICE_MESH: { tool: "istio" },
  PROGRESSIVE_DELIVERY: { tool: "argo-rollouts" },
  GITOPS: { tool: "argo-cd" },
  SECRETS: { tool: "azure-key-vault" },
  SECURITY: { tool: "falco" },
  POLICY: { tool: "kyverno" },
  DATABASE: { tool: "mongodb" },
};

const DYNATRACE_STACK: Partial<Record<string, DomainPick>> = {
  CONTAINER_REGISTRY: { tool: "docker-hub" },
  CICD: { tool: "circleci" },
  INFRA: { tool: "pulumi" },
  MONITORING: { tool: "dynatrace" },
  LOGGING: { tool: "fluentd" },
  TRACING: { tool: "tempo" },
  INGRESS: { tool: "nginx" },
  PROGRESSIVE_DELIVERY: { tool: "spinnaker" },
  SECRETS: { tool: "external-secrets" },
  SECURITY: { tool: "aqua" },
  DATABASE: { tool: "mysql" },
  COST: { tool: "opencost" },
  ARTIFACT_REGISTRY: { tool: "artifactory" },
};

const LEAN_STACK: Partial<Record<string, DomainPick>> = {
  CONTAINER_REGISTRY: { tool: "harbor" },
  CICD: { tool: "drone" },
  INFRA: { tool: "ack" },
  MONITORING: { tool: "grafana-cloud" },
  LOGGING: { tool: "opensearch" },
  INGRESS: { tool: "traefik" },
  SERVICE_MESH: { tool: "consul-connect" },
  SECRETS: { tool: "sealed-secrets" },
  SECURITY: { tool: "checkov" },
  DATABASE: { tool: "minio" },
  ARTIFACT_REGISTRY: { tool: "nexus" },
};

const LAB_STACK: Partial<Record<string, DomainPick>> = {
  CONTAINER_REGISTRY: { tool: "ghcr" },
  CICD: { tool: "github-actions" },
  INFRA: { tool: "ansible" },
  MONITORING: { tool: "prometheus-grafana" },
  LOGGING: { tool: "fluent-bit" },
  TRACING: { tool: "tempo" },
  SERVICE_MESH: { tool: "kuma" },
  INGRESS: { tool: "nginx" },
  PROGRESSIVE_DELIVERY: { tool: "flagger" },
  SECURITY: { tool: "grype" },
  DATABASE: { tool: "k8ssandra" },
  ARTIFACT_REGISTRY: { tool: "github-packages" },
  COST: { tool: "opencost" },
};

/** Một sự cố trong lịch sử project — thứ làm trang Job lỗi và Tài nguyên mồ côi có việc */
type Incident =
  | {
      kind: "failed";
      jobType: JobDetailWire["job"]["jobType"];
      daysAgo: number;
      step: string;
      message: string;
    }
  | {
      kind: "compensationFailed";
      daysAgo: number;
      step: string;
      message: string;
      orphans: string[];
    }
  | { kind: "cancelRequested"; hoursAgo: number }
  | { kind: "provisioning"; state: "NETWORK" | "CLUSTER" | "DOMAINS" };

interface FleetSpec {
  name: string;
  owner: number;
  status: ProjectStatusWire;
  cloud?: { provider: Provider; region: string; validated?: boolean };
  runtime?: "nodejs" | "python";
  ageDays: number;
  domains?: Partial<Record<string, DomainPick>>;
  workload: string;
  extraWorkloads?: string[];
  deploysPerDay?: [number, number, number];
  cost?: number;
  drift?: Record<string, "DRIFTED" | "SCAN_FAILED">;
  incidents?: Incident[];
}

/** Project của các nhóm khác: người xem (quản trị viên) không là thành viên — chỉ Bảng điều khiển thấy */
const FLEET: FleetSpec[] = [
  {
    name: "inventory-sync",
    owner: 3,
    status: "ACTIVE",
    cloud: { provider: "AWS", region: "ap-southeast-1" },
    ageDays: 150,
    domains: AWS_DATADOG,
    workload: "inventory-api",
    extraWorkloads: ["stock-worker"],
    deploysPerDay: [2.2, 1.1, 0.6],
    cost: 6.4,
    incidents: [
      {
        kind: "failed",
        jobType: "PROVISION",
        daysAgo: 149.6,
        step: "CLUSTER",
        message:
          "EC2 RunInstances: VcpuLimitExceeded, hạn mức 32 vCPU On-Demand của vùng đã dùng hết",
      },
    ],
  },
  {
    name: "order-events",
    owner: 11,
    status: "ACTIVE",
    cloud: { provider: "GCP", region: "asia-southeast1" },
    runtime: "python",
    ageDays: 210,
    domains: { ...GCP_NATIVE, INFRA: { tool: "config-connector" } },
    workload: "order-events-consumer",
    extraWorkloads: ["order-events-api"],
    deploysPerDay: [1.8, 0.8, 0.4],
    cost: 4.9,
    drift: { GITOPS: "DRIFTED" },
  },
  {
    name: "loyalty-api",
    owner: 19,
    status: "ACTIVE",
    cloud: { provider: "AZURE", region: "southeastasia" },
    ageDays: 95,
    domains: { ...AZURE_ENTERPRISE, INFRA: { tool: "aso" } },
    workload: "loyalty-api",
    deploysPerDay: [1.2, 0.7, 0.3],
    cost: 5.6,
    incidents: [
      {
        kind: "failed",
        jobType: "DOMAIN_APPLY",
        daysAgo: 11,
        step: "DOMAINS",
        message:
          "helm upgrade newrelic-bundle: hết giờ chờ DaemonSet newrelic-infrastructure (0/3 Ready)",
      },
    ],
  },
  {
    name: "partner-portal",
    owner: 27,
    status: "DRAFT",
    cloud: { provider: "AWS", region: "ap-southeast-1", validated: false },
    ageDays: 8,
    workload: "partner-web",
  },
  {
    name: "ml-feature-store",
    owner: 33,
    status: "PROVISIONING",
    cloud: { provider: "GCP", region: "asia-southeast1" },
    runtime: "python",
    ageDays: 1,
    workload: "feature-server",
    incidents: [{ kind: "provisioning", state: "CLUSTER" }],
  },
  {
    name: "sms-gateway",
    owner: 41,
    status: "ERROR",
    cloud: { provider: "AZURE", region: "southeastasia" },
    ageDays: 16,
    workload: "sms-gateway",
    incidents: [
      {
        kind: "compensationFailed",
        daysAgo: 2,
        step: "CLUSTER",
        message:
          "AKS: QuotaExceeded, vùng southeastasia chỉ còn 4 lõi Standard_DSv3; bù trừ không xoá được NAT gateway và IP công khai",
        orphans: ["public-ip", "nat-gateway"],
      },
    ],
  },
  {
    name: "report-builder",
    owner: 48,
    status: "ERROR",
    cloud: { provider: "GCP", region: "asia-southeast1" },
    runtime: "python",
    ageDays: 23,
    workload: "report-builder",
    incidents: [
      {
        kind: "compensationFailed",
        daysAgo: 4,
        step: "CLUSTER",
        message:
          "container.clusters.create: ZONE_RESOURCE_POOL_EXHAUSTED ở asia-southeast1-b; bù trừ hết giờ khi xoá Cloud NAT và cluster dở",
        orphans: ["nat", "cluster"],
      },
    ],
  },
  {
    name: "hr-portal",
    owner: 52,
    status: "DELETED",
    cloud: { provider: "AWS", region: "ap-southeast-1" },
    ageDays: 260,
    workload: "hr-portal",
  },
  {
    name: "promo-engine",
    owner: 58,
    status: "ACTIVE",
    cloud: { provider: "AWS", region: "ap-northeast-1" },
    ageDays: 70,
    domains: LAB_STACK,
    workload: "promo-engine",
    extraWorkloads: ["coupon-worker"],
    deploysPerDay: [3.4, 1.6, 0.9],
    cost: 3.8,
    drift: { SECURITY: "SCAN_FAILED" },
    incidents: [{ kind: "cancelRequested", hoursAgo: 0.3 }],
  },
  {
    name: "edu-lms",
    owner: 64,
    status: "ACTIVE",
    cloud: { provider: "AZURE", region: "eastasia" },
    ageDays: 320,
    domains: DYNATRACE_STACK,
    workload: "lms-web",
    extraWorkloads: ["lms-api", "video-transcoder"],
    deploysPerDay: [1.5, 0.9, 0.5],
    cost: 9.2,
  },
  {
    name: "clinic-booking",
    owner: 71,
    status: "DRAFT",
    cloud: { provider: "GCP", region: "asia-southeast1", validated: true },
    ageDays: 3,
    workload: "booking-api",
  },
  {
    name: "fleet-tracker",
    owner: 77,
    status: "ACTIVE",
    cloud: { provider: "AWS", region: "ap-southeast-1" },
    ageDays: 180,
    domains: LEAN_STACK,
    workload: "tracker-ingest",
    extraWorkloads: ["tracker-api"],
    deploysPerDay: [2.8, 1.3, 0.7],
    cost: 4.1,
    incidents: [
      {
        kind: "failed",
        jobType: "PROVISION",
        daysAgo: 179.7,
        step: "CLUSTER",
        message:
          "iam:PassRole bị từ chối cho role udp-node: role tin UDP thiếu quyền PassRole",
      },
      {
        kind: "failed",
        jobType: "DOMAIN_APPLY",
        daysAgo: 30,
        step: "DOMAINS",
        message:
          "consul-connect: server-0 không bầu được leader sau 300 giây (PVC chưa gắn)",
      },
    ],
  },
  {
    name: "chatops-bot",
    owner: 83,
    status: "DRAFT",
    ageDays: 1,
    workload: "chatops-bot",
  },
];

function incidentJob(p: ProjectRecord, incident: Incident): JobRecord {
  const provider = p.cloud?.provider ?? "AWS";
  switch (incident.kind) {
    case "failed": {
      const j = job(incident.jobType, "FAILED", incident.daysAgo, null);
      j.attempt = 3;
      j.lastError = {
        step: incident.step,
        message: incident.message,
        orphans: [],
        at: daysAgo(incident.daysAgo - 0.01),
      };
      return { detail: { job: j, resources: [], domains: [] } };
    }
    case "compensationFailed": {
      const j = job(
        "PROVISION",
        "COMPENSATION_FAILED",
        incident.daysAgo,
        p.preview.cost.monthlyUsd,
      );
      j.attempt = 3;
      j.lastError = {
        step: incident.step,
        message: incident.message,
        orphans: incident.orphans,
        at: daysAgo(incident.daysAgo - 0.02),
      };
      const at = daysAgo(incident.daysAgo - 0.02);
      const resources = resourcesOf(provider, "DELETED", at).map((r) =>
        incident.orphans.includes(r.name)
          ? { ...r, status: "ORPHAN_SUSPECTED" as const }
          : r,
      );
      return { detail: { job: j, resources, domains: [] } };
    }
    case "cancelRequested": {
      const j = job("DOMAIN_APPLY", "CANCEL_REQUESTED", 0, null);
      j.createdAt = hoursAgo(incident.hoursAgo);
      j.updatedAt = minutesAgo(2);
      return { detail: { job: j, resources: [], domains: [] } };
    }
    case "provisioning": {
      const j = job("PROVISION", incident.state, 0, p.preview.cost.monthlyUsd);
      j.createdAt = minutesAgo(19);
      j.updatedAt = minutesAgo(1);
      const network = resourcesOf(provider, "READY", minutesAgo(12)).filter(
        (r) => r.step === "NETWORK",
      );
      return { detail: { job: j, resources: network, domains: [] } };
    }
  }
}

function fleetProject(spec: FleetSpec, index: number): ProjectRecord {
  const owner = crowdAt(spec.owner);
  const members: [Person, Exclude<ProjectRoleWire, "OWNER">][] = [
    [crowdAt(spec.owner + 1), "MAINTAINER"],
    [crowdAt(spec.owner + 2), "DEVELOPER"],
    [crowdAt(spec.owner + 3), index % 2 === 0 ? "DEVELOPER" : "VIEWER"],
  ];
  const p = buildProject(
    {
      name: spec.name,
      runtime: spec.runtime ?? "nodejs",
      mode: index % 3 === 0 ? "IMPORT_EXISTING" : "CREATE_NEW",
      status: spec.status,
      myRole: null,
      owner,
      members,
      ...(spec.cloud === undefined
        ? {}
        : {
            cloud: {
              provider: spec.cloud.provider,
              region: spec.cloud.region,
              validated: spec.cloud.validated ?? true,
            },
          }),
      ageDays: spec.ageDays,
    },
    {
      flags: [],
      segments: [],
      domains: spec.domains ?? {},
      preferences: [],
      deploysPerDay: spec.deploysPerDay ?? [0, 0, 0],
      workload: spec.workload,
      ...(spec.extraWorkloads === undefined
        ? {}
        : { extraWorkloads: spec.extraWorkloads }),
      rollouts: [],
      cost: spec.cost ?? 0,
    },
  );
  for (const [domainType, verdict] of Object.entries(spec.drift ?? {})) {
    p.domains.drift[domainType] = {
      verdict,
      message:
        verdict === "DRIFTED"
          ? "Tài nguyên trong cụm lệch cấu hình mong muốn (sửa tay bằng kubectl)"
          : "Lần quét gần nhất không chạy được: hết giờ chờ API server",
      at: minutesAgo(between(rng, 15, 400)),
    };
  }
  for (const incident of spec.incidents ?? []) {
    p.jobs.push(incidentJob(p, incident));
  }
  return p;
}

/** Ba project khác mà người xem là thành viên — đủ hình cho trang chủ và trang Giám sát */
function searchService(): ProjectRecord {
  return buildProject(
    {
      name: "search-service",
      runtime: "python",
      mode: "CREATE_NEW",
      status: "ACTIVE",
      myRole: "VIEWER",
      owner: crowdAt(5),
      members: [
        [crowdAt(6), "MAINTAINER"],
        [ANH, "VIEWER"],
      ],
      cloud: { provider: "GCP", region: "asia-southeast1", validated: true },
      ageDays: 75,
    },
    {
      flags: smallFlagSet("search"),
      segments: [],
      domains: {
        ...GCP_NATIVE,
        MONITORING: { tool: "datadog", config: { site: "datadoghq.com" } },
        LOGGING: { tool: "datadog-logs" },
        PROGRESSIVE_DELIVERY: { tool: "argo-rollouts" },
        SERVICE_MESH: { tool: "istio" },
      },
      preferences: [
        { capabilityId: "metrics.query", providerToolId: "monitoring:datadog" },
      ],
      deploysPerDay: [2.4, 1.2, 0.8],
      workload: "search-api",
      extraWorkloads: ["search-indexer"],
      rollouts: [
        {
          flag: "semantic-ranking",
          env: "prod",
          scope: "FLAG_LEVEL",
          strategy: "CANARY",
          status: "IN_PROGRESS",
          percent: 20,
          workload: "search-api",
          startedHoursAgo: 1.1,
          steps: [10, 20],
        },
      ],
      cost: 5.1,
    },
  );
}

function fraudDetector(): ProjectRecord {
  const p = buildProject(
    {
      name: "fraud-detector",
      runtime: "python",
      mode: "IMPORT_EXISTING",
      status: "ACTIVE",
      myRole: "MAINTAINER",
      owner: KHANH,
      members: [
        [ANH, "MAINTAINER"],
        [crowdAt(9), "DEVELOPER"],
      ],
      cloud: { provider: "AZURE", region: "southeastasia", validated: true },
      ageDays: 110,
    },
    {
      flags: smallFlagSet("payment"),
      segments: [],
      domains: AZURE_ENTERPRISE,
      preferences: [],
      deploysPerDay: [1.4, 0.8, 0.4],
      workload: "fraud-scorer",
      extraWorkloads: ["fraud-rules-sync"],
      rollouts: [
        {
          env: "staging",
          scope: "SERVICE_LEVEL",
          strategy: "CANARY",
          status: "PAUSED",
          percent: 30,
          workload: "fraud-scorer",
          versions: ["v1.19.2", "v1.20.0"],
          startedHoursAgo: 3,
          steps: [10, 20, 30],
          end: "PAUSE",
        },
      ],
      cost: 7.3,
    },
  );
  p.domains.drift["POLICY"] = {
    verdict: "DRIFTED",
    message:
      "ClusterPolicy require-requests-limits bị sửa tay: validationFailureAction Audit thay cho Enforce",
    at: minutesAgo(48),
  };
  return p;
}

function marketingSite(): ProjectRecord {
  return buildProject(
    {
      name: "marketing-site",
      runtime: "nodejs",
      mode: "CREATE_NEW",
      status: "ACTIVE",
      myRole: "DEVELOPER",
      owner: crowdAt(14),
      members: [[ANH, "DEVELOPER"]],
      cloud: { provider: "AWS", region: "ap-southeast-1", validated: true },
      ageDays: 40,
    },
    {
      flags: smallFlagSet("web"),
      segments: [],
      domains: {
        CONTAINER_REGISTRY: { tool: "ghcr" },
        CICD: { tool: "github-actions" },
        INGRESS: { tool: "nginx" },
      },
      preferences: [],
      deploysPerDay: [1.1, 0.5, 0.3],
      workload: "marketing-web",
      rollouts: [],
      cost: 1.2,
    },
  );
}

const EMPTY_EXTRAS = (workload: string): Extras => ({
  flags: [],
  segments: [],
  domains: {},
  preferences: [],
  deploysPerDay: [0, 0, 0],
  workload,
  rollouts: [],
  cost: 0,
});

/** `POST /projects` của bản xem thử: project nháp mới, người xem là OWNER */
export function createDraftProject(input: {
  name: string;
  creationMode: "CREATE_NEW" | "IMPORT_EXISTING";
  languageRuntime: string;
  repoUrl?: string;
}): ProjectRecord {
  const record = buildProject(
    {
      name: input.name,
      runtime: input.languageRuntime === "python" ? "python" : "nodejs",
      mode: input.creationMode,
      status: "DRAFT",
      myRole: "OWNER",
      owner: ANH,
      members: [],
      ageDays: 0,
      repoUrl: input.repoUrl ?? null,
    },
    EMPTY_EXTRAS(input.name),
  );
  record.audit = [];
  return record;
}

// ------------------------------------------------------------- nhóm và lời mời (Plan #55)

/** Hạt giống RIÊNG: id của nhóm và lời mời không xê dịch id của những thứ sinh trước */
const teamRng = prng(20261002);
const teamUuid = (): string => uuid(teamRng);

interface TeamSpec {
  name: string;
  ageDays: number;
  members: [Person, TeamRoleWire, number][];
  grants: [string, GrantableProjectRoleWire, number][];
  invitations: InvitationSpec<TeamRoleWire>[];
}

interface InvitationSpec<R> {
  email: string;
  role: R;
  by: Person;
  /** Giờ trước lúc mở trang; lời mời hết hạn sau 7 ngày = 168 giờ */
  hoursAgo: number;
  token?: string;
}

const INVITATION_TTL_HOURS = 7 * 24;

const invitationBase = (spec: InvitationSpec<unknown>) => ({
  id: teamUuid(),
  email: spec.email,
  invitedBy: { id: spec.by.id, email: spec.by.email, name: spec.by.name },
  expiresAt: hoursAhead(INVITATION_TTL_HOURS - spec.hoursAgo),
  createdAt: hoursAgo(spec.hoursAgo),
});

/**
 * Năm nhóm có thật: chủ nhóm và thành viên thường, nhóm cấp quyền cho nhiều project (kể cả `data-pipeline` —
 * Minh Anh vào được CHỈ qua nhóm "Nền tảng", và `search-service` — vai của nhóm cao hơn vai riêng), một nhóm chưa
 * có quyền ở đâu, lời mời đang chờ, đã hết hạn, và một lời mời dành cho chính người đang xem.
 */
const TEAMS: TeamSpec[] = [
  {
    name: "Nhóm thanh toán",
    ageDays: 60,
    members: [
      [ANH, "OWNER", 60],
      [BAO, "OWNER", 60],
      [HUY, "MEMBER", 45],
      [LAN, "MEMBER", 30],
      [YEN, "MEMBER", 10],
    ],
    grants: [
      ["checkout-service", "DEVELOPER", 50],
      ["payment-gateway", "DEVELOPER", 40],
      ["fraud-detector", "VIEWER", 20],
    ],
    invitations: [
      {
        email: "thuc.tap.thanh.toan@udp.dev",
        role: "MEMBER",
        by: BAO,
        hoursAgo: 26,
      },
    ],
  },
  {
    name: "Nhóm di động",
    ageDays: 90,
    members: [
      [HA, "OWNER", 90],
      [ANH, "MEMBER", 80],
      [PHAT, "MEMBER", 40],
      [LINH, "MEMBER", 25],
    ],
    grants: [
      ["mobile-bff", "MAINTAINER", 70],
      ["notification-worker", "VIEWER", 30],
    ],
    invitations: [],
  },
  {
    name: "Nền tảng",
    ageDays: 120,
    members: [
      [KHANH, "OWNER", 120],
      [ANH, "OWNER", 110],
      [TUNG, "MEMBER", 100],
      [crowdAt(2), "MEMBER", 64],
    ],
    grants: [
      ["data-pipeline", "VIEWER", 15],
      ["search-service", "MAINTAINER", 35],
      ["legacy-billing", "MAINTAINER", 60],
    ],
    invitations: [],
  },
  {
    name: "Tư vấn bên ngoài",
    ageDays: 20,
    members: [
      [ANH, "OWNER", 20],
      [crowdAt(40), "MEMBER", 18],
      [crowdAt(41), "MEMBER", 9],
    ],
    grants: [],
    invitations: [
      {
        email: "tu.van.bao.mat@doitac.vn",
        role: "MEMBER",
        by: ANH,
        hoursAgo: 50,
      },
      // Quá 7 ngày: danh sách đánh dấu "Đã hết hạn", chủ nhóm tạo lại đường dẫn được
      { email: "kiem.thu@doitac.vn", role: "MEMBER", by: ANH, hoursAgo: 216 },
    ],
  },
  {
    name: "Nhóm dữ liệu",
    ageDays: 50,
    members: [
      [TUNG, "OWNER", 50],
      [LINH, "MEMBER", 30],
    ],
    grants: [["analytics-api", "DEVELOPER", 12]],
    invitations: [
      {
        email: ANH.email,
        role: "MEMBER",
        by: TUNG,
        hoursAgo: 3,
        token: DEMO_INVITE_TOKEN,
      },
    ],
  },
];

/** Lời mời đang chờ vào project — cùng khuôn: mới, sắp hết hạn, đã hết hạn */
const PROJECT_INVITATIONS: [
  string,
  InvitationSpec<GrantableProjectRoleWire>,
][] = [
  [
    "checkout-service",
    { email: "minh.tran@doitac.vn", role: "DEVELOPER", by: ANH, hoursAgo: 20 },
  ],
  [
    "checkout-service",
    {
      email: "qa.contractor@gmail.com",
      role: "VIEWER",
      by: ANH,
      hoursAgo: 240,
    },
  ],
  [
    "notification-worker",
    { email: "sre.moi@udp.dev", role: "MAINTAINER", by: ANH, hoursAgo: 4 },
  ],
  [
    "analytics-api",
    { email: "data.intern@udp.dev", role: "VIEWER", by: ANH, hoursAgo: 150 },
  ],
];

function seedTeams(projects: ProjectRecord[]): {
  teams: TeamRecord[];
  tokens: InvitationToken[];
} {
  const byName = new Map(projects.map((p) => [p.project.name, p]));
  const projectNamed = (name: string): ProjectRecord => {
    const p = byName.get(name);
    if (p === undefined) throw new Error(`dữ liệu mẫu thiếu project ${name}`);
    return p;
  };
  const tokens: InvitationToken[] = [];

  const teams = TEAMS.map((spec): TeamRecord => {
    const id = teamUuid();
    for (const [project, projectRole, age] of spec.grants) {
      projectNamed(project).teamGrants.push({
        teamId: id,
        projectRole,
        createdAt: daysAgo(age),
      });
    }
    const invitations = spec.invitations.map((inv): TeamInvitationWire => {
      const row = { ...invitationBase(inv), teamRole: inv.role };
      if (inv.token !== undefined) {
        tokens.push({
          token: inv.token,
          invitationId: row.id,
          kind: "TEAM",
          targetId: id,
        });
      }
      return row;
    });
    return {
      id,
      name: spec.name,
      createdAt: daysAgo(spec.ageDays),
      members: spec.members.map(([m, teamRole, age]) => ({
        userId: m.id,
        teamRole,
        createdAt: daysAgo(age),
        user: { id: m.id, email: m.email, name: m.name },
      })),
      invitations,
    };
  });

  for (const [project, inv] of PROJECT_INVITATIONS) {
    const row: ProjectInvitationWire = {
      ...invitationBase(inv),
      projectRole: inv.role,
    };
    projectNamed(project).invitations.push(row);
  }
  return { teams, tokens };
}

export function createDb(): Db {
  const users: AdminUserWire[] = [...PEOPLE, ...CROWD].map((p) => ({
    id: p.id,
    email: p.email,
    name: p.name,
    platformRole: p.admin ? "PLATFORM_ADMIN" : "USER",
    createdAt: daysAgo(p.joinedDaysAgo),
  }));
  const projects = [
    checkoutService(),
    paymentGateway(),
    notificationWorker(),
    mobileBff(),
    analyticsApi(),
    legacyBilling(),
    searchService(),
    fraudDetector(),
    marketingSite(),
    adminOnlyProject("data-pipeline", TUNG, "ACTIVE", "GCP"),
    adminOnlyProject("internal-wiki", LINH, "DRAFT", undefined),
    ...FLEET.map(fleetProject),
  ];
  const { teams, tokens } = seedTeams(projects);
  const db: Db = {
    me: {
      id: ANH.id,
      email: ANH.email,
      name: ANH.name,
      platformRole: "PLATFORM_ADMIN",
    },
    signedIn: true,
    users,
    projects,
    teams,
    invitationTokens: tokens,
    configVersion: 1_284,
  };
  // Vai của người đang xem đến từ CẢ nhóm: `data-pipeline` hiện ra, `search-service` lên Người duy trì
  refreshMyAccess(db);
  return db;
}

/** Ngày đầu tiên có số đếm telemetry — trang Dọn dẹp nói nó đã quan sát bao lâu */
export const TELEMETRY_SINCE = dateDaysAgo(58);
