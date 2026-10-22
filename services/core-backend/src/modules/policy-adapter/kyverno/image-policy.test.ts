import type { SignedImages } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  ImagePolicyError,
  IVP_API_VERSION,
  IVP_NAME,
  imageValidatingPolicy,
} from "./image-policy.js";

/**
 * [Plan #61 61d-3b] `ImageValidatingPolicy` sinh ra phải ĐÚNG TỪNG TRƯỜNG.
 *
 * Vì sao một phép khẳng định `toEqual` trên **toàn bộ** object chứ không vài phép kiểm lẻ: ba vòng QA của đợt này
 * tìm ra bảy lỗi, và cả bảy đều là "một trường vắng" hay "một trường mang giá trị mặc định của nhà phát hành" —
 * đúng loại lỗi mà `expect(policy.spec.validationActions).toEqual(["Audit"])` không bao giờ thấy. Khẳng định cả
 * object nghĩa là thêm hay bớt một trường cũng phải đi qua ô test này.
 *
 * Mọi hình dạng ở đây đối chiếu CRD thật của Kyverno v1.19.1 và bộ conformance của chính Kyverno
 * (`test/conformance/chainsaw/image-validating-policies/`) — xem phép đo `kyverno-crd` trong `docs/measurements`.
 */

const KEY_A = `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEa\n-----END PUBLIC KEY-----\n`;
const KEY_B = `-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEb\n-----END PUBLIC KEY-----\n`;

const signedWith = (over: Partial<SignedImages> = {}): SignedImages => ({
  repository: "ghcr.io/acme/web",
  publicKeys: [KEY_A],
  registryKind: "github-token",
  ...over,
});

const verifyExpression = (list: string, attestors: string): string =>
  `images.${list}.map(image, verifyImageSignatures(image, ${attestors})).all(e, e > 0)`;

