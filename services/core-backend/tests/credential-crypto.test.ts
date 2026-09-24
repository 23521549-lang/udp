import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import {
  aadOf,
  AUTH_TAG_CHARS,
  decryptCredential,
  encryptCredential,
  fingerprintOf,
  NONCE_CHARS,
  rewrapDek,
  sameFingerprint,
  type CredentialIdentity,
} from "../src/modules/credential/credential.crypto.js";
import {
  kekFor,
  UnknownKekVersionError,
} from "../src/modules/credential/kek.js";

/**
 * [v4.10] AC-4 và AC-17 — envelope encryption của credential cloud (§4.3).
 *
 * Phần đắt nhất của bộ này là hai phép ĐỌC LẠI TỪ DATABASE. Mọi tính chất khác kiểm được
 * trong bộ nhớ, nhưng đúng hai tính chất thì không:
 *
 *  1. `CHAR(24)` **đệm dấu cách**. Một hàng ghi bằng nonce mã base64 (16 ký tự) đọc lại
 *     thành 16 ký tự cộng 8 dấu cách, và `Buffer.from(..., "hex")` bỏ qua ký tự lạ thay vì
 *     ném — nên lỗi hiện ra là "không xác thực được", không hề nói gì về dấu cách. Chỉ một
 *     lượt đi về database thật mới thấy được điều đó.
 *  2. `rewrapDek` phải để `encrypted_payload` và `nonce` **không đổi một byte**. So sánh
 *     hai biến trong bộ nhớ chứng minh hàm không trả về chúng; so sánh hai lần đọc từ
 *     database chứng minh không có gì trên đường ghi sửa chúng.
 */

const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_cred_crypto_admin",
});

const PROJECT = "44444444-4444-4444-8444-444444444444";
const SECRET = "arn:aws:iam::123456789012:role/udp-tenant + bi-mat-that";

let ownerId = "";

beforeAll(async () => {
  const owner = await stableOwner(admin);
  ownerId = owner.id;
  await admin.cloudCredential.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.project.create({
    data: {
      id: PROJECT,
      ownerId,
      name: "credential crypto P12",
      creationMode: "CREATE_NEW",
      languageRuntime: "node20",
      resourceQuota: {},
    },
  });
});

afterAll(async () => {
  await admin.cloudCredential.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.$disconnect();
});

/**
 * Mã lỗi của một lời gọi phải NÉM, hay `"KHONG NEM"` nếu nó không ném.
 *
 * Trả về một chuỗi thay vì `null`: bản đầu của bộ này dùng `null`, nên khi một đột biến
 * làm hàm không còn ném, phép kiểm đỏ với "Cannot read properties of null (reading
 * 'code')" — đúng là đỏ, nhưng thông điệp không nói gì về tính chất đang kiểm. Đã thấy
 * đúng hình dạng đó ở đột biến M-P12-1.
 */
function codeOfThrow(fn: () => unknown): string {
  try {
    fn();
    return "KHONG NEM";
  } catch (err) {
    return (err as { code?: string }).code ?? "KHONG CO MA";
  }
}

function identityOf(credentialId: string, dekVersion = 1): CredentialIdentity {
  return { credentialId, projectId: PROJECT, dekVersion };
}

