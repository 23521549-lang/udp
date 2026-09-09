import { describe, expect, it } from "vitest";
import { REDACT_ALLOWLIST, REDACTED_KEY_PATTERNS, REDACTED_PLACEHOLDER } from "@udp/config";
import { isSensitive, redact, redactPaths } from "../src/core/logger.js";

/**
 * Hai bản khai về "khoá nào là nhạy cảm" phải nói cùng một điều.
 *
 * pino chỉ nhận đường dẫn cụ thể nên `redactPaths` không sinh được từ regex —
 * trùng lặp là bắt buộc. Nhưng trùng lặp KHÔNG KIỂM là chỗ drift sống: hai
 * đường ghi khác nhau (log request đi theo paths, AuditLog đi theo patterns)
 * sẽ che secret ở một nơi và để lộ ở nơi kia, mà không có gì báo.
 */

// "res.headers['set-cookie']" -> "set-cookie"; "*.password" -> "password"
const leafOf = (path: string): string =>
  /\['([^']+)'\]$/.exec(path)?.[1] ?? path.split(".").pop() ?? path;

describe("redact — hai bản khai không được lệch nhau", () => {
  it("mọi khoá lá trong redactPaths đều khớp một pattern của @udp/config", () => {
    const orphans = redactPaths
      .map(leafOf)
      .filter((leaf) => !REDACTED_KEY_PATTERNS.some((p) => p.test(leaf)));

    expect(orphans).toEqual([]);
  });

  it("mọi pattern đều có ít nhất một đường dẫn pino tương ứng", () => {
    // CHIỀU GÂY RÒ RỈ, và là chiều từng bị bỏ sót. Có pattern mà không có path
    // nghĩa là: redact() che khoá đó ở AuditLog, còn log request để nguyên.
    // Test cũ khẳng định sshKey/privateKey/apiKey "phải bị che" trong khi pino
    // không hề che chúng — xanh, và cảm giác an toàn là giả.
    const leaves = redactPaths.map(leafOf);
    const uncovered = REDACTED_KEY_PATTERNS.filter((p) => !leaves.some((l) => p.test(l))).map(
      (p) => p.source,
    );
    expect(uncovered).toEqual([]);
  });

  it("không đường dẫn nào của pino lại bị allowlist miễn trừ", () => {
    // Chiều ngược lại. Một khoá vừa được pino che vừa được `redact()` bỏ qua là
    // hai bản khai nói ngược nhau, và ta sẽ không biết bên nào đúng.
    const contradictions = redactPaths.map(leafOf).filter((leaf) => !isSensitive(leaf));
    expect(contradictions).toEqual([]);
  });
});

describe("redact — che đúng thứ cần che", () => {
  it("đệ quy vào object và mảng lồng nhau", () => {
    const out = redact({
      email: "a@b.c",
      password: "hunter2",
      nested: { sshKey: "ssh-rsa AAA", encryptedDek: "abc", keyPrefix: "udp_sk_a" },
      list: [{ apiToken: "t" }],
    });

    expect(out).toEqual({
      email: "a@b.c",
      password: REDACTED_PLACEHOLDER,
      nested: {
        sshKey: REDACTED_PLACEHOLDER,
        encryptedDek: REDACTED_PLACEHOLDER,
        // keyPrefix là giá trị ĐỂ HIỂN THỊ — che nó là hỏng UI, không an toàn hơn
        keyPrefix: "udp_sk_a",
      },
      list: [{ apiToken: REDACTED_PLACEHOLDER }],
    });
  });

  it("không che tên trường chỉ vì nó nói VỀ khoá", () => {
    const out = redact({ key: "on", keyHash: "sha256...", keyType: "SERVER" });
    expect(out).toEqual({ key: "on", keyHash: "sha256...", keyType: "SERVER" });
  });

  it("che mọi biến thể của khoá thật", () => {
    for (const k of [
      "sshKey",
      "privateKey",
      "apiKey",
      "webhookKey",
      "kubeconfigKey",
      "encryptedPayload",
      "encryptedDek",
      "authorization",
      "cookie",
      "clientSecret",
      "accessKeyId",
      "password",
      "refreshToken",
    ]) {
      expect(isSensitive(k), `${k} phải bị che`).toBe(true);
    }
  });

  it("KHÔNG che định danh hiển thị dù chúng kết thúc bằng key", () => {
    // Mặt trái của pattern rộng `/.+key$/i`. Những cái tên này là chìa khoá để
    // ĐỌC log: `idempotencyKey` lần ra job trùng của ADR-02, `targetingKey` là
    // thuộc tính hash mặc định của OpenFeature, `variantKey`/`flagKey` là nhãn
    // của mọi thống kê đánh giá. Che chúng đi không làm hệ thống an toàn hơn,
    // chỉ làm log mất đúng phần dùng được.
    for (const k of [
      "idempotencyKey",
      "idempotency_key",
      "targetingKey",
      "variantKey",
      "variant_key",
      "flagKey",
      "flag_key",
      "bucketKey",
      "key",
    ]) {
      expect(isSensitive(k), `${k} KHÔNG được che`).toBe(false);
    }
  });

  it("allowlist không có dòng thừa", () => {
    // Một mục allowlist không khớp pattern nào thì không miễn trừ gì cả — nó chỉ
    // làm người đọc sau tưởng chỗ đó có ngoại lệ. Với danh sách mang tính bảo
    // mật, mỗi dòng phải có lý do tồn tại kiểm chứng được.
    const sample = (source: string): string => source.replace(/[\^$]/g, "").replace(/_\?/g, "_");
    const useless = REDACT_ALLOWLIST.filter(
      (a) => !REDACTED_KEY_PATTERNS.some((p) => p.test(sample(a.source))),
    );
    expect(useless.map((r) => r.source)).toEqual([]);
  });
});
