import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { createPrismaClient, type PrismaClient } from "@udp/db";
import { redact } from "@udp/http";
import { scanForSecret, stableOwner } from "@udp/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma as s1 } from "../src/core/db.js";
import {
  decryptCredential,
  encryptCredential,
  fingerprintOf,
} from "../src/modules/credential/credential.crypto.js";

/**
 * [v4.10] Quét SENTINEL — plaintext credential không được xuất hiện ở ĐÂU.
 *
 * Bất biến I12 và §12 T3 nói plaintext credential chỉ tồn tại trong RAM của worker, không
 * ghi ra đĩa, không vào log, không vào thông điệp lỗi trả về FE. Cách duy nhất kiểm một
 * câu như thế là chọn một chuỗi canh **không thể xuất hiện tình cờ**, cho nó đi qua toàn
 * bộ đường credential, rồi quét từng kênh ra ngoài.
 *
 * **Chín kênh, dẫn ra từ đường đi thật** — không phải một con số chọn trước. Mỗi kênh là
 * một chỗ mà dữ liệu RỜI khỏi tiến trình hoặc rời khỏi vùng bí mật:
 *
 *  1. Toàn bộ database (mọi bảng, qua `information_schema`) — kể cả bảng thêm sau này.
 *  2. Đối tượng `EncryptedCredential` khi serialize.
 *  3. Thông điệp lỗi giải mã.
 *  4. `redact()` của một lỗi mang bí mật ở `config.headers.Authorization` (4 cấp).
 *  5. `redact()` của một object mang `encryptedPayload` / `encryptedDek`.
 *  6. Giá trị `fingerprint`.
 *  7. `lastError` sau khi redact, GHI xuống database rồi đọc lại.
 *  8. Thông điệp của một `AdapterResult` thất bại.
 *  9. `JSON.stringify` của cả hàng đọc từ database.
 *
 * Kênh 1 và 9 trùng phạm vi một phần, và cả hai đều cần: kênh 1 quét *mọi* bảng nhưng chỉ
 * thấy thứ đã commit; kênh 9 thấy đúng hình dạng mà mã sản phẩm nhận về sau một lần đọc.
 */

const admin: PrismaClient = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_cred_sentinel_admin",
});

const PROJECT = "66666666-6666-4666-8666-666666666666";

/**
 * Chuỗi canh: chữ và số, không dấu, KHÔNG thể xuất hiện tình cờ.
 *
 * Nó cũng là một regex POSIX hợp lệ của chính nó, nên `scanForSecret` dùng trực tiếp —
 * `scanForSecret` nhận biểu thức chính quy, không phải `LIKE`.
 */
const SENTINEL = "canhP12Sentinel7f3a9b2c4d6e8f0a1b3c5d7e9f";

let ownerId = "";
let jobId = "";

beforeAll(async () => {
  const owner = await stableOwner(admin);
  ownerId = owner.id;
  await admin.cloudCredential.deleteMany({ where: { projectId: PROJECT } });
  await admin.provisioningJob.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.project.create({
    data: {
      id: PROJECT,
      ownerId,
      name: "sentinel P12",
      creationMode: "CREATE_NEW",
      languageRuntime: "node20",
      resourceQuota: {},
    },
  });
  const job = await admin.provisioningJob.create({
    data: { projectId: PROJECT, jobType: "PROVISION", payload: {} },
    select: { id: true },
  });
  jobId = job.id;
});

afterAll(async () => {
  await admin.cloudCredential.deleteMany({ where: { projectId: PROJECT } });
  await admin.provisioningJob.deleteMany({ where: { projectId: PROJECT } });
  await admin.project.deleteMany({ where: { id: PROJECT } });
  await admin.$disconnect();
});