describe("vòng mã hoá — giải mã trong bộ nhớ", () => {
  it("giải mã ra đúng plaintext ban đầu", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET, "utf8"), identityOf(id));
    const back = decryptCredential(enc, identityOf(id));
    expect(back.toString("utf8")).toBe(SECRET);
  });

  it("nonce đúng 24 ký tự HEX, auth_tag đúng 24 ký tự BASE64", () => {
    const enc = encryptCredential(
      Buffer.from(SECRET),
      identityOf(randomUUID()),
    );
    expect(enc.nonce).toHaveLength(NONCE_CHARS);
    expect(enc.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(enc.authTag).toHaveLength(AUTH_TAG_CHARS);
    expect(enc.authTag).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it("nonce sinh MỚI mỗi lần ghi — hai lần mã cùng plaintext ra hai ciphertext", () => {
    const id = randomUUID();
    const a = encryptCredential(Buffer.from(SECRET), identityOf(id));
    const b = encryptCredential(Buffer.from(SECRET), identityOf(id));
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.encryptedPayload).not.toBe(b.encryptedPayload);
  });

  /**
   * Chống HOÁN ĐỔI ciphertext giữa hai hàng — việc chính của AAD.
   *
   * Không có AAD, ciphertext của hàng A dán sang hàng B vẫn xác thực thành công (cùng
   * DEK thì không, nhưng cùng project thì cùng DEK là ca thường), và GCM không phát hiện
   * gì. Phép này dựng đúng hình đó: giữ nguyên mọi cột, chỉ đổi `credentialId` trong AAD.
   */
  it("AAD sai credentialId ⇒ KHÔNG giải mã được", () => {
    const enc = encryptCredential(
      Buffer.from(SECRET),
      identityOf(randomUUID()),
    );
    expect(
      codeOfThrow(() => decryptCredential(enc, identityOf(randomUUID()))),
    ).toBe("CREDENTIAL_DECRYPT_FAILED");
  });

  it("AAD sai projectId ⇒ KHÔNG giải mã được", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id));
    expect(
      codeOfThrow(() =>
        decryptCredential(enc, {
          credentialId: id,
          projectId: "55555555-5555-4555-8555-555555555555",
          dekVersion: 1,
        }),
      ),
    ).toBe("CREDENTIAL_DECRYPT_FAILED");
  });

  /**
   * `dek_version` trong AAD chống PHÁT LẠI một payload cũ sau khi DEK đã xoay.
   *
   * Và nó là lý do AAD **không** dùng `kek_version`: xem chú thích đầu
   * `credential.crypto.ts`. Phép dưới đây là chiều dương của tính chất đó; phép
   * "xoay KEK rồi vẫn đọc được" ở nhóm sau là chiều âm.
   */
  it("AAD sai dek_version ⇒ KHÔNG giải mã được", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id, 1));
    expect(codeOfThrow(() => decryptCredential(enc, identityOf(id, 2)))).toBe(
      "CREDENTIAL_DECRYPT_FAILED",
    );
  });

  it("ciphertext bị sửa một byte ⇒ KHÔNG giải mã được", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id));
    const raw = Buffer.from(enc.encryptedPayload, "base64");
    raw[0] = raw[0] === undefined ? 0 : raw[0] ^ 0xff;
    expect(
      codeOfThrow(() =>
        decryptCredential(
          { ...enc, encryptedPayload: raw.toString("base64") },
          identityOf(id),
        ),
      ),
    ).toBe("CREDENTIAL_DECRYPT_FAILED");
  });

  it("AAD là chuỗi ba phần theo đúng thứ tự credentialId|projectId|dek_version", () => {
    const id = "aaaa";
    expect(
      aadOf({ credentialId: id, projectId: "bbbb", dekVersion: 3 }).toString(),
    ).toBe("aaaa|bbbb|3");
  });

  /**
   * Thông điệp lỗi KHÔNG mang một byte ciphertext nào.
   *
   * Lỗi giải mã đi vào log và có thể đi tới Portal. Một thông điệp mang ciphertext là một
   * kênh rò: nó không mở được khoá, nhưng nó cho người nhặt log một bản sao để thử offline.
   */
  it("thông điệp lỗi không chứa ciphertext, nonce hay tag", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id));
    try {
      decryptCredential(enc, identityOf(randomUUID()));
      expect.unreachable("phải ném");
    } catch (err) {
      const text =
        err instanceof Error ? `${err.name} ${err.message}` : String(err);
      expect(text).not.toContain(enc.encryptedPayload);
      expect(text).not.toContain(enc.nonce);
      expect(text).not.toContain(enc.authTag);
      expect(text).not.toContain(enc.encryptedDek);
    }
  });
});

describe("xoay KEK — bọc lại DEK, không chạm payload", () => {
  it("rewrapDek trả về ĐÚNG hai cột phải ghi", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id));
    const rewrapped = rewrapDek(enc, enc.kekVersion);
    expect(Object.keys(rewrapped).sort()).toEqual([
      "encryptedDek",
      "kekVersion",
    ]);
  });

  /**
   * Bọc lại bằng CÙNG version vẫn phải ra một blob KHÁC.
   *
   * Blob DEK mang nonce riêng bên trong, nên bọc lại luôn sinh nonce mới. Nếu hai blob
   * giống nhau thì hàm đang dùng lại nonce cho cùng một khoá — tức tái sử dụng cặp
   * (khoá, nonce) của GCM, lỗi mật mã nặng nhất trong cả tệp này.
   */
  it("bọc lại luôn sinh blob mới, không tái dùng nonce của GCM", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id));
    const a = rewrapDek(enc, enc.kekVersion);
    const b = rewrapDek(enc, enc.kekVersion);
    expect(a.encryptedDek).not.toBe(b.encryptedDek);
    expect(a.encryptedDek).not.toBe(enc.encryptedDek);
  });

  it("sau khi bọc lại, payload vẫn giải mã được bằng cùng AAD", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id));
    const rewrapped = rewrapDek(enc, enc.kekVersion);
    const back = decryptCredential({ ...enc, ...rewrapped }, identityOf(id));
    expect(back.toString("utf8")).toBe(SECRET);
  });

  it("bọc bằng KEK version không có ⇒ ném UnknownKekVersionError", () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET), identityOf(id));
    expect(() => rewrapDek(enc, 99)).toThrow(UnknownKekVersionError);
  });

  it("KEK của mọi version khai báo giải ra đúng 32 byte", () => {
    for (let v = 1; v <= env.UDP_KEK_VERSION; v += 1) {
      expect(kekFor(v)).toHaveLength(32);
    }
  });
});

