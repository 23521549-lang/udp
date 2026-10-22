import { createHash } from "node:crypto";
import { SDK_KEY } from "@udp/config/constants";
import { describe, expect, it } from "vitest";
import {
  envSlugOf,
  issueSdkKeyToken,
  maskedKeyOf,
  SDK_KEY_HASH_PATTERN,
  SDK_KEY_PLAINTEXT_PATTERN,
  SDK_KEY_SUFFIX_PATTERN,
  sdkKeyMaterialOf,
} from "../src/sdk-key.js";

/**
 * Vật liệu SDK key là hợp đồng giữa BỐN nơi (S1 phát hành, guard S2 tra, seed,
 * fixture). Test thuần, không database: thứ cần chốt là hình dạng token và công
 * thức hash/đuôi — lệch một ký tự là khoá phát hành ra không bao giờ khớp.
 */

describe("issueSdkKeyToken", () => {
  it("SERVER ⇒ udp_sk_, CLIENT ⇒ udp_ck_, đuôi 64 hex", () => {
    expect(issueSdkKeyToken("SERVER", "prod")).toMatch(
      /^udp_sk_[a-z0-9]{1,20}_[0-9a-f]{64}$/,
    );
    expect(issueSdkKeyToken("CLIENT", "prod")).toMatch(
      /^udp_ck_[a-z0-9]{1,20}_[0-9a-f]{64}$/,
    );
  });

  it('env "QA Việt" ⇒ udp_sk_qaviet_ (AC-4.9)', () => {
    expect(issueSdkKeyToken("SERVER", "QA Việt")).toMatch(
      /^udp_sk_qaviet_[0-9a-f]{64}$/,
    );
  });

  it("10 000 khoá không trùng nhau", () => {
    const tokens = new Set(
      Array.from({ length: 10_000 }, () => issueSdkKeyToken("SERVER", "dev")),
    );
    expect(tokens.size).toBe(10_000);
  });
});

describe("envSlugOf", () => {
  it.each([
    ["dev", "dev"],
    ["QA Việt", "qaviet"],
    ["Đà Nẵng", "danang"],
    ["staging-2", "staging2"],
    ["", "env"],
    ["!!! ---", "env"],
  ])("%j ⇒ %j", (name, slug) => {
    expect(envSlugOf(name)).toBe(slug);
  });

  it("cắt ở SDK_KEY.envSlugMaxLength ký tự", () => {
    expect(envSlugOf("a".repeat(50))).toBe(
      "a".repeat(SDK_KEY.envSlugMaxLength),
    );
  });
});

describe("sdkKeyMaterialOf", () => {
  it("hash là sha256 hex của token, đuôi là displaySuffixLength ký tự cuối", () => {
    const token = issueSdkKeyToken("CLIENT", "staging");
    expect(sdkKeyMaterialOf(token)).toEqual({
      keyHash: createHash("sha256").update(token).digest("hex"),
      keySuffix: token.slice(-SDK_KEY.displaySuffixLength),
    });
  });
});

describe("maskedKeyOf", () => {
  it("tiền tố theo LOẠI khoá + … + đuôi đã lưu", () => {
    expect(maskedKeyOf("SERVER", "a1b2c3")).toBe("udp_sk_…a1b2c3");
    expect(maskedKeyOf("CLIENT", "9f0e1d")).toBe("udp_ck_…9f0e1d");
  });
});

/**
 * [v4.9] Ba mẫu của §3.2 và INV-23.3 phải khớp thứ `issueSdkKeyToken` THẬT SỰ
 * sinh ra.
 *
 * Mẫu plaintext là mẫu đáng lo nhất, và lý do đáng viết ra: mọi phép quét rò rỉ
 * của INV-23.3 (database, log của Service 1, log của Service 2) dùng nó để tìm.
 * Một mẫu không còn khớp token thật thì KHÔNG phép quét nào đỏ — chúng chỉ im
 * lặng ngừng kiểm, và một bất biến về bí mật biến thành một dòng trang trí. Ở đây
 * nó được đối chiếu với token thật theo cả hai chiều: khớp token, và KHÔNG khớp
 * những thứ gần giống mà không phải plaintext (hash trần, đuôi 6 ký tự,
 * `maskedKey`) — vì một mẫu quá rộng sẽ báo động vào chính những cột được phép
 * lưu, và phép quét sẽ bị tắt đi vì "nó luôn đỏ".
 */
describe("mẫu vật liệu và mẫu plaintext (§3.2, INV-23.3)", () => {
  it("khớp hash và đuôi mà `sdkKeyMaterialOf` sinh ra", () => {
    const material = sdkKeyMaterialOf(issueSdkKeyToken("SERVER", "prod"));
    expect(material.keyHash).toMatch(SDK_KEY_HASH_PATTERN);
    expect(material.keySuffix).toMatch(SDK_KEY_SUFFIX_PATTERN);
  });

  it.each(["SERVER", "CLIENT"] as const)(
    "mẫu plaintext khớp token %s thật",
    (keyType) => {
      const token = issueSdkKeyToken(keyType, "QA Việt");
      expect(token).toMatch(SDK_KEY_PLAINTEXT_PATTERN);
      /** Và khớp cả khi token nằm LỌT GIỮA một chuỗi khác — như trong một dòng log */
      expect(`{"msg":"đã phát hành ${token}","ok":true}`).toMatch(
        SDK_KEY_PLAINTEXT_PATTERN,
      );
    },
  );

  it("KHÔNG khớp thứ được phép lưu: hash, đuôi, maskedKey", () => {
    const token = issueSdkKeyToken("SERVER", "prod");
    const { keyHash, keySuffix } = sdkKeyMaterialOf(token);
    expect(keyHash).not.toMatch(SDK_KEY_PLAINTEXT_PATTERN);
    expect(keySuffix).not.toMatch(SDK_KEY_PLAINTEXT_PATTERN);
    expect(maskedKeyOf("SERVER", keySuffix)).not.toMatch(
      SDK_KEY_PLAINTEXT_PATTERN,
    );
    /** Tiền tố đúng nhưng phần ngẫu nhiên thiếu một ký tự ⇒ không khớp */
    expect(`${SDK_KEY.serverPrefix}prod_${"a".repeat(63)}`).not.toMatch(
      SDK_KEY_PLAINTEXT_PATTERN,
    );
  });
});
