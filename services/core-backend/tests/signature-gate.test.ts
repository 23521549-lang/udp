import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expectedBranchOf,
  isOwnImage,
  verifyDeploySignature,
  type SignatureExpectation,
} from "../src/modules/cicd/signature-gate.js";
import { keyIdOf } from "../src/modules/packaging/signing-keys.js";
import { testSigner } from "./helpers/dsse.js";

/**
 * [Plan #61 QĐ-16] Cổng deploy kiểm chữ ký image. Nửa đầu dùng bundle THẬT do cosign 3.1.3 ký (`fixtures/signing/`, chỉ
 * khoá công khai và bundle — khoá bí mật không nằm trong repo): cổng của Service 1 hiểu đúng thứ cosign sinh. Nửa sau dùng
 * bộ ký của test (cùng hình, phép đầu của nửa sau giữ điều đó) cho các ca cosign không tự sinh được.
 */

const FIXTURES = join(import.meta.dirname, "fixtures/signing");
const COSIGN_PUB = readFileSync(join(FIXTURES, "cosign.pub"), "utf8");
const OTHER_PUB = readFileSync(join(FIXTURES, "other.pub"), "utf8");
const COSIGN_BUNDLE: unknown = JSON.parse(
  readFileSync(join(FIXTURES, "cosign.bundle.json"), "utf8"),
);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const DIGEST =
  "sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6";
/** Bundle cosign ký lúc này (annotation `dev.udp.issued-at`) */
const SIGNED_AT = new Date("2026-10-01T18:44:03Z");

const expectation = (
  over: Partial<SignatureExpectation> = {},
): SignatureExpectation => ({
  imageRef: `docker.io/library/alpine:${COMMIT}@${DIGEST}`,
  project: "web",
  commit: COMMIT,
  branch: "main",
  notBefore: null,
  now: new Date(SIGNED_AT.getTime() + 60_000),
  ...over,
});

/** Khoá đang ký đứng SAU một khoá khác: xoay khoá không gián đoạn */
const KEYS = [
  { id: keyIdOf(OTHER_PUB), publicKey: OTHER_PUB },
  { id: keyIdOf(COSIGN_PUB), publicKey: COSIGN_PUB },
];

describe("cổng deploy với bundle cosign thật", () => {
  it("hợp lệ ⇒ khoá nào ký và lúc nào ký", () => {
    expect(verifyDeploySignature(COSIGN_BUNDLE, KEYS, expectation())).toEqual({
      ok: true,
      keyId: keyIdOf(COSIGN_PUB),
      issuedAt: "2026-10-01T18:44:03Z",
    });
  });

  it("khoá lạ, bundle sai hình, payload bị sửa ⇒ SIGNATURE_INVALID", () => {
    const other = [{ id: keyIdOf(OTHER_PUB), publicKey: OTHER_PUB }];
    expect(
      verifyDeploySignature(COSIGN_BUNDLE, other, expectation()),
    ).toMatchObject({
      ok: false,
      code: "SIGNATURE_INVALID",
    });
    expect(
      verifyDeploySignature({ foo: 1 }, KEYS, expectation()),
    ).toMatchObject({
      ok: false,
      code: "SIGNATURE_INVALID",
    });
    const bundle = structuredClone(COSIGN_BUNDLE) as {
      dsseEnvelope: { payload: string };
    };
    const statement = Buffer.from(bundle.dsseEnvelope.payload, "base64")
      .toString("utf8")
      .replace('"dev.udp.ref":"main"', '"dev.udp.ref":"evil"');
    bundle.dsseEnvelope.payload = Buffer.from(statement).toString("base64");
    expect(verifyDeploySignature(bundle, KEYS, expectation())).toMatchObject({
      ok: false,
      code: "SIGNATURE_INVALID",
    });
  });

  it("digest, project, commit, nhánh khác ⇒ SIGNATURE_MISMATCH; image không digest cũng vậy", () => {
    for (const over of [
      {
        imageRef: `docker.io/library/alpine:${COMMIT}@sha256:${"0".repeat(64)}`,
      },
      { imageRef: `docker.io/library/alpine:${COMMIT}` },
      { project: "api" },
      { commit: "89abcdef0123456789abcdef0123456789abcdef" },
      { branch: "staging" },
    ]) {
      expect(
        verifyDeploySignature(COSIGN_BUNDLE, KEYS, expectation(over)),
      ).toMatchObject({
        ok: false,
        code: "SIGNATURE_MISMATCH",
      });
    }
  });

  it("quá 24 giờ, ký ở tương lai quá 5 phút, cũ hơn bản đang chạy ⇒ SIGNATURE_STALE", () => {
    const at = SIGNED_AT.getTime();
    for (const over of [
      { now: new Date(at + 24 * 3_600_000 + 1000) },
      { now: new Date(at - 6 * 60_000) },
      { notBefore: new Date(at + 1000) },
    ]) {
      expect(
        verifyDeploySignature(COSIGN_BUNDLE, KEYS, expectation(over)),
      ).toMatchObject({
        ok: false,
        code: "SIGNATURE_STALE",
      });
    }
    // Lệch tương lai trong 5 phút và cùng giây với bản đang chạy vẫn hợp lệ
    expect(
      verifyDeploySignature(
        COSIGN_BUNDLE,
        KEYS,
        expectation({ now: new Date(at - 4 * 60_000), notBefore: SIGNED_AT }),
      ).ok,
    ).toBe(true);
  });
});

