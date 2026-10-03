import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { writeResult } from "@udp/experiments";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { imageValidatingPolicy } from "../src/modules/policy-adapter/kyverno/image-policy.js";

/**
 * **kyverno-crd** [Plan #61 61d-3b] — `ImageValidatingPolicy` mà UDP sinh ra có hợp lệ theo CRD THẬT của Kyverno
 * 1.19.1 hay không.
 *
 *   pnpm --filter @udp/core-backend measure:kyverno-crd [--note "…"]
 *
 * **Vì sao phép đo này tồn tại.** Plan nói E2E trên kind + Kyverno là thứ duy nhất bắt được CT-1 và CT-2. Đúng về
 * lý, nhưng máy của dự án (7,7 GiB RAM) không chạy nổi kind + 6 image của UDP + Kyverno + một registry cục bộ, nên
 * một lượt E2E viết mà không chạy được là một lời khai không có bằng chứng. Phép đo này lấy phần bằng chứng **lấy
 * được mà không cần cụm**: tải chính file CRD của tag `v1.19.1`, dựng bộ kiểm JSON Schema từ `openAPIV3Schema` của
 * version LƯU TRỮ, rồi kiểm policy sinh từ mã sản phẩm. Nó bắt mọi lỗi loại "tên trường sai", "giá trị ngoài enum",
 * "trường bắt buộc vắng", "trường đặt sai nhánh" — đúng họ lỗi mà ba vòng QA của đợt này tìm ra.
 *
 * Nó **không** chứng minh được hành vi lúc chạy (chữ ký có được xác minh thật không, Kyverno có kéo được chữ ký từ
 * registry riêng tư không). Phần đó nằm ở món nợ có tên `kyverno-admission-real`.
 *
 * Cần mạng (raw.githubusercontent.com). Không database, không cụm.
 */

const { values } = parseArgs({ options: { note: { type: "string" } } });

const TAG = "v1.19.1";
const CRD_URL =
  `https://raw.githubusercontent.com/kyverno/kyverno/${TAG}` +
  "/config/crds/policies.kyverno.io/policies.kyverno.io_imagevalidatingpolicies.yaml";

/** Version mà UDP ghi vào policy — phải là version LƯU TRỮ của CRD, xem `image-policy.ts` */
const WANT_VERSION = "v1beta1";

interface CrdVersion {
  name: string;
  served?: boolean;
  storage?: boolean;
  deprecated?: boolean;
  schema?: { openAPIV3Schema?: Record<string, unknown> };
}

/**
 * CRD của Kubernetes dùng phương ngữ riêng: `x-kubernetes-*` không phải từ khoá JSON Schema, và nhánh
 * `metadata` chỉ khai `type: object`. Bỏ các khoá `x-kubernetes-*` để Ajv không từ chối chính schema.
 */
function stripKubernetesKeywords(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripKubernetesKeywords);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("x-kubernetes-")) continue;
    out[key] = stripKubernetesKeywords(value);
  }
  return out;
}

const PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEa8Vz1pGZ1kEXAMPLEkEXAMPLEkEX",
  "AMPLEkEXAMPLEkEXAMPLEkEXAMPLEkEXAMPLEkEXAMPLEkEXAMPLEkEXAMPLE==",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");

/** Một ca đo: mô tả, và policy sinh từ mã SẢN PHẨM (không viết lại hình dạng ở đây) */
const CASES = [
  {
    name: "ghcr, một khoá",
    signed: {
      repository: "ghcr.io/acme/web",
      publicKeys: [PUBLIC_KEY],
      registryKind: "github-token" as const,
    },
  },
  {
    name: "ECR, hai khoá (xoay khoá)",
    signed: {
      repository: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/acme/web",
      publicKeys: [PUBLIC_KEY, PUBLIC_KEY.replace("a8Vz", "b8Vz")],
      registryKind: "aws-ecr" as const,
    },
  },
  {
    name: "Harbor riêng tư (pushAuth basic), cổng khác 443",
    signed: {
      repository: "registry.acme.vn:8443/doi-web/api",
      publicKeys: [PUBLIC_KEY],
      registryKind: "basic" as const,
    },
  },
];

