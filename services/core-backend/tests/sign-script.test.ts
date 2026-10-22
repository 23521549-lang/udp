import { BUILD_TOOLCHAIN, SIGNING_CONFIG_JSON } from "@udp/config";
import { describe, expect, it } from "vitest";
import {
  dockerHostSignLines,
  inClusterSignContainers,
  SIGNATURE_FILE,
} from "../src/modules/adapter-base/packaging/sign-script.js";
import {
  BASE,
  bashCheck,
  HOSTS,
  SIGNED,
  SIGNING_KEYS,
} from "./helpers/build-plans.js";

/**
 * [Plan #61 QĐ-14] Đoạn shell ký image: cú pháp ở mọi ô, ký bundle với signing config KHÔNG dịch vụ (không Rekor công
 * khai), annotation được ký, chữ ký tương thích bằng sign-blob + oras, thông tin đăng nhập KMS ngắn hạn theo cloud.
 */
const VARS = {
  image: "registry.acme.vn/web",
  digest: "$UDP_DIGEST",
  project: "web",
  commit: "$COMMIT",
  ref: "$BRANCH",
  run: "$RUN",
};

describe("sign-script: cú pháp và luật ký tự ở mọi ô", () => {
  for (const [cloud, plan] of Object.entries(SIGNED)) {
    for (const ci of HOSTS) {
      it(`máy có Docker · ${ci} · ${cloud}`, () => {
        const lines = dockerHostSignLines(plan, ci, {
          ...VARS,
          tmp: "/tmp/udp-sign",
        });
        expect(bashCheck(lines.join("\n"))).toBe("");
        expect(lines.join("\n")).not.toContain("\\");
      });
    }
    it(`trong cluster · ${cloud}`, () => {
      const [sign] = inClusterSignContainers(plan, VARS);
      expect(bashCheck(sign!.script.join("\n"))).toBe("");
      expect(sign!.script.join("\n")).not.toContain("\\");
    });
  }

  it("kế hoạch không ký ⇒ không dòng nào, không container nào", () => {
    expect(
      dockerHostSignLines(BASE, "github-actions", { ...VARS, tmp: "/tmp/u" }),
    ).toEqual([]);
    expect(inClusterSignContainers(BASE, VARS)).toEqual([]);
  });
});

describe("sign-script: nội dung", () => {
  const text = dockerHostSignLines(SIGNED.aws, "github-actions", {
    ...VARS,
    tmp: "/tmp/udp-sign",
  }).join("\n");

  it("tải cosign và oras đúng bản ghim, kiểm sha256; signing config không dịch vụ", () => {
    expect(text).toContain(
      `v${BUILD_TOOLCHAIN.cosign.version}/cosign-linux-amd64`,
    );
    expect(text).toContain(BUILD_TOOLCHAIN.cosign.linuxSha256);
    expect(text).toContain(BUILD_TOOLCHAIN.oras.linuxSha256);
    expect(text).toContain(`'${SIGNING_CONFIG_JSON}'`);
  });

  it("ký bundle lên digest, annotation project/commit/nhánh/lượt chạy/thời điểm, xuất UDP_SIGNATURE_B64", () => {
    expect(text).toContain(
      `"$UDP_TMP/cosign" sign --yes --key "${SIGNING_KEYS.aws}" --signing-config "$UDP_TMP/signing-config.json" --bundle "$UDP_TMP/signature.json" -a dev.udp.project=web -a dev.udp.commit=$COMMIT -a dev.udp.ref=$BRANCH -a dev.udp.run=$RUN -a dev.udp.issued-at="$UDP_ISSUED_AT" "registry.acme.vn/web@$UDP_DIGEST"`,
    );
    expect(text).toContain(
      'UDP_SIGNATURE_B64=$(base64 -w 0 < "$UDP_TMP/signature.json")',
    );
    // Không cờ sắp bỏ của cosign v3
    expect(text).not.toMatch(/--tlog-upload|--new-bundle-format|cosign attach/);
  });

  it("chữ ký tương thích: sign-blob trên simple signing, oras đẩy vào tag sha256-<hex>.sig; tắt compat thì không có", () => {
    expect(text).toContain('"$UDP_TMP/cosign" sign-blob --yes');
    expect(text).toContain('"type":"cosign container image signature"');
    expect(text).toContain('"registry.acme.vn/web:sha256-$UDP_DIGEST_HEX.sig"');
    expect(text).toContain(
      "simple-signing.json:application/vnd.dev.cosign.simplesigning.v1+json",
    );
    const plain = dockerHostSignLines(SIGNED.azure, "gitlab-ci", {
      ...VARS,
      tmp: "/tmp/u",
    }).join("\n");
    expect(plain).not.toContain("oras");
    expect(plain).not.toContain("sign-blob");
  });

  it("thông tin đăng nhập KMS theo cloud: web identity của AWS (đúng region của khoá), external_account của GCP, workload identity của Azure", () => {
    expect(text).toContain("AWS_WEB_IDENTITY_TOKEN_FILE=/tmp/udp-sign-oidc");
    expect(text).toContain("AWS_REGION=eu-west-1");
    const gcp = dockerHostSignLines(SIGNED.gcp, "circleci", {
      ...VARS,
      tmp: "/tmp/u",
    }).join("\n");
    expect(gcp).toContain(
      "export GOOGLE_APPLICATION_CREDENTIALS=/tmp/udp-sign-oidc.json",
    );
    expect(gcp).toContain('"credential_source":{"file":"/tmp/udp-sign-oidc"}');
    const azure = dockerHostSignLines(SIGNED.azure, "gitlab-ci", {
      ...VARS,
      tmp: "/tmp/u",
    }).join("\n");
    expect(azure).toContain("AZURE_FEDERATED_TOKEN_FILE=/tmp/udp-sign-oidc");
    // JWT xoá khi xong
    expect(text).toContain("rm -f /tmp/udp-sign-oidc /tmp/udp-sign-oidc.json");
  });

  it("trong cluster: không có image mới ⇒ dừng xanh; token ServiceAccount; ghi chữ ký cho bước báo", () => {
    const [sign] = inClusterSignContainers(SIGNED.gcp, VARS);
    expect(sign).toMatchObject({
      name: "udp-sign",
      image: BUILD_TOOLCHAIN.images.alpine,
      runAsUser: 0,
      env: {},
    });
    const script = sign!.script.join("\n");
    expect(sign!.script[1]).toContain("[ -f /udp/out/image-ref ] || {");
    expect(script).toContain("serviceaccounts/udp-builder/token");
    expect(script).toContain("export DOCKER_CONFIG=/udp-auth");
    expect(script).toContain(`> ${SIGNATURE_FILE}`);
  });
});
