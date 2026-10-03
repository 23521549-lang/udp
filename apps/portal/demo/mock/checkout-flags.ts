import type { FlagSpec, SegmentSpec } from "./seed";

/**
 * Phần còn lại của bộ flag `checkout-service`: một dịch vụ thanh toán đã chạy gần một năm thì có vài chục flag ở đủ
 * vòng đời (đang chạy, nháp đã bật ở dev, đã lưu trữ, công tắc khẩn cấp lâu dài), rule nhiều điều kiện, và vài
 * flag đáng dọn. Số lượt đánh giá là số lẻ tự nhiên, không tròn.
 */

const QA_USERS = Array.from(
  { length: 18 },
  (_, i) => `user-qa-${String(i + 1).padStart(2, "0")}`,
);

export const EXTRA_CHECKOUT_SEGMENTS: SegmentSpec[] = [
  {
    name: "vip-gold-members",
    description: "Hạng vàng, tổng chi tiêu từ 25 triệu đồng",
    all: [
      { attribute: "tier", operator: "eq", value: "gold" },
      { attribute: "lifetimeValue", operator: "gte", value: 25_000_000 },
    ],
    ageDays: 70,
  },
  {
    name: "promo-abusers",
    description:
      "Email có dấu + kèm số và tài khoản mới dưới 30 ngày: dấu hiệu săn mã",
    all: [
      {
        attribute: "email",
        operator: "regex",
        value: "^[a-z0-9._]+\\+[0-9]+@",
      },
      { attribute: "accountAgeDays", operator: "lt", value: 30 },
    ],
    ageDays: 40,
  },
  {
    name: "new-signups-7d",
    description: "Tài khoản tạo trong 7 ngày gần nhất",
    all: [{ attribute: "accountAgeDays", operator: "lt", value: 7 }],
    ageDays: 30,
  },
  {
    name: "qa-accounts",
    description: "Tài khoản kiểm thử tự động của đội QA",
    userIds: QA_USERS,
    ageDays: 110,
  },
  {
    name: "android-low-end",
    description: "Máy Android RAM từ 3 GB trở xuống, app dưới 3.2",
    all: [
      { attribute: "platform", operator: "eq", value: "android" },
      { attribute: "deviceRamGb", operator: "lte", value: 3 },
      { attribute: "appVersion", operator: "semverLt", value: "3.2.0" },
    ],
    ageDays: 22,
  },
  {
    name: "tet-2027-early-access",
    description: "Khách được mời mua sớm đợt Tết Đinh Mùi 2027",
    userIds: [
      "cus-20417",
      "cus-20588",
      "cus-21093",
      "cus-21760",
      "cus-22314",
      "cus-22905",
      "cus-23381",
      "cus-24026",
      "cus-24712",
    ],
    ageDays: 3,
  },
];