describe("chuỗi canh không rời khỏi vùng bí mật", () => {
  it("chín kênh: không kênh nào mang plaintext ra ngoài", async () => {
    const credentialId = randomUUID();
    const identity = { credentialId, projectId: PROJECT, dekVersion: 1 };
    const enc = encryptCredential(Buffer.from(SENTINEL, "utf8"), identity);

    /** Kênh 2 — đối tượng mã hoá khi serialize */
    expect(JSON.stringify(enc)).not.toContain(SENTINEL);

    /** Kênh 6 — fingerprint băm định danh PUBLIC, không băm bí mật */
    const fingerprint = fingerprintOf("arn:aws:iam::1:role/canh");
    expect(fingerprint).not.toContain(SENTINEL);

    await s1.cloudCredential.create({
      data: {
        id: credentialId,
        projectId: PROJECT,
        provider: "AWS",
        region: "ap-southeast-1",
        mode: "BYOC",
        authKind: "AWS_ROLE",
        encryptedPayload: enc.encryptedPayload,
        encryptedDek: enc.encryptedDek,
        kekVersion: enc.kekVersion,
        dekVersion: enc.dekVersion,
        nonce: enc.nonce,
        authTag: enc.authTag,
        fingerprint,
        createdById: ownerId,
      },
    });

    /** Kênh 3 — thông điệp lỗi giải mã (AAD sai ⇒ ném) */
    let decryptMessage = "";
    try {
      decryptCredential(enc, { ...identity, credentialId: randomUUID() });
    } catch (err) {
      decryptMessage =
        err instanceof Error ? `${err.name} ${err.message}` : String(err);
    }
    expect(decryptMessage).not.toBe("");
    expect(decryptMessage).not.toContain(SENTINEL);

    /** Kênh 4 — bí mật ở cấp 4 trong một lỗi SDK */
    const sdkInner = new Error("AWS từ chối");
    (sdkInner as unknown as { config: unknown }).config = {
      headers: { Authorization: `Bearer ${SENTINEL}` },
    };
    const wrapped = new Error("provision thất bại", { cause: sdkInner });
    const redactedError = JSON.stringify(redact(wrapped));
    expect(redactedError).not.toContain(SENTINEL);

    /** Kênh 5 — object mang hai cột ciphertext */
    const redactedRow = JSON.stringify(
      redact({
        encryptedPayload: enc.encryptedPayload,
        encryptedDek: enc.encryptedDek,
        secretAccessKey: SENTINEL,
      }),
    );
    expect(redactedRow).not.toContain(SENTINEL);
    expect(redactedRow).not.toContain(enc.encryptedPayload);

    /** Kênh 8 — thông điệp của một `AdapterResult` thất bại */
    const adapterResult = {
      status: "FAILED" as const,
      message: redact(wrapped) as unknown,
    };
    expect(JSON.stringify(adapterResult)).not.toContain(SENTINEL);

    /** Kênh 7 — `lastError` sau redact, GHI xuống database rồi đọc lại */
    await s1.provisioningJob.update({
      where: { id: jobId },
      data: { lastError: redact(wrapped) as never },
    });
    const job = await s1.provisioningJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { lastError: true },
    });
    expect(JSON.stringify(job.lastError)).not.toContain(SENTINEL);
    /** Và nó vẫn mang phần chẩn đoán — một `{}` thì "không rò" nhưng cũng vô dụng */
    expect(JSON.stringify(job.lastError)).toContain("provision thất bại");

    /** Kênh 9 — cả hàng đọc từ database */
    const row = await s1.cloudCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    expect(JSON.stringify(row)).not.toContain(SENTINEL);

    /** Kênh 1 — TOÀN BỘ database, mọi bảng, đọc tên bảng lúc chạy */
    const hits = await scanForSecret(admin, SENTINEL);
    expect(hits).toEqual([]);
  }, 60_000);

  /**
   * Phép ĐỐI CHỨNG — chuỗi canh phải TÌM ĐƯỢC khi nó thật sự có trong database.
   *
   * Không có phép này, cả phép trên có thể xanh vì `scanForSecret` không quét gì cả (một
   * pattern viết sai, một danh sách bảng rỗng, một lỗi bị nuốt). Một phép quét luôn trả
   * về "không thấy gì" là phép quét tệ nhất: nó cho cảm giác an toàn mà không kiểm gì.
   */
  it("đối chứng: cùng phép quét TÌM RA chuỗi canh khi nó thật sự nằm trong database", async () => {
    await s1.provisioningJob.update({
      where: { id: jobId },
      data: { lastError: { deLamDoiChung: SENTINEL } },
    });
    const hits = await scanForSecret(admin, SENTINEL);
    expect(hits.map((h) => h.table)).toContain("provisioning_jobs");

    await s1.provisioningJob.update({
      where: { id: jobId },
      data: { lastError: {} },
    });
    expect(await scanForSecret(admin, SENTINEL)).toEqual([]);
  }, 60_000);
});
