import { createPublicKey } from "node:crypto";
import { bundleFromJSON, type Bundle } from "@sigstore/bundle";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import type { SignatureRejection } from "@udp/shared-types";
import { keyIdOf } from "../packaging/signing-keys.js";

/**
 * [Plan #61 QĐ-16] Cổng deploy của Service 1 — kiểm chữ ký image mà pipeline gửi kèm webhook, bằng khoá CÔNG KHAI đã lưu
 * ở cài đặt build. Không gọi KMS (tránh đường lỗi sigstore#2409), không cần Rekor, không cần quyền đọc registry: bundle
 * đi trong thân webhook. Thuần (không I/O) nên test được bằng bundle thật do cosign ký.
 */

export interface GateKey {
  id?: string | undefined;
  publicKey: string;
}

export interface SignatureExpectation {
  /** `repo:commit@sha256:…` mà webhook muốn deploy */
  imageRef: string;
  project: string;
  commit: string;
  /** Nhánh hợp lệ của environment đích — `expectedBranchOf` */
  branch: string;
  /** `issued-at` của lần deploy thành công hiện hành ở environment — chữ ký mới không được cũ hơn */
  notBefore: Date | null;
  now: Date;
}

export type SignatureCheck =
  | { ok: true; keyId: string; issuedAt: string }
  | {
      ok: false;
      code: Exclude<SignatureRejection, "SIGNATURE_MISSING">;
      detail: string;
    };

const COSIGN_SIGN_PREDICATE = "https://sigstore.dev/cosign/sign/v1";
const IN_TOTO = "application/vnd.in-toto+json";
/** Chữ ký quá 24 giờ không mở được lần deploy nào — bundle lộ ra ngoài không dùng lại được mãi */
const MAX_AGE_MS = 24 * 3_600_000;
/** Đồng hồ của máy chạy CI lệch tương lai tối đa 5 phút */
const MAX_SKEW_MS = 5 * 60_000;

/** Trust root rỗng: khoá công khai là nguồn tin duy nhất, không chứng chỉ, không transparency log */
const NO_ROOT = {
  mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
  tlogs: [],
  certificateAuthorities: [],
  ctlogs: [],
  timestampAuthorities: [],
};

/** Nhánh mà image của environment phải được build từ đó — cùng luật với template: `main` ⇒ production */
export const expectedBranchOf = (environment: {
  name: string;
  isProduction: boolean;
}): string => (environment.isProduction ? "main" : environment.name);

/** Image thuộc repository của project (`<registryRef>/<slug>`), theo tag hay digest */
export const isOwnImage = (imageRef: string, repository: string): boolean =>
  imageRef.startsWith(`${repository}:`) ||
  imageRef.startsWith(`${repository}@`);

/** Khoá nào ký bundle này — `null` khi không khoá nào khớp (nội dung bị sửa, khoá lạ) */
function signerOf(bundle: Bundle, keys: readonly GateKey[]): GateKey | null {
  const entity = toSignedEntity(bundle);
  for (const key of keys) {
    const material = toTrustMaterial(NO_ROOT, () => ({
      publicKey: createPublicKey(key.publicKey),
      validFor: () => true,
    }));
    const verifier = new Verifier(material, {
      tlogThreshold: 0,
      ctlogThreshold: 0,
      timestampThreshold: 0,
    });
    try {
      verifier.verify(entity);
      return key;
    } catch {
      // khoá kế — xoay khoá: mọi khoá trong danh sách đều được chấp nhận
    }
  }
  return null;
}

interface Statement {
  predicateType?: unknown;
  subject?: {
    digest?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }[];
}

/** Statement in-toto trong DSSE — `null` khi payload không phải JSON */
function statementOf(payload: Buffer): Statement | null {
  try {
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function verifyDeploySignature(
  bundleJson: unknown,
  keys: readonly GateKey[],
  expect: SignatureExpectation,
): SignatureCheck {
  let bundle: Bundle;
  try {
    bundle = bundleFromJSON(bundleJson);
  } catch {
    return { ok: false, code: "SIGNATURE_INVALID", detail: "bundle sai hình" };
  }
  if (bundle.content.$case !== "dsseEnvelope") {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      detail: "không phải chữ ký image của cosign",
    };
  }
  const signer = signerOf(bundle, keys);
  if (signer === null) {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      detail: "không khoá nào của project ký bundle này",
    };
  }
  const mismatch = (what: string): SignatureCheck => ({
    ok: false,
    code: "SIGNATURE_MISMATCH",
    detail: what,
  });
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== IN_TOTO) return mismatch("payloadType");
  const statement = statementOf(envelope.payload);
  if (statement?.predicateType !== COSIGN_SIGN_PREDICATE) {
    return mismatch("predicateType");
  }
  const subject = statement.subject?.[0];
  const at = expect.imageRef.indexOf("@sha256:");
  const digest = at < 0 ? null : expect.imageRef.slice(at + "@sha256:".length);
  if (
    digest === null ||
    statement.subject?.length !== 1 ||
    subject?.digest?.sha256 !== digest
  ) {
    return mismatch("digest");
  }
  const notes = subject.annotations ?? {};
  if (notes["dev.udp.project"] !== expect.project) return mismatch("project");
  if (notes["dev.udp.commit"] !== expect.commit) return mismatch("commit");
  if (notes["dev.udp.ref"] !== expect.branch) return mismatch("nhánh");
  const issuedAt = notes["dev.udp.issued-at"];
  if (typeof issuedAt !== "string") return mismatch("issued-at");
  const issued = Date.parse(issuedAt);
  if (Number.isNaN(issued)) return mismatch("issued-at");
  const now = expect.now.getTime();
  if (issued > now + MAX_SKEW_MS || issued < now - MAX_AGE_MS) {
    return {
      ok: false,
      code: "SIGNATURE_STALE",
      detail: "ký ngoài cửa sổ 24 giờ",
    };
  }
  if (expect.notBefore !== null && issued < expect.notBefore.getTime()) {
    return {
      ok: false,
      code: "SIGNATURE_STALE",
      detail: "cũ hơn bản đang chạy",
    };
  }
  return {
    ok: true,
    keyId: signer.id ?? keyIdOf(signer.publicKey),
    issuedAt,
  };
}