describe("fingerprint — so credential mà không mở envelope", () => {
  it("băm định danh PUBLIC, và cùng định danh ra cùng băm", () => {
    const arn = "arn:aws:iam::123456789012:role/udp-tenant";
    expect(fingerprintOf(arn)).toBe(fingerprintOf(arn));
    expect(fingerprintOf(arn)).toHaveLength(64);
    expect(sameFingerprint(fingerprintOf(arn), fingerprintOf(arn))).toBe(true);
  });

  it("định danh khác ⇒ băm khác, và sameFingerprint trả false", () => {
    const a = fingerprintOf("arn:aws:iam::1:role/a");
    const b = fingerprintOf("arn:aws:iam::1:role/b");
    expect(a).not.toBe(b);
    expect(sameFingerprint(a, b)).toBe(false);
  });

  it("độ dài khác nhau trả false mà KHÔNG ném", () => {
    expect(sameFingerprint(fingerprintOf("a"), "ngan")).toBe(false);
  });
});

/**
 * Hai phép ĐỌC LẠI TỪ DATABASE — xem ghi chú đầu tệp về vì sao chúng không thay được
 * bằng phép trong bộ nhớ.
 */
describe("đọc lại từ database — CHAR(24) và bất biến của xoay KEK", () => {
  it("nonce và auth_tag đọc lại KHÔNG có dấu cách đệm, và giải mã được", async () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET, "utf8"), identityOf(id));

    await s1.cloudCredential.create({
      data: {
        id,
        projectId: PROJECT,
        provider: "AWS",
        mode: "BYOC",
        authKind: "AWS_ROLE",
        encryptedPayload: enc.encryptedPayload,
        encryptedDek: enc.encryptedDek,
        kekVersion: enc.kekVersion,
        dekVersion: enc.dekVersion,
        nonce: enc.nonce,
        authTag: enc.authTag,
        fingerprint: fingerprintOf("arn:aws:iam::1:role/a"),
        createdById: ownerId,
      },
    });

    const row = await s1.cloudCredential.findUniqueOrThrow({
      where: { id },
      select: {
        encryptedPayload: true,
        encryptedDek: true,
        kekVersion: true,
        dekVersion: true,
        nonce: true,
        authTag: true,
      },
    });

    /** Không dấu cách: đúng 24 ký tự có nghĩa, không phải 24 ký tự gồm đệm */
    expect(row.nonce).toBe(enc.nonce);
    expect(row.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(row.authTag).toBe(enc.authTag);
    expect(row.authTag.trimEnd()).toHaveLength(AUTH_TAG_CHARS);

    const back = decryptCredential(row, identityOf(id));
    expect(back.toString("utf8")).toBe(SECRET);
  });

  /**
   * AC-17: xoay KEK rồi hàng CŨ vẫn đọc được, và `encrypted_payload` + `nonce` không
   * đổi một byte.
   *
   * Đây là phép cưỡng chế bản sửa AAD của v4.10. Nếu AAD còn chứa `kek_version` thì phép
   * này đỏ ở dòng cuối: payload cũ không xác thực được nữa sau khi cột đó tăng.
   */
  it("xoay KEK: encrypted_payload và nonce không đổi, hàng cũ vẫn đọc được", async () => {
    const id = randomUUID();
    const enc = encryptCredential(Buffer.from(SECRET, "utf8"), identityOf(id));
    await s1.cloudCredential.create({
      data: {
        id,
        projectId: PROJECT,
        provider: "AWS",
        mode: "BYOC",
        authKind: "AWS_ROLE",
        encryptedPayload: enc.encryptedPayload,
        encryptedDek: enc.encryptedDek,
        kekVersion: enc.kekVersion,
        dekVersion: enc.dekVersion,
        nonce: enc.nonce,
        authTag: enc.authTag,
        fingerprint: fingerprintOf("arn:aws:iam::1:role/b"),
        createdById: ownerId,
      },
    });
    const before = await s1.cloudCredential.findUniqueOrThrow({
      where: { id },
      select: {
        encryptedPayload: true,
        nonce: true,
        authTag: true,
        encryptedDek: true,
      },
    });

    /** Job `rotate-kek` làm đúng hai việc này, không nhiều hơn */
    const rewrapped = rewrapDek(
      { encryptedDek: before.encryptedDek, kekVersion: enc.kekVersion },
      enc.kekVersion,
    );
    await s1.cloudCredential.update({
      where: { id },
      data: {
        encryptedDek: rewrapped.encryptedDek,
        kekVersion: rewrapped.kekVersion,
      },
    });

    const after = await s1.cloudCredential.findUniqueOrThrow({
      where: { id },
      select: {
        encryptedPayload: true,
        encryptedDek: true,
        kekVersion: true,
        dekVersion: true,
        nonce: true,
        authTag: true,
      },
    });

    expect(after.encryptedPayload).toBe(before.encryptedPayload);
    expect(after.nonce).toBe(before.nonce);
    expect(after.authTag).toBe(before.authTag);
    expect(after.encryptedDek).not.toBe(before.encryptedDek);

    const back = decryptCredential(after, identityOf(id));
    expect(back.toString("utf8")).toBe(SECRET);
  });
});