async function main(): Promise<void> {
  const response = await fetch(CRD_URL);
  if (!response.ok) {
    throw new Error(`tải CRD thất bại: HTTP ${String(response.status)}`);
  }
  const text = await response.text();
  const crdSha256 = createHash("sha256").update(text).digest("hex");

  const crd = parse(text) as { spec: { versions: CrdVersion[] } };
  const versions = crd.spec.versions.map((v) => ({
    name: v.name,
    served: v.served === true,
    storage: v.storage === true,
    deprecated: v.deprecated === true,
  }));
  const storage = versions.find((v) => v.storage)?.name;
  const target = crd.spec.versions.find((v) => v.name === WANT_VERSION);
  const schema = target?.schema?.openAPIV3Schema;
  if (schema === undefined) {
    throw new Error(`CRD không có version ${WANT_VERSION}`);
  }

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  /**
   * `int32`/`int64`/`date-time` là format của OpenAPI, không phải của JSON Schema. Khai chúng thay vì để Ajv bỏ
   * qua: bỏ qua nghĩa là `timeoutSeconds` không được kiểm biên, và ở đây nó là một con số UDP tự chọn.
   */
  ajv.addFormat("int32", {
    type: "number",
    validate: (n: number) => Number.isInteger(n) && Math.abs(n) <= 2147483647,
  });
  ajv.addFormat("int64", { type: "number", validate: Number.isInteger });
  ajv.addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)));
  const validate = ajv.compile(stripKubernetesKeywords(schema) as object);

  const results = CASES.map((c) => {
    const policy = imageValidatingPolicy(c.signed);
    const valid = validate(policy);
    return {
      case: c.name,
      valid,
      errors: (validate.errors ?? []).map((e: ErrorObject) =>
        `${e.instancePath} ${e.message ?? ""}`.trim(),
      ),
    };
  });

  /**
   * Một phép KIỂM NGƯỢC: nếu bộ kiểm không từ chối được một policy sai, thì ba ca xanh ở trên không chứng minh gì.
   * Ca sai dùng đúng một lỗi của họ "giá trị ngoài enum" — `validationActions: ["Allow"]` (enum chỉ có
   * Deny/Audit/Warn).
   */
  const first = CASES[0];
  if (first === undefined) throw new Error("không có ca đo nào");
  const base = imageValidatingPolicy(first.signed) as {
    spec: Record<string, unknown>;
  };
  const broken = {
    ...base,
    spec: { ...base.spec, validationActions: ["Allow"] },
  };
  const brokenRejected = !validate(broken);

  const file = writeResult(
    "kyverno-crd",
    "máy dev → raw.githubusercontent.com (tải CRD), kiểm schema in-process",
    {
      tag: TAG,
      crdUrl: CRD_URL,
      crdSha256,
      crdBytes: text.length,
      versions,
      storageVersion: storage,
      policyApiVersion: `policies.kyverno.io/${WANT_VERSION}`,
      /** Policy của UDP phải ghi đúng version lưu trữ — `v1alpha1` của CRD này đã deprecated */
      writesStorageVersion: storage === WANT_VERSION,
      cases: results,
      allValid: results.every((r) => r.valid),
      brokenRejected,
    },
    values.note,
  );

  const failed = results.filter((r) => !r.valid);
  console.log(
    `CRD ${TAG} (${String(text.length)} B, sha256 ${crdSha256.slice(0, 12)}…); version lưu trữ: ${String(storage)}`,
  );
  for (const r of results) {
    console.log(`  ${r.valid ? "ĐẠT" : "SAI"}  ${r.case}`);
    for (const e of r.errors) console.log(`        ${e}`);
  }
  console.log(
    `kiểm ngược (policy sai bị từ chối): ${brokenRejected ? "ĐẠT" : "KHÔNG ĐẠT"}`,
  );
  console.log(file);
  if (failed.length > 0 || !brokenRejected || storage !== WANT_VERSION) {
    process.exitCode = 1;
  }
}

await main();