describe("cổng deploy với bộ ký của test", () => {
  const signer = testSigner();
  const keys = [{ publicKey: signer.publicKey }];
  const now = new Date();
  const notes = {
    "dev.udp.project": "web",
    "dev.udp.commit": COMMIT,
    "dev.udp.ref": "main",
    "dev.udp.run": "run-1",
    "dev.udp.issued-at": now.toISOString().replace(/\.\d+Z$/, "Z"),
  };
  const expect2 = expectation({ now });

  it("bộ ký của test ra đúng hình cosign: cùng khoá, cùng gợi ý khoá (SHA-256 của DER, base64)", () => {
    const hint = (
      COSIGN_BUNDLE as { verificationMaterial: { publicKey: { hint: string } } }
    ).verificationMaterial.publicKey.hint;
    const der = createPublicKey(COSIGN_PUB).export({
      type: "spki",
      format: "der",
    });
    expect(createHash("sha256").update(der).digest("base64")).toBe(hint);
    const ours = signer.bundle(DIGEST, notes);
    expect(Object.keys(ours).sort()).toEqual(
      Object.keys(COSIGN_BUNDLE as object).sort(),
    );
    // Khoá không mang `id` (bản lưu cũ) ⇒ cổng tự tính dấu vân tay
    expect(verifyDeploySignature(ours, keys, expect2)).toEqual({
      ok: true,
      keyId: keyIdOf(signer.publicKey),
      issuedAt: notes["dev.udp.issued-at"],
    });
  });

  it("không phải in-toto, không phải predicate của cosign sign, thiếu issued-at ⇒ SIGNATURE_MISMATCH", () => {
    for (const bundle of [
      signer.bundle(DIGEST, notes, { payloadType: "application/json" }),
      signer.bundle(DIGEST, notes, {
        predicateType: "https://slsa.dev/provenance/v1",
      }),
      signer.bundle(DIGEST, { ...notes, "dev.udp.issued-at": "hôm qua" }),
    ]) {
      expect(verifyDeploySignature(bundle, keys, expect2)).toMatchObject({
        ok: false,
        code: "SIGNATURE_MISMATCH",
      });
    }
  });
});

describe("luật đi kèm cổng", () => {
  it("nhánh của environment: production ⇒ main, khác ⇒ cùng tên", () => {
    expect(expectedBranchOf({ name: "prod", isProduction: true })).toBe("main");
    expect(expectedBranchOf({ name: "staging", isProduction: false })).toBe(
      "staging",
    );
  });

  it("image của project: đúng repository theo tag hay digest; tiền tố trùng tên không lọt", () => {
    const repo = "ghcr.io/acme/web";
    expect(isOwnImage(`${repo}:abc@${DIGEST}`, repo)).toBe(true);
    expect(isOwnImage(`${repo}@${DIGEST}`, repo)).toBe(true);
    expect(isOwnImage(`${repo}-evil:abc`, repo)).toBe(false);
    expect(isOwnImage(`${repo}/sub:abc`, repo)).toBe(false);
    expect(isOwnImage(`docker.io/evil/web:abc`, repo)).toBe(false);
  });
});
