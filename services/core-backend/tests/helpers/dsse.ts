import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * [Plan #61 QĐ-16] Ký image như `cosign sign` (bundle Sigstore v0.3, DSSE in-toto, predicate cosign sign v1, annotation
 * được ký) bằng khoá ECDSA P-256 sinh trong test — để test tích hợp ký đúng digest, commit, nhánh và giờ nó cần. Cùng
 * hình với bundle cosign thật trong `fixtures/signing/` (phép "bộ ký của test ra đúng hình cosign" giữ hai bên khớp).
 */

const IN_TOTO = "application/vnd.in-toto+json";

/** PAE của DSSE: thứ thật sự được ký */
const pae = (type: string, payload: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength(type))} ${type} ${String(payload.length)} `,
    ),
    payload,
  ]);

export interface TestSigner {
  publicKey: string;
  /** Bundle cho `digest` (`sha256:…`) với annotation đã cho; `over` sửa statement trước khi ký */
  bundle(
    digest: string,
    annotations: Record<string, string>,
    over?: { predicateType?: string; payloadType?: string },
  ): Record<string, unknown>;
}

export function testSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    publicKey: pem,
    bundle: (digest, annotations, over = {}) =>
      bundleOf(privateKey, publicKey, digest, annotations, over),
  };
}

function bundleOf(
  privateKey: KeyObject,
  publicKey: KeyObject,
  digest: string,
  annotations: Record<string, string>,
  over: { predicateType?: string; payloadType?: string },
): Record<string, unknown> {
  const payloadType = over.payloadType ?? IN_TOTO;
  const payload = Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        { digest: { sha256: digest.replace(/^sha256:/, "") }, annotations },
      ],
      predicateType:
        over.predicateType ?? "https://sigstore.dev/cosign/sign/v1",
      predicate: {},
    }),
  );
  const signature = sign("sha256", pae(payloadType, payload), privateKey);
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      publicKey: { hint: createHash("sha256").update(der).digest("base64") },
    },
    dsseEnvelope: {
      payload: payload.toString("base64"),
      payloadType,
      signatures: [{ sig: signature.toString("base64") }],
    },
  };
}