describe("ImageValidatingPolicy của một project", () => {
  it("hình dạng ĐẦY ĐỦ — một khoá, registry GitHub", () => {
    expect(imageValidatingPolicy(signedWith())).toEqual({
      apiVersion: "policies.kyverno.io/v1beta1",
      kind: "ImageValidatingPolicy",
      metadata: {
        name: "udp-require-signed-images",
        labels: { "app.kubernetes.io/managed-by": "udp" },
      },
      spec: {
        failurePolicy: "Ignore",
        validationActions: ["Audit"],
        webhookConfiguration: { timeoutSeconds: 20 },
        evaluation: {
          admission: { enabled: true },
          background: { enabled: true },
        },
        autogen: { podControllers: { controllers: [] } },
        matchConstraints: {
          resourceRules: [
            {
              apiGroups: [""],
              apiVersions: ["v1"],
              operations: ["CREATE", "UPDATE"],
              resources: ["pods", "pods/ephemeralcontainers"],
            },
          ],
          namespaceSelector: {
            matchExpressions: [{ key: "udp.environment", operator: "Exists" }],
          },
        },
        matchImageReferences: [
          { glob: "ghcr.io/acme/web" },
          { glob: "ghcr.io/acme/web:*" },
          { glob: "ghcr.io/acme/web@*" },
        ],
        validationConfigurations: {
          required: true,
          verifyDigest: true,
          mutateDigest: false,
        },
        credentials: {
          secrets: ["udp-registry-pull"],
          providers: ["github"],
        },
        attestors: [
          {
            name: "udpKey0",
            cosign: {
              key: { data: KEY_A },
              ctlog: { insecureIgnoreTlog: true, insecureIgnoreSCT: true },
              annotations: { "dev.udp.project": "web" },
            },
          },
        ],
        validations: [
          {
            expression: verifyExpression("containers", "[attestors.udpKey0]"),
            message:
              "containers: image của project không có chữ ký hợp lệ của UDP",
          },
          {
            expression: verifyExpression(
              "initContainers",
              "[attestors.udpKey0]",
            ),
            message:
              "initContainers: image của project không có chữ ký hợp lệ của UDP",
          },
          {
            expression: verifyExpression(
              "ephemeralContainers",
              "[attestors.udpKey0]",
            ),
            message:
              "ephemeralContainers: image của project không có chữ ký hợp lệ của UDP",
          },
        ],
      },
    });
  });

  it("chưa ký thì KHÔNG sinh policy — không phải sinh một policy rỗng attestor", () => {
    expect(imageValidatingPolicy(null)).toBeNull();
    expect(imageValidatingPolicy(signedWith({ publicKeys: [] }))).toBeNull();
  });

  it("xoay khoá: mỗi khoá một attestor, và MỘT attestor hợp lệ là đủ", () => {
    const policy = imageValidatingPolicy(
      signedWith({ publicKeys: [KEY_B, KEY_A] }),
    );
    const spec = (policy as { spec: Record<string, unknown> }).spec;

    /** Thứ tự giữ nguyên thứ tự đã lưu: khoá MỚI NHẤT trước (`buildSigningSchema`) */
    expect(spec.attestors).toEqual([
      expect.objectContaining({
        name: "udpKey0",
        cosign: expect.objectContaining({ key: { data: KEY_B } }),
      }),
      expect.objectContaining({
        name: "udpKey1",
        cosign: expect.objectContaining({ key: { data: KEY_A } }),
      }),
    ]);

    /**
     * `verifyImageSignatures` trả về SỐ attestor xác minh được, nên `> 0` nghĩa là "ít nhất một khoá trong danh
     * sách" — đúng nghĩa của xoay khoá không gián đoạn. Đổi thành `== 2` sẽ đòi image ký bằng CẢ HAI khoá.
     */
    const expressions = (spec.validations as { expression: string }[]).map(
      (v) => v.expression,
    );
    for (const e of expressions) {
      expect(e).toContain("[attestors.udpKey0, attestors.udpKey1]");
      expect(e).toContain(".all(e, e > 0)");
    }
  });

  it("tên attestor là định danh CEL — biểu thức tham chiếu nó bằng attestors.<tên>", () => {
    const policy = imageValidatingPolicy(
      signedWith({ publicKeys: [KEY_A, KEY_B] }),
    );
    const names = (
      policy as { spec: { attestors: { name: string }[] } }
    ).spec.attestors.map((a) => a.name);
    for (const name of names) {
      // Dấu gạch ngang trong tên (`udp-key-0`) làm `attestors.udp-key-0` không biên dịch được
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it("nhà cung cấp thông tin đăng nhập theo loại registry; basic thì chỉ có Secret", () => {
    const providerOf = (kind: SignedImages["registryKind"]): unknown =>
      (
        imageValidatingPolicy(signedWith({ registryKind: kind })) as {
          spec: { credentials: Record<string, unknown> };
        }
      ).spec.credentials;

    expect(providerOf("github-token")).toEqual({
      secrets: ["udp-registry-pull"],
      providers: ["github"],
    });
    expect(providerOf("aws-ecr")).toEqual({
      secrets: ["udp-registry-pull"],
      providers: ["amazon"],
    });
    expect(providerOf("gcp")).toEqual({
      secrets: ["udp-registry-pull"],
      providers: ["google"],
    });
    expect(providerOf("azure-acr")).toEqual({
      secrets: ["udp-registry-pull"],
      providers: ["azure"],
    });
    /**
     * `basic` (Harbor, Nexus, Artifactory, Docker Hub) không có nhà cung cấp nào của cloud: Kyverno đọc
     * `udp-registry-pull` ở namespace của chính nó, bản mà `syncRegistryPullSystem` ghi.
     */
    expect(providerOf("basic")).toEqual({ secrets: ["udp-registry-pull"] });
    expect(providerOf("other")).toEqual({ secrets: ["udp-registry-pull"] });
  });

  it("ba glob, không một glob `*`: trần, theo tag, theo digest", () => {
    const globs = (
      imageValidatingPolicy(signedWith()) as {
        spec: { matchImageReferences: { glob: string }[] };
      }
    ).spec.matchImageReferences.map((m) => m.glob);

    expect(globs).toEqual([
      "ghcr.io/acme/web",
      "ghcr.io/acme/web:*",
      "ghcr.io/acme/web@*",
    ]);
    /**
     * Một glob `*` sẽ đòi chữ ký ở MỌI image — kể cả istio, sidecar của Flagger, exporter của Prometheus — tức
     * chặn chính nền tảng. Và thiếu glob trần thì `image: ghcr.io/acme/web` (không tag) không khớp rule nào, nên
     * Kyverno **bỏ qua** nó: một đường đưa image chưa ký vào mà policy không thấy.
     */
    expect(globs).not.toContain("*");
  });

  it("chặn chuỗi có dấu template của Helm — chart chạy tpl trên policy", () => {
    /**
     * Chart `kyverno-policies` render `customPolicies` bằng `tpl (.value | toYaml) .context`, nên một `{{` trong
     * repository hay khoá công khai sẽ được Helm THỰC THI trong cụm của khách.
     */
    expect(() =>
      imageValidatingPolicy(
        signedWith({ repository: "ghcr.io/acme/{{ .Release.Name }}" }),
      ),
    ).toThrow(ImagePolicyError);
    expect(() =>
      imageValidatingPolicy(
        signedWith({
          publicKeys: [`${KEY_A}{{ lookup "v1" "Secret" "" "" }}`],
        }),
      ),
    ).toThrow(ImagePolicyError);
  });

  it("annotation dev.udp.project đúng bằng slug trong repository", () => {
    const annotationOf = (repository: string): unknown =>
      (
        imageValidatingPolicy(signedWith({ repository })) as {
          spec: { attestors: { cosign: { annotations: unknown } }[] };
        }
      ).spec.attestors[0]?.cosign.annotations;

    /**
     * Pipeline ký `-a dev.udp.project=%PROJECT%`, và `pipeline-template.ts` điền `PROJECT: projectSlug` cùng
     * `IMAGE: <registryRef>/<projectSlug>`. Đòi annotation này ở admission để một chữ ký hợp lệ của project KHÁC
     * trên cùng registry không được coi là chữ ký của project này.
     */
    expect(annotationOf("ghcr.io/acme/web")).toEqual({
      "dev.udp.project": "web",
    });
    expect(annotationOf("registry.acme.vn:8443/doi-web/api")).toEqual({
      "dev.udp.project": "api",
    });
  });

  it("hằng số công khai: nhóm/phiên bản là v1beta1 (version LƯU TRỮ của CRD)", () => {
    /**
     * `v1alpha1` của CRD mang `deprecated: true`, và `v1` được phục vụ nhưng KHÔNG phải storage version. Chart
     * `kyverno-policies` 3.9.1 cũng sinh `policies.kyverno.io/v1beta1`.
     */
    expect(IVP_API_VERSION).toBe("policies.kyverno.io/v1beta1");
    expect(IVP_NAME).toBe("udp-require-signed-images");
  });
});
