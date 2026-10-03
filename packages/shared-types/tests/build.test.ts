import { describe, expect, it } from "vitest";
import {
  buildSettingsSchema,
  identityLineSchema,
  kmsCloudOf,
  rebaseScheduleOf,
  signingKeySchema,
} from "../src/build.js";

/** [Plan #61 QĐ-13] Lịch rebase: tất định, trong 01:00–06:59 UTC, phút khác 0; ghim Dockerfile ⇒ không có lịch */
describe("rebaseScheduleOf", () => {
  it("tất định theo slug, đúng khung giờ, cron khớp giờ và phút", () => {
    const a = rebaseScheduleOf({ strategy: "auto" }, "checkout-service");
    expect(
      rebaseScheduleOf({ strategy: "buildpacks" }, "checkout-service"),
    ).toEqual(a);
    expect(a).not.toBeNull();
    const slugs = Array.from({ length: 200 }, (_, i) => `project-${String(i)}`);
    const schedules = slugs.map((s) =>
      rebaseScheduleOf({ strategy: "auto" }, s),
    );
    for (const s of schedules) {
      expect(s?.hour).toBeGreaterThanOrEqual(1);
      expect(s?.hour).toBeLessThanOrEqual(6);
      expect(s?.minute).toBeGreaterThanOrEqual(1);
      expect(s?.minute).toBeLessThanOrEqual(59);
      expect(s?.cron).toBe(`${String(s?.minute)} ${String(s?.hour)} * * *`);
    }
    // Rải tải: 200 project không dồn vào vài giờ chạy
    expect(new Set(schedules.map((s) => s?.cron)).size).toBeGreaterThan(100);
    expect(new Set(schedules.map((s) => s?.hour)).size).toBe(6);
  });

  it("ghim Dockerfile ⇒ không rebase (chỉ image Buildpacks rebase được)", () => {
    expect(rebaseScheduleOf({ strategy: "dockerfile" }, "web")).toBeNull();
  });
});

/** [Plan #61 QĐ-14] Khoá ký: UDP chỉ giữ khoá CÔNG KHAI và URI KMS — không dán nhầm khoá bí mật vào được */
describe("khoá ký trong cài đặt build", () => {
  const PUBLIC_KEY = [
    "-----BEGIN PUBLIC KEY-----",
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqiJ47Ds3Y2TbFCw4JagPiaOIeCa/",
    "wS9xvpZbCExNKUpb+0KnUa/P2qChCnZMz/syHOSQ/YALGnpK1fSK/Hq9CQ==",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n");
  const KMS = {
    aws: "awskms:///arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    gcp: "gcpkms://projects/acme-prod/locations/asia-southeast1/keyRings/udp/cryptoKeys/udp-sign-web/versions/1",
    azure: "azurekms://udpa1b2c3d4.vault.azure.net/udp-sign",
  } as const;

  it("URI KMS của ba cloud được nhận ra; dạng khác thì không", () => {
    for (const [cloud, uri] of Object.entries(KMS)) {
      expect(kmsCloudOf(uri), cloud).toBe(cloud);
    }
    for (const bad of [
      "awskms:///alias/udp-sign-web",
      "gcpkms://projects/acme/locations/x/keyRings/udp/cryptoKeys/k",
      "azurekms://evil.example.com/udp-sign",
      "hashivault://udp-sign",
    ]) {
      expect(kmsCloudOf(bad), bad).toBeNull();
    }
  });

  it("khoá công khai PEM qua; khoá bí mật hay chuỗi lạ bị chặn", () => {
    expect(
      signingKeySchema.safeParse({ publicKey: PUBLIC_KEY, kms: KMS.aws })
        .success,
    ).toBe(true);
    for (const bad of [
      PUBLIC_KEY.replace(/PUBLIC KEY/g, "PRIVATE KEY"),
      PUBLIC_KEY.replace(/PUBLIC KEY/g, "EC PRIVATE KEY"),
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI",
    ]) {
      expect(
        signingKeySchema.safeParse({ publicKey: bad, kms: KMS.aws }).success,
      ).toBe(false);
    }
    expect(
      signingKeySchema.safeParse({
        publicKey: PUBLIC_KEY,
        kms: "awskms:///alias/x",
      }).success,
    ).toBe(false);
  });

  it("dòng của script mang danh tính và khoá ký; cài đặt mặc định chưa có khoá, chữ ký tương thích bật", () => {
    const line = identityLineSchema.parse({
      cloud: "aws",
      roleArn: "arn:aws:iam::123456789012:role/udp/udp-build-web",
      signing: { key: KMS.aws, publicKey: PUBLIC_KEY },
    });
    expect(line.signing?.key).toBe(KMS.aws);
    expect(
      identityLineSchema.safeParse({
        cloud: "aws",
        roleArn: "arn:aws:iam::123456789012:role/udp/udp-build-web",
        signing: { key: KMS.aws, publicKey: PUBLIC_KEY, secret: "x" },
      }).success,
    ).toBe(false);
    expect(buildSettingsSchema.parse({}).signing).toEqual({
      keys: [],
      compat: true,
      enforce: false,
    });
  });
});
