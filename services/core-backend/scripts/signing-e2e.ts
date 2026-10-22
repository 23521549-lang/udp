import { readFileSync } from "node:fs";
import {
  signLines,
  signToolLines,
} from "../src/modules/adapter-base/packaging/sign-script.js";
import { verifyDeploySignature } from "../src/modules/cicd/signature-gate.js";

/**
 * [Plan #61 QĐ-14, QĐ-16] Job CI `signing-e2e`: ký THẬT bằng đúng đoạn shell mà pipeline của UDP sinh, rồi kiểm bằng
 * chính hàm của cổng deploy. Khoá tệp của cosign thay cho URI KMS (cùng lệnh, cùng cờ — khác mỗi giá trị `--key`).
 *
 *   tsx scripts/signing-e2e.ts tools                      # tải cosign, oras (kiểm sha256), ghi signing config
 *   tsx scripts/signing-e2e.ts sign                       # ký "$UDP_IMAGE@$UDP_DIGEST" bằng "$UDP_KEY"
 *   tsx scripts/signing-e2e.ts verify <bundle> <khoá công khai> <imageRef> <commit> <ok|MÃ>
 *
 * `verify` thoát 0 khi kết quả của cổng ĐÚNG như mong đợi (`ok`, hay mã từ chối).
 */

const [mode, ...args] = process.argv.slice(2);

switch (mode) {
  case "tools":
    process.stdout.write([...signToolLines(true), ""].join("\n"));
    break;
  case "sign":
    process.stdout.write(
      [
        ...signLines("$UDP_KEY", true, {
          image: "$UDP_IMAGE",
          digest: "$UDP_DIGEST",
          project: "e2e",
          commit: "$UDP_COMMIT",
          ref: "main",
          run: "$UDP_RUN",
        }),
        'printf \'%s\' "$UDP_SIGNATURE_B64" > "$UDP_TMP/signature.b64"',
        "",
      ].join("\n"),
    );
    break;
  case "verify": {
    const [bundle, publicKey, imageRef, commit, expected] = args;
    if (
      bundle === undefined ||
      publicKey === undefined ||
      imageRef === undefined ||
      commit === undefined ||
      expected === undefined
    ) {
      throw new Error(
        "verify <bundle> <khoá công khai> <imageRef> <commit> <ok|MÃ>",
      );
    }
    const result = verifyDeploySignature(
      JSON.parse(readFileSync(bundle, "utf8")),
      [{ publicKey: readFileSync(publicKey, "utf8") }],
      {
        imageRef,
        project: "e2e",
        commit,
        branch: "main",
        notBefore: null,
        now: new Date(),
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const outcome = result.ok ? "ok" : result.code;
    if (outcome !== expected) {
      process.stderr.write(
        `cổng deploy trả ${outcome}, mong đợi ${expected}\n`,
      );
      process.exit(1);
    }
    break;
  }
  default:
    throw new Error("chế độ: tools | sign | verify");
}
