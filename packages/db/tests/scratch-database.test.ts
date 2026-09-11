import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertScratchName,
  connectionStringsIn,
  expectedRoleOf,
  maskForGitHub,
  pointAt,
  SCRATCH_NAME_PATTERN,
  scratchEnv,
  scratchNameFromEnv,
} from "../scripts/helpers/scratch-database.js";

/**
 * Phần THUẦN của cơ chế database scratch — không chạm database.
 *
 * Ba hàm dưới đây đứng giữa bộ test và database thật của người dùng: `pointAt`
 * quyết định test nối vào đâu, `scratchEnv` quyết định biến nào được đổi, và
 * `assertScratchName` quyết định `DROP DATABASE` được phép nhận tên gì. Sai ở
 * đây là chạy test lên dữ liệu dev, hoặc xoá nhầm `postgres`, mà không có lỗi
 * nào báo. Đó là lý do chúng có test riêng thay vì chỉ được kiểm gián tiếp qua
 * `verify-chain`.
 */

const OWNER = "postgres.abcdefghijklmnop";
const PASS = "p4ss_w0rd-with_32_characters_ok";
const BASE = `postgresql://${OWNER}:${PASS}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;

describe("assertScratchName", () => {
  it("nhận tên của verify-chain, của bộ test đầy đủ, và của CI", () => {
    for (const name of [
      "udp_verify_1789093014676",
      "udp_scratch_1789093014676",
      "udp_scratch_ci_34553567740_1",
      "udp_scratch_bootstrap_1",
    ]) {
      expect(assertScratchName(name)).toBe(name);
    }
  });

  it("TỪ CHỐI mọi tên có thể là database thật hoặc là SQL chèn vào", () => {
    for (const name of [
      "postgres",
      "template1",
      "udp_verify_1; DROP DATABASE postgres",
      "udp_scratch_",
      "udp_Scratch_1",
      "UDP_SCRATCH_1",
      `udp_scratch_${"x".repeat(51)}`,
      "udp_other_1",
      "",
    ]) {
      expect(() => assertScratchName(name), name).toThrow(/không hợp lệ/);
    }
  });

  it("pattern chỉ có hai tiền tố, mỗi tiền tố một chủ", () => {
    expect(String(SCRATCH_NAME_PATTERN)).toContain("verify|scratch");
  });
});

describe("scratchNameFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lấy tên tất định từ UDP_SCRATCH_DB_NAME khi có", () => {
    vi.stubEnv("UDP_SCRATCH_DB_NAME", "udp_scratch_ci_1_1");
    expect(scratchNameFromEnv("udp_scratch")).toBe("udp_scratch_ci_1_1");
  });

  it("không có thì đặt theo tiền tố và thời điểm", () => {
    vi.stubEnv("UDP_SCRATCH_DB_NAME", "");
    expect(scratchNameFromEnv("udp_scratch")).toMatch(/^udp_scratch_\d{13}$/);
  });

  it("tên từ env vẫn phải qua hàng rào", () => {
    vi.stubEnv("UDP_SCRATCH_DB_NAME", "postgres");
    expect(() => scratchNameFromEnv("udp_scratch")).toThrow(/không hợp lệ/);
  });
});

describe("pointAt", () => {
  it("chỉ đổi tên database, giữ user, mật khẩu, host, cổng", () => {
    const out = new URL(pointAt(BASE, "udp_scratch_1"));
    expect(out.pathname).toBe("/udp_scratch_1");
    expect(out.username).toBe(OWNER);
    expect(out.password).toBe(PASS);
    expect(out.host).toBe("aws-0-ap-southeast-1.pooler.supabase.com:5432");
  });

  it("GIỮ query string — sslmode=require phải tới được Prisma CLI", () => {
    // Bản đầu của verify-chain gỡ sslmode trước khi đổi tên, làm Prisma rơi về
    // `prefer` trên một pooler chấp nhận kết nối không mã hoá.
    const out = new URL(
      pointAt(`${BASE}?schema=public&sslmode=require`, "udp_scratch_1"),
    );
    expect(out.searchParams.get("sslmode")).toBe("require");
    expect(out.searchParams.get("schema")).toBe("public");
  });
});

describe("expectedRoleOf", () => {
  it("bỏ phần tenant sau dấu chấm của pooler Supabase", () => {
    expect(expectedRoleOf(BASE)).toBe("postgres");
    expect(expectedRoleOf("postgresql://udp_s2.abc:x@h:6543/postgres")).toBe(
      "udp_s2",
    );
  });

  it("username không có dấu chấm thì là chính role", () => {
    expect(expectedRoleOf("postgresql://udp_s1:x@localhost:5432/udp")).toBe(
      "udp_s1",
    );
  });
});

describe("scratchEnv", () => {
  const base: NodeJS.ProcessEnv = {
    DATABASE_URL: `${BASE}?pgbouncer=true`,
    DATABASE_URL_DIRECT: `${BASE}?sslmode=require`,
    DATABASE_URL_S1: "postgresql://udp_s1.abc:x@h:6543/postgres",
    DATABASE_URL_S2: "postgresql://udp_s2.abc:x@h:6543/postgres",
    DATABASE_URL_S2_DIRECT: "postgresql://udp_s2.abc:x@h:5432/postgres",
    DATABASE_POOL_MAX: "5",
    NODE_ENV: "test",
  };

  it("đổi MỌI chuỗi kết nối, kể cả biến chưa có tên trong danh sách nào", () => {
    const out = scratchEnv(
      { ...base, DATABASE_URL_S3: "postgresql://udp_s3.abc:x@h:6543/postgres" },
      "udp_scratch_9",
    );
    for (const key of [
      "DATABASE_URL",
      "DATABASE_URL_DIRECT",
      "DATABASE_URL_S1",
      "DATABASE_URL_S2",
      "DATABASE_URL_S2_DIRECT",
      "DATABASE_URL_S3",
    ]) {
      expect(new URL(out[key] ?? "").pathname, key).toBe("/udp_scratch_9");
    }
  });

  it("không đụng biến khác, kể cả biến có tiền tố DATABASE nhưng không phải URL", () => {
    const out = scratchEnv(base, "udp_scratch_9");
    expect(out["DATABASE_POOL_MAX"]).toBe("5");
    expect(out["NODE_ENV"]).toBe("test");
  });

  it("bỏ qua biến rỗng và biến không có", () => {
    const out = scratchEnv(
      { DATABASE_URL: BASE, DATABASE_URL_S2_DIRECT: "" },
      "udp_scratch_9",
    );
    expect(out["DATABASE_URL_S2_DIRECT"]).toBe("");
    expect(out["DATABASE_URL_S1"]).toBeUndefined();
  });

  it("overrides thắng sau khi đổi", () => {
    const out = scratchEnv(base, "udp_scratch_9", {
      CHANGEFEED_NOTIFY_ENABLED: "false",
      DATABASE_URL: "postgresql://x:y@z/khac",
    });
    expect(out["CHANGEFEED_NOTIFY_ENABLED"]).toBe("false");
    expect(out["DATABASE_URL"]).toBe("postgresql://x:y@z/khac");
  });

  it("không sửa object đầu vào", () => {
    const snapshot = { ...base };
    scratchEnv(base, "udp_scratch_9");
    expect(base).toEqual(snapshot);
  });
});

describe("connectionStringsIn", () => {
  it("chỉ nhặt DATABASE_URL và các biến DATABASE_URL_*", () => {
    const names = connectionStringsIn({
      DATABASE_URL: BASE,
      DATABASE_URL_S1: BASE,
      DATABASE_URLX: BASE,
      DATABASE_POOL_MAX: "5",
      OTHER_URL: BASE,
    }).map(([name]) => name);
    expect(names).toEqual(["DATABASE_URL", "DATABASE_URL_S1"]);
  });
});

describe("maskForGitHub", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ngoài GitHub Actions thì im lặng", () => {
    vi.stubEnv("GITHUB_ACTIONS", "");
    const lines: string[] = [];
    expect(maskForGitHub({ DATABASE_URL: BASE }, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([]);
  });

  it("trên GitHub che chuỗi dẫn xuất, bản đã gỡ sslmode, và mật khẩu", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const lines: string[] = [];
    const derived = pointAt(`${BASE}?sslmode=require`, "udp_scratch_9");
    maskForGitHub({ DATABASE_URL_DIRECT: derived }, (l) => lines.push(l));
    expect(lines).toContain(`::add-mask::${derived}`);
    expect(lines).toContain(`::add-mask::${PASS}`);
    expect(
      lines.some((l) => l.startsWith("::add-mask::") && !l.includes("sslmode")),
    ).toBe(true);
    expect(lines.every((l) => l.startsWith("::add-mask::"))).toBe(true);
  });

  it("không che mật khẩu ngắn — log sẽ toàn dấu sao ở chỗ không liên quan", () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    const lines: string[] = [];
    maskForGitHub(
      { DATABASE_URL: "postgresql://u:short@h:5432/postgres" },
      (l) => lines.push(l),
    );
    expect(lines).not.toContain("::add-mask::short");
  });
});