export const EXTRA_CHECKOUT_FLAGS: FlagSpec[] = [
  {
    key: "one-click-reorder",
    type: "BOOLEAN",
    description: "Mua lại đơn cũ bằng một chạm trong app",
    default: "off",
    ageDays: 26,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "ordersCount", operator: "gte", value: 3 },
            {
              attribute: "platform",
              operator: "in",
              value: ["ios", "android"],
            },
          ],
          serve: "on",
          description: "Khách đã mua từ 3 đơn, dùng app",
        },
      ],
    },
    traffic: 17_340,
    mix: { on: 0.27, off: 0.73 },
  },
  {
    key: "bnpl-installments",
    type: "STRING",
    description: "Trả góp qua ví trả sau (Kredivo, Fundiin) cho giỏ từ 3 triệu",
    variants: [
      ["off", "off"],
      ["kredivo", "kredivo"],
      ["fundiin", "fundiin"],
    ],
    default: "off",
    ageDays: 14,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "kredivo" }],
      staging: [{ type: "ALL", serve: "fundiin" }],
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "cartTotal", operator: "gte", value: 3_000_000 },
            { attribute: "country", operator: "eq", value: "VN" },
          ],
          serve: [
            ["kredivo", 50],
            ["fundiin", 50],
          ],
          description: "Chia đều hai đối tác để so tỉ lệ duyệt",
        },
      ],
    },
    traffic: 9_870,
    mix: { off: 0.81, kredivo: 0.1, fundiin: 0.09 },
  },
  {
    key: "cod-limit",
    type: "NUMBER",
    description: "Giá trị đơn tối đa được trả tiền khi nhận hàng (VND)",
    variants: [
      ["5m", 5_000_000],
      ["10m", 10_000_000],
      ["2m", 2_000_000],
    ],
    default: "5m",
    ageDays: 190,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "SEGMENT",
          segment: "promo-abusers",
          serve: "2m",
          description: "Hạn chế COD với tài khoản nghi săn mã",
        },
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "city", operator: "in", value: ["HCM", "HN"] },
            { attribute: "accountAgeDays", operator: "gte", value: 180 },
          ],
          serve: "10m",
          description: "Khách lâu năm ở hai thành phố lớn",
        },
      ],
    },
    traffic: 30_120,
    mix: { "5m": 0.62, "10m": 0.35, "2m": 0.03 },
  },
  {
    key: "vat-invoice-auto",
    type: "BOOLEAN",
    description:
      "Tự xuất hoá đơn VAT điện tử khi đơn doanh nghiệp giao thành công",
    default: "off",
    ageDays: 88,
    enabled: [true, true, true],
    rules: {
      prod: [{ type: "SEGMENT", segment: "enterprise-accounts", serve: "on" }],
    },
    traffic: 4_210,
    mix: { off: 0.9, on: 0.1 },
  },
  {
    key: "checkout-timeout-seconds",
    type: "NUMBER",
    description: "Thời gian giữ giỏ hàng trước khi nhả tồn kho",
    variants: [
      ["900", 900],
      ["1800", 1800],
    ],
    default: "900",
    ageDays: 130,
    enabled: [true, true, true],
    rules: { staging: [{ type: "ALL", serve: "1800" }] },
    traffic: 25_440,
    mix: { "900": 1 },
    stale: "SETTLED",
  },
  {
    key: "saved-cards",
    type: "BOOLEAN",
    description: "Lưu thẻ (token hoá qua cổng) cho lần thanh toán sau",
    default: "on",
    permanent: true,
    ageDays: 230,
    enabled: [true, true, true],
    traffic: 38_910,
    mix: { on: 1 },
  },
  {
    key: "fraud-check-mode",
    type: "STRING",
    description: "Mức kiểm tra gian lận trước khi tạo đơn",
    variants: [
      ["passive", "passive"],
      ["strict", "strict"],
      ["off", "off"],
    ],
    default: "passive",
    ageDays: 72,
    enabled: [true, true, true],
    rules: {
      staging: [{ type: "SEGMENT", segment: "qa-accounts", serve: "off" }],
      prod: [
        {
          type: "SEGMENT",
          segment: "qa-accounts",
          serve: "off",
          description: "Tài khoản kiểm thử tự động",
        },
        { type: "SEGMENT", segment: "promo-abusers", serve: "strict" },
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "paymentMethod", operator: "eq", value: "cod" },
            { attribute: "cartTotal", operator: "gt", value: 5_000_000 },
          ],
          serve: "strict",
          description: "Đơn COD giá trị cao",
        },
      ],
    },
    traffic: 41_730,
    mix: { passive: 0.88, strict: 0.11, off: 0.01 },
  },
  {
    key: "shipping-partner",
    type: "STRING",
    description: "Đơn vị vận chuyển mặc định theo vùng và khung giờ",
    variants: [
      ["ghn", "ghn"],
      ["ghtk", "ghtk"],
      ["viettel-post", "viettel-post"],
      ["ahamove", "ahamove"],
    ],
    default: "ghn",
    ageDays: 150,
    enabled: [true, true, true],
    rules: {
      staging: [{ type: "ALL", serve: "ghtk" }],
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "city", operator: "in", value: ["HCM", "HN"] },
            { attribute: "deliverySlot", operator: "eq", value: "same-day" },
          ],
          serve: "ahamove",
          description: "Giao trong ngày ở hai thành phố lớn",
        },
        {
          type: "ATTRIBUTE_BASED",
          when: [
            {
              attribute: "region",
              operator: "in",
              value: ["mien-tay", "tay-nguyen"],
            },
          ],
          serve: "viettel-post",
        },
        {
          type: "ALL",
          serve: [
            ["ghn", 60],
            ["ghtk", 40],
          ],
        },
      ],
    },
    traffic: 29_810,
    mix: { ghn: 0.47, ghtk: 0.31, "viettel-post": 0.12, ahamove: 0.1 },
  },
  {
    key: "voucher-stacking",
    type: "BOOLEAN",
    description: "Xếp chồng mã giảm giá của shop với mã của sàn",
    default: "off",
    ageDays: 35,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      staging: [{ type: "ALL", serve: "on" }],
      prod: [
        {
          type: "ALL",
          serve: "off",
          description: "Đã rollback, chờ sửa lỗi áp mã hai lần",
        },
      ],
    },
    traffic: 21_050,
    mix: { off: 1 },
  },
  {
    key: "address-v2-form",
    type: "BOOLEAN",
    description: "Biểu mẫu địa chỉ theo đơn vị hành chính mới (bỏ cấp huyện)",
    default: "off",
    ageDays: 11,
    enabled: [true, true, true],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      staging: [{ type: "ALL", serve: "on" }],
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "country", operator: "eq", value: "VN" },
            { attribute: "appVersion", operator: "semverGt", value: "3.4.0" },
          ],
          serve: "on",
        },
      ],
    },
    traffic: 14_980,
    mix: { on: 0.41, off: 0.59 },
  },
  {
    key: "guest-checkout",
    type: "BOOLEAN",
    description: "Mua hàng không cần đăng nhập",
    default: "on",
    permanent: true,
    ageDays: 260,
    enabled: [true, true, true],
    traffic: 19_270,
    mix: { on: 1 },
  },
  {
    key: "order-tracking-map",
    type: "BOOLEAN",
    description: "Bản đồ theo dõi shipper trực tiếp sau khi đặt",
    default: "off",
    ageDays: 44,
    enabled: [true, true, true],
    rules: {
      prod: [{ type: "SEGMENT", segment: "vn-mobile-users", serve: "on" }],
    },
    traffic: 11_640,
    mix: { on: 0.58, off: 0.42 },
  },
  {
    key: "price-rounding",
    type: "STRING",
    description: "Cách làm tròn giá sau khuyến mãi",
    variants: [
      ["nearest-1000", "nearest-1000"],
      ["floor-500", "floor-500"],
    ],
    default: "nearest-1000",
    ageDays: 310,
    enabled: [true, true, true],
    traffic: 33_210,
    mix: { "nearest-1000": 1 },
    stale: "SETTLED",
  },
  {
    key: "cart-abandon-reminder",
    type: "JSON",
    description: "Lịch nhắc giỏ hàng bỏ dở qua Zalo và email",
    variants: [
      ["gentle", { channels: ["email"], delaysMinutes: [60, 1440] }],
      [
        "aggressive",
        { channels: ["zalo", "email"], delaysMinutes: [30, 180, 1440] },
      ],
    ],
    default: "gentle",
    ageDays: 57,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "SEGMENT",
          segment: "high-value-customers",
          serve: "aggressive",
        },
      ],
    },
    traffic: 6_870,
    mix: { gentle: 0.83, aggressive: 0.17 },
  },
  {
    key: "checkout-captcha",
    type: "BOOLEAN",
    description: "Captcha khi đặt đơn lúc có dấu hiệu tấn công",
    default: "off",
    ageDays: 19,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [{ attribute: "riskScore", operator: "gte", value: 0.8 }],
          serve: "on",
        },
        {
          type: "ATTRIBUTE_BASED",
          when: [
            {
              attribute: "ipCountry",
              operator: "nin",
              value: ["VN", "SG", "US"],
            },
            { attribute: "accountAgeDays", operator: "lt", value: 1 },
          ],
          serve: "on",
          description: "Tài khoản vừa tạo, truy cập từ nước lạ",
        },
      ],
    },
    traffic: 45_020,
    mix: { off: 0.97, on: 0.03 },
  },
  {
    key: "split-payment",
    type: "BOOLEAN",
    description: "Chia một đơn cho nhiều thẻ, đang thử với đội QA",
    default: "off",
    lifecycle: "DRAFT",
    ageDays: 8,
    enabled: [true, false, false],
    rules: {
      dev: [
        {
          type: "USER_BASED",
          users: ["user-qa-03", "user-qa-11"],
          serve: "on",
        },
      ],
    },
    traffic: 0,
  },
  {
    key: "gift-wrapping",
    type: "BOOLEAN",
    description: "Gói quà và thiệp chúc mừng cho đợt 20/10",
    default: "off",
    lifecycle: "DRAFT",
    ageDays: 6,
    enabled: [true, true, false],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      staging: [{ type: "SEGMENT", segment: "internal-staff", serve: "on" }],
    },
    traffic: 0,
  },
  {
    key: "crypto-payment",
    type: "BOOLEAN",
    description: "Thanh toán bằng USDT qua đối tác, chờ pháp chế duyệt",
    default: "off",
    lifecycle: "DRAFT",
    ageDays: 23,
    enabled: [true, false, false],
    rules: {
      dev: [
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "country", operator: "eq", value: "SG" },
            { attribute: "email", operator: "endsWith", value: "@udp.dev" },
          ],
          serve: "on",
        },
      ],
    },
    traffic: 0,
  },
  {
    key: "checkout-survey",
    type: "STRING",
    description: "Khảo sát một câu sau khi thanh toán xong",
    variants: [
      ["none", "none"],
      ["nps", "nps"],
      ["csat", "csat"],
    ],
    default: "none",
    lifecycle: "DRAFT",
    ageDays: 2,
    enabled: [true, false, false],
    rules: {
      dev: [
        {
          type: "ALL",
          serve: [
            ["nps", 50],
            ["csat", 50],
          ],
        },
      ],
    },
    traffic: 0,
  },
  {
    key: "installment-banner",
    type: "BOOLEAN",
    description: "Banner trả góp 0% ở trang giỏ hàng",
    default: "off",
    lifecycle: "DRAFT",
    ageDays: 51,
    enabled: [false, false, false],
    traffic: 0,
    stale: "STALE_DRAFT",
  },
  {
    key: "tet-2026-theme",
    type: "BOOLEAN",
    description: "Giao diện Tết Bính Ngọ 2026",
    default: "off",
    lifecycle: "ARCHIVED",
    ageDays: 262,
    enabled: [false, false, false],
    traffic: 0,
  },
  {
    key: "black-friday-2025",
    type: "BOOLEAN",
    description: "Đồng hồ đếm ngược Black Friday 2025",
    default: "off",
    lifecycle: "ARCHIVED",
    ageDays: 341,
    enabled: [false, false, false],
    traffic: 0,
  },
  {
    key: "old-shipping-calc",
    type: "BOOLEAN",
    description: "Tính phí vận chuyển kiểu cũ, trước GHN API v2",
    default: "off",
    lifecycle: "ARCHIVED",
    ageDays: 318,
    enabled: [false, false, false],
    traffic: 0,
  },
  {
    key: "legacy-cart-merge",
    type: "BOOLEAN",
    description: "Gộp giỏ của khách vãng lai vào tài khoản (cách cũ)",
    default: "off",
    ageDays: 212,
    enabled: [false, false, false],
    traffic: 0,
    stale: "UNUSED",
    lastEvaluatedDaysAgo: 63,
  },
  {
    key: "paypal-express",
    type: "BOOLEAN",
    description: "Nút PayPal Express cho khách quốc tế",
    default: "off",
    ageDays: 284,
    enabled: [false, false, false],
    traffic: 0,
    stale: "UNUSED",
    lastEvaluatedDaysAgo: 38,
  },
  {
    key: "coupon-input-position",
    type: "STRING",
    description: "Thử nghiệm A/B vị trí ô nhập mã giảm giá",
    variants: [
      ["top", "top"],
      ["bottom", "bottom"],
    ],
    default: "bottom",
    ageDays: 29,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "ALL",
          serve: [
            ["top", 50],
            ["bottom", 50],
          ],
          description: "A/B 50/50, chốt sau 4 tuần",
        },
      ],
    },
    traffic: 36_610,
    mix: { top: 0.5, bottom: 0.5 },
  },
  {
    key: "estimated-delivery-date",
    type: "BOOLEAN",
    description: "Hiện ngày giao dự kiến trước khi đặt",
    default: "on",
    ageDays: 97,
    enabled: [true, true, true],
    traffic: 40_330,
    mix: { on: 1 },
  },
  {
    key: "momo-qr-inline",
    type: "BOOLEAN",
    description: "Mã QR MoMo hiện ngay trong trang, không chuyển sang app",
    default: "off",
    ageDays: 38,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [
            { attribute: "platform", operator: "eq", value: "web" },
            { attribute: "paymentMethod", operator: "eq", value: "momo" },
          ],
          serve: "on",
        },
      ],
    },
    traffic: 8_760,
    mix: { on: 0.22, off: 0.78 },
  },
  {
    key: "tax-display-mode",
    type: "STRING",
    description: "Hiện giá đã gồm VAT hay chưa gồm VAT",
    variants: [
      ["inclusive", "inclusive"],
      ["exclusive", "exclusive"],
    ],
    default: "inclusive",
    ageDays: 175,
    enabled: [true, true, true],
    rules: {
      prod: [
        { type: "SEGMENT", segment: "enterprise-accounts", serve: "exclusive" },
      ],
    },
    traffic: 27_940,
    mix: { inclusive: 0.93, exclusive: 0.07 },
  },
  {
    key: "max-vouchers-per-order",
    type: "NUMBER",
    description: "Số mã giảm giá tối đa mỗi đơn",
    variants: [
      ["1", 1],
      ["2", 2],
    ],
    default: "1",
    ageDays: 35,
    enabled: [true, true, true],
    rules: { staging: [{ type: "ALL", serve: "2" }] },
    traffic: 21_050,
    mix: { "1": 1 },
  },
  {
    key: "inventory-hold-strategy",
    type: "STRING",
    description: "Giữ tồn kho lúc vào trang thanh toán hay lúc trả tiền",
    variants: [
      ["on-payment", "on-payment"],
      ["on-checkout", "on-checkout"],
    ],
    default: "on-payment",
    ageDays: 66,
    enabled: [true, true, true],
    rules: {
      staging: [{ type: "ALL", serve: "on-checkout" }],
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [{ attribute: "flashSale", operator: "eq", value: true }],
          serve: "on-checkout",
          description: "Giờ vàng flash sale",
        },
      ],
    },
    traffic: 24_310,
    mix: { "on-payment": 0.9, "on-checkout": 0.1 },
  },
  {
    key: "web-vitals-sampling",
    type: "NUMBER",
    description: "Tỉ lệ lấy mẫu số đo hiệu năng của trang thanh toán",
    variants: [
      ["1pct", 0.01],
      ["10pct", 0.1],
    ],
    default: "1pct",
    ageDays: 83,
    enabled: [true, true, true],
    rules: {
      prod: [{ type: "SEGMENT", segment: "internal-staff", serve: "10pct" }],
    },
    traffic: 44_050,
    mix: { "1pct": 0.99, "10pct": 0.01 },
  },
  {
    key: "zalopay-cashback-banner",
    type: "BOOLEAN",
    description: "Banner hoàn tiền ZaloPay tháng 10",
    default: "off",
    ageDays: 13,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "ATTRIBUTE_BASED",
          when: [
            {
              attribute: "platform",
              operator: "in",
              value: ["ios", "android"],
            },
            { attribute: "appVersion", operator: "semverGt", value: "3.2.0" },
            {
              attribute: "city",
              operator: "in",
              value: ["HCM", "HN", "DN", "CT"],
            },
          ],
          serve: "on",
          description: "App mới ở bốn thành phố",
        },
      ],
    },
    traffic: 16_920,
    mix: { on: 0.44, off: 0.56 },
  },
  {
    key: "payment-retry-kill-switch",
    type: "BOOLEAN",
    description: "Công tắc khẩn: tắt tự thử lại khi cổng thanh toán quá tải",
    default: "on",
    permanent: true,
    ageDays: 205,
    enabled: [true, true, true],
    traffic: 12_870,
    mix: { on: 1 },
  },
  {
    key: "order-notes-limit",
    type: "NUMBER",
    description: "Số ký tự tối đa của ghi chú đơn hàng",
    variants: [
      ["200", 200],
      ["500", 500],
    ],
    default: "200",
    ageDays: 120,
    enabled: [true, true, true],
    traffic: 18_430,
    mix: { "200": 1 },
  },
  {
    key: "pickup-at-store",
    type: "BOOLEAN",
    description: "Nhận hàng tại cửa hàng gần nhất",
    default: "off",
    ageDays: 48,
    enabled: [true, true, false],
    rules: {
      dev: [{ type: "ALL", serve: "on" }],
      staging: [
        {
          type: "ATTRIBUTE_BASED",
          when: [{ attribute: "city", operator: "in", value: ["HCM"] }],
          serve: "on",
        },
      ],
    },
    traffic: 3_120,
    mix: { off: 1 },
  },
  {
    key: "loyalty-redeem-at-checkout",
    type: "BOOLEAN",
    description: "Dùng điểm thưởng để trừ tiền khi thanh toán",
    default: "off",
    ageDays: 31,
    enabled: [true, true, true],
    rules: {
      prod: [
        { type: "SEGMENT", segment: "vip-gold-members", serve: "on" },
        { type: "SEGMENT", segment: "beta-testers", serve: "on" },
      ],
    },
    traffic: 10_410,
    mix: { on: 0.19, off: 0.81 },
  },
  {
    key: "new-signup-discount",
    type: "NUMBER",
    description: "Phần trăm giảm cho đơn đầu của tài khoản mới",
    variants: [
      ["0", 0],
      ["10", 10],
      ["15", 15],
    ],
    default: "0",
    ageDays: 24,
    enabled: [true, true, true],
    rules: {
      prod: [
        {
          type: "SEGMENT",
          segment: "new-signups-7d",
          serve: [
            ["10", 50],
            ["15", 50],
          ],
          description: "A/B mức giảm đơn đầu",
        },
      ],
    },
    traffic: 26_730,
    mix: { "0": 0.86, "10": 0.07, "15": 0.07 },
  },
];
