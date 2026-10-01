import { createHmac } from "node:crypto";
import type {
  CicdDomainAdapter,
  PipelineStep,
  PipelineTemplateParams,
} from "@udp/adapter-core";
import { BUILD_TOOLCHAIN, TEST_IMAGES } from "@udp/config";
import { parseAllDocuments } from "yaml";
import { deployBodySchema, WebhookPayloadError } from "./cicd.js";
import { stepId } from "./pipeline-steps.js";
import type { BuildPlan } from "@udp/adapter-core";

/**
 * Bộ phép CI/CD dùng chung (Plan #36 AC-1) — chạy trên MỌI adapter họ CI/CD cạnh 42 phép của bộ
 * hợp đồng. CHỈ test import tệp này. Không phụ thuộc test runner (cùng lý lẽ với bộ hợp đồng của
 * adapter-core): runner được tiêm vào.
 *
 * `signer` là lời khai của test về cách nhà cung cấp ký — đúng thứ template của adapter làm ở bước
 * "báo UDP". Phép "template dùng đúng header" đối chiếu hai lời khai đó với nhau.
 */

export interface CicdTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
}

export type Signer = (
  rawBody: Buffer,
  secret: string,
) => { headers: Record<string, string>; headerName: string };

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SECRET = "a".repeat(64);
const BODY = Buffer.from(
  JSON.stringify({
    environment: "prod",
    status: "success",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    commitTimestamp: "2026-09-26T08:00:00+07:00",
    imageRef: "ghcr.io/acme/web:0123456789abcdef0123456789abcdef01234567",
    workloadName: "web",
    pipelineId: "run-42",
    repo: "acme/web",
    ref: "refs/heads/main",
    actor: "dev",
  }),
);

/**
 * Bước mẫu của domain khác (Plan #37): khai LỘN thứ tự — template phải tự xếp theo pha rồi tool.
 * Có một biến bí mật để kiểm nó chỉ đi bằng TÊN.
 */
const STEPS: PipelineStep[] = [
  {
    tool: "grype",
    name: "quet-image",
    phase: "after-build",
    image: "anchore/grype:v0.80.0",
    commands: ['grype "$IMAGE_REF" --fail-on high'],
    env: {},
    secretEnv: [],
  },
  {
    tool: "terraform",
    name: "plan",
    phase: "before-build",
    image: "hashicorp/terraform:1.9.8",
    commands: ["terraform -chdir=infra init -input=false"],
    env: { TF_IN_AUTOMATION: "1" },
    secretEnv: ["AWS_ACCESS_KEY_ID"],
  },
  {
    tool: "checkov",
    name: "quet-iac",
    phase: "before-build",
    image: "bridgecrew/checkov:3.2.255",
    commands: ["checkov -d infra --quiet"],
    env: {},
    secretEnv: [],
  },
];

/** [Plan #61] Kế hoạch build mẫu: GHCR, chiến lược tự động, test Node.js */
const BUILD: BuildPlan = {
  strategy: "auto",
  context: ".",
  dockerfile: "Dockerfile",
  platform: "linux/amd64",
  push: { kind: "github-token", server: "ghcr.io" },
  identity: null,
  test: {
    kind: "run",
    command: "npm ci && npm test",
    image: TEST_IMAGES.nodejs,
  },
};

const PARAMS: PipelineTemplateParams = {
  steps: STEPS,
  projectSlug: "web",
  environments: [
    { name: "dev", isProduction: false },
    { name: "prod", isProduction: true },
  ],
  registryRef: "ghcr.io/acme",
  flagKeys: ["checkout_v2", "search"],
  rolloutStrategy: "udp-driven",
  languageRuntime: "nodejs",
  build: BUILD,
};

/**
 * [Plan #61 QĐ-6] Ma trận đăng nhập registry: năm kiểu đẩy, kèm registry của cloud CHƯA có danh tính build. Mỗi ô
 * có thứ phải thấy trong pipeline (`expect`) — không phụ thuộc cú pháp của CI.
 */
const PUSH_CASES: {
  name: string;
  registryRef: string;
  build: Pick<BuildPlan, "push" | "identity">;
  expect: string[];
}[] = [
  {
    name: "basic",
    registryRef: "registry.acme.vn/web-team",
    build: {
      push: { kind: "basic", server: "registry.acme.vn" },
      identity: null,
    },
    expect: ["UDP_REGISTRY_USERNAME", "UDP_REGISTRY_PASSWORD"],
  },
  {
    name: "aws-ecr",
    registryRef: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/acme",
    build: {
      push: {
        kind: "aws-ecr",
        server: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com",
        region: "ap-southeast-1",
      },
      identity: {
        cloud: "aws",
        roleArn: "arn:aws:iam::123456789012:role/udp/udp-build-web",
      },
    },
    expect: [
      "arn:aws:iam::123456789012:role/udp/udp-build-web",
      "ecr get-login-password --region ap-southeast-1",
      BUILD_TOOLCHAIN.images.awsCli,
    ],
  },
  {
    name: "gcp",
    registryRef: "asia-southeast1-docker.pkg.dev/acme-prod/web",
    build: {
      push: { kind: "gcp", server: "asia-southeast1-docker.pkg.dev" },
      identity: {
        cloud: "gcp",
        workloadIdentityProvider:
          "projects/123456789/locations/global/workloadIdentityPools/udp-build/providers/github",
        serviceAccount: "udp-build-web@acme-prod.iam.gserviceaccount.com",
      },
    },
    expect: [
      "udp-build-web@acme-prod.iam.gserviceaccount.com",
      "gcloud auth print-access-token",
      BUILD_TOOLCHAIN.images.gcloud,
    ],
  },
  {
    name: "azure-acr",
    registryRef: "acmeprod.azurecr.io",
    build: {
      push: {
        kind: "azure-acr",
        server: "acmeprod.azurecr.io",
        registryName: "acmeprod",
      },
      identity: {
        cloud: "azure",
        clientId: "11111111-2222-3333-4444-555555555555",
        tenantId: "66666666-7777-8888-9999-000000000000",
      },
    },
    // CircleCI đẩy ACR bằng token (QĐ-6) — ô này chỉ đòi máy chủ
    expect: ["acmeprod.azurecr.io"],
  },
  {
    name: "aws-ecr chưa có danh tính",
    registryRef: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/acme",
    build: {
      push: {
        kind: "aws-ecr",
        server: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com",
        region: "ap-southeast-1",
      },
      identity: null,
    },
    expect: ["Chua co danh tinh build"],
  },
];

/** Repository image của công cụ build mà UDP chọn — mọi lần xuất hiện phải kèm digest (QĐ-8) */
const TOOLCHAIN_REPOS = [
  ...Object.values(BUILD_TOOLCHAIN.images),
  ...Object.values(TEST_IMAGES),
].map((image) => image.split(":")[0] ?? image);

/** Văn bản YAML của template — Jenkinsfile mang YAML của pod giữa hai dấu ba nháy */
function yamlOf(toolId: string, text: string): string {
  if (toolId !== "jenkins") return text;
  const open = "yaml '''";
  const start = text.indexOf(open);
  const end = text.indexOf("'''", start + open.length);
  return start < 0 || end < 0 ? "" : text.slice(start + open.length, end);
}

/** HMAC-SHA256 hex — bộ ký mẫu cho nhà cung cấp dùng tiền tố + hex */
export const hmacSigner =
  (headerName: string, prefix: string): Signer =>
  (rawBody, secret) => ({
    headerName,
    headers: {
      [headerName]: `${prefix}${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    },
  });

/** Token nguyên văn — kiểu `X-Gitlab-Token` */
export const tokenSigner =
  (headerName: string): Signer =>
  (_rawBody, secret) => ({ headerName, headers: { [headerName]: secret } });

export function runCicdSuite(
  adapter: CicdDomainAdapter,
  signer: Signer,
  api: CicdTestApi,
): void {
  const key = Buffer.from(SECRET);
  const signed = signer(BODY, SECRET);

  api.describe(`bộ phép CI/CD: ${adapter.toolId}`, () => {
    api.it("chữ ký đúng ⇒ true; tên header không phân biệt hoa thường", () => {
      assert(
        adapter.verifySignature(signed.headers, BODY, key),
        "chữ ký đúng bị từ chối",
      );
      const lower = Object.fromEntries(
        Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      assert(
        adapter.verifySignature(lower, BODY, key),
        "header viết thường bị từ chối",
      );
    });

    api.it("thân bị sửa, secret khác, thiếu header ⇒ false", () => {
      const tampered = Buffer.from(BODY.toString().replace("prod", "dev"));
      const wrongKey = Buffer.from("b".repeat(64));
      const usesBody = !adapter.verifySignature(signed.headers, tampered, key);
      // Token nguyên văn không ký thân — với kiểu đó, sửa thân không phải điều kiểm được
      const tokenStyle =
        signer(tampered, SECRET).headers[signed.headerName] ===
        signed.headers[signed.headerName];
      assert(usesBody || tokenStyle, "thân bị sửa mà chữ ký cũ vẫn qua");
      assert(
        !adapter.verifySignature(signed.headers, BODY, wrongKey),
        "secret khác mà vẫn qua",
      );
      assert(
        !adapter.verifySignature({}, BODY, key),
        "thiếu header mà vẫn qua",
      );
    });

    api.it(
      "chữ ký lệch độ dài ⇒ false, KHÔNG ném (timingSafeEqual ném khi lệch)",
      () => {
        const value = signed.headers[signed.headerName] ?? "";
        for (const bad of [value.slice(0, -2), `${value}00`, ""]) {
          let result = true;
          try {
            result = adapter.verifySignature(
              { [signed.headerName]: bad },
              BODY,
              key,
            );
          } catch {
            throw new Error(`chữ ký dài ${String(bad.length)} làm verify ném`);
          }
          assert(!result, `chữ ký dài ${String(bad.length)} mà vẫn qua`);
        }
      },
    );

    api.it(
      "thân mẫu ⇒ WebhookDeployEvent đủ trường; thân sai hình ⇒ WebhookPayloadError",
      () => {
        const event = adapter.parsePayload(BODY);
        assert(event.provider === adapter.toolId, "provider phải là toolId");
        assert(
          event.pipelineId === "run-42" && event.status === "success",
          "thiếu pipelineId hay status",
        );
        assert(event.environment === "prod", "sai environment");
        for (const bad of [
          Buffer.from("không phải json"),
          Buffer.from(
            JSON.stringify({ ...JSON.parse(BODY.toString()), la: 1 }),
          ),
          Buffer.from(
            JSON.stringify({ ...JSON.parse(BODY.toString()), commitSha: "x" }),
          ),
        ]) {
          let threw = false;
          try {
            adapter.parsePayload(bad);
          } catch (e) {
            threw = e instanceof WebhookPayloadError;
          }
          assert(
            threw,
            `thân sai hình không ném WebhookPayloadError: ${bad.toString().slice(0, 40)}`,
          );
        }
      },
    );

    api.it(
      "template: đúng registry, header ký, đường webhook, nhãn flag và MỌI trường của thân",
      () => {
        const text = adapter.renderPipelineTemplate(PARAMS);
        for (const needle of [
          "ghcr.io/acme/web",
          signed.headerName,
          "UDP_WEBHOOK_URL",
          "checkout_v2,search",
          "prod",
          "UDP_WEBHOOK_SECRET",
          PARAMS.rolloutStrategy,
        ]) {
          assert(text.includes(needle), `template thiếu "${needle}"`);
        }
        for (const field of Object.keys(deployBodySchema.shape)) {
          assert(
            text.includes(`${field}:`),
            `template không gửi trường "${field}"`,
          );
        }
        assert(!/%[A-Z_]+%/.test(text), "template còn chỗ trống chưa điền");
      },
    );

    api.it(
      "[Plan #48, #61] bước test theo kế hoạch build: chạy lệnh, tắt tường minh, thiếu lệnh thì dừng",
      () => {
        const node = adapter.renderPipelineTemplate(PARAMS);
        assert(node.includes("npm ci && npm test"), "thiếu lệnh npm");
        assert(node.includes(TEST_IMAGES.nodejs), "thiếu image test có digest");
        const python = adapter.renderPipelineTemplate({
          ...PARAMS,
          build: {
            ...BUILD,
            test: {
              kind: "run",
              command: "pip install -r requirements-dev.txt && pytest -q",
              image: TEST_IMAGES.python,
            },
          },
        });
        assert(python.includes("pytest -q"), "python thiếu pytest");
        assert(python.includes(TEST_IMAGES.python), "python thiếu image");
        assert(!python.includes("npm ci"), "python vẫn chạy npm");
        const missing = adapter.renderPipelineTemplate({
          ...PARAMS,
          build: { ...BUILD, test: { kind: "missing", language: "ruby" } },
        });
        assert(
          missing.includes("ngon ngu ruby") && missing.includes("exit 1"),
          "thiếu lệnh test mà không dừng pipeline",
        );
        const skip = adapter.renderPipelineTemplate({
          ...PARAMS,
          build: { ...BUILD, test: { kind: "skip" } },
        });
        assert(
          skip.includes("Buoc test bi tat"),
          "tắt bước test mà không nói rõ",
        );
      },
    );

    api.it(
      "[Plan #61] đăng nhập registry theo kiểu đẩy, TRƯỚC build; ảnh có digest tới bước sau build và bước báo UDP",
      () => {
        for (const c of PUSH_CASES) {
          const text = adapter.renderPipelineTemplate({
            ...PARAMS,
            registryRef: c.registryRef,
            build: { ...BUILD, ...c.build },
          });
          for (const needle of c.expect) {
            assert(text.includes(needle), `[${c.name}] thiếu "${needle}"`);
          }
          const login = Math.min(
            ...[
              "--password-stdin",
              "/udp-auth/config.json",
              "Chua co danh tinh build",
            ]
              .map((n) => text.indexOf(n))
              .filter((i) => i >= 0),
          );
          const build = Math.min(
            ...["docker buildx build", "buildctl-daemonless.sh"]
              .map((n) => text.indexOf(n))
              .filter((i) => i >= 0),
          );
          assert(
            Number.isFinite(login) && Number.isFinite(build) && login < build,
            `[${c.name}] đăng nhập không đứng trước build`,
          );
          assert(
            text.includes("/cnb/lifecycle/creator") ||
              text.includes('pack" build'),
            `[${c.name}] thiếu đường Buildpacks`,
          );
          assert(
            text.includes("@$UDP_DIGEST"),
            `[${c.name}] ảnh không mang digest`,
          );
          // Lần cuối: Jenkins liệt kê container của bước trong YAML của pod TRƯỚC các stage
          const grype = text.lastIndexOf("udp-grype-quet-image");
          assert(
            build < grype && grype < text.lastIndexOf("UDP_WEBHOOK_URL"),
            `[${c.name}] bước sau build không nằm giữa build và báo UDP`,
          );
        }
      },
    );

    api.it(
      "[Plan #61 QĐ-8] không kaniko, không `docker build` trần; action ghim SHA, image công cụ ghim digest; YAML hợp lệ",
      () => {
        for (const c of PUSH_CASES) {
          const text = adapter.renderPipelineTemplate({
            ...PARAMS,
            registryRef: c.registryRef,
            build: { ...BUILD, ...c.build },
          });
          assert(!/kaniko/i.test(text), "còn kaniko");
          assert(!text.includes("docker build -t"), "còn docker build trần");
          for (const m of text.matchAll(/uses: *([^\s#]+)/g)) {
            assert(
              /@[0-9a-f]{40}$/.test(m[1] ?? ""),
              `action không ghim SHA: ${m[1] ?? ""}`,
            );
          }
          for (const repo of TOOLCHAIN_REPOS) {
            let from = 0;
            for (;;) {
              const at = text.indexOf(`${repo}:`, from);
              if (at < 0) break;
              const rest = text.slice(at, at + 200);
              assert(
                /^[^\s'"]*@sha256:[0-9a-f]{64}/.test(rest),
                `image công cụ không ghim digest: ${rest.slice(0, 60)}`,
              );
              from = at + 1;
            }
          }
          const yaml = yamlOf(adapter.toolId, text);
          assert(yaml.trim().length > 0, "không thấy YAML của template");
          for (const doc of parseAllDocuments(yaml)) {
            assert(
              doc.errors.length === 0,
              `[${c.name}] YAML lỗi: ${doc.errors
                .map((e) => e.message)
                .join("; ")
                .slice(0, 200)}`,
            );
          }
          // Groovy: trong ba nháy đơn, backslash là escape — chỉ được đứng cuối dòng (nối dòng của shell)
          if (adapter.toolId === "jenkins") {
            assert(
              !/\\(?!\n)/.test(text),
              "Jenkinsfile mang backslash giữa dòng",
            );
          }
        }
      },
    );

    api.it(
      "bước của domain khác: đủ, theo pha rồi tool, trước lúc báo UDP; bí mật chỉ bằng TÊN",
      () => {
        const text = adapter.renderPipelineTemplate(PARAMS);
        const at = (needle: string): number => {
          const i = text.indexOf(needle);
          assert(i >= 0, `template thiếu "${needle}"`);
          return i;
        };
        for (const step of STEPS) {
          at(step.image);
          for (const c of step.commands) at(c);
        }
        const [checkov, terraform, grype] = [
          "udp-checkov-quet-iac",
          "udp-terraform-plan",
          "udp-grype-quet-image",
        ].map(at) as [number, number, number];
        assert(
          checkov < terraform && terraform < grype,
          "bước không theo pha rồi tool",
        );
        assert(
          grype < text.lastIndexOf("UDP_WEBHOOK_URL"),
          "bước sau build nằm sau lúc báo UDP",
        );
        at("AWS_ACCESS_KEY_ID");
        // Dòng lệnh kết thúc bằng nháy đơn dính vào ba nháy của Groovy: chuỗi đóng sớm
        assert(!text.includes("''''"), "bốn nháy đơn liền nhau trong template");
        assert(at("TF_IN_AUTOMATION") > 0, "thiếu biến công khai của bước");

        const bare = adapter.renderPipelineTemplate({ ...PARAMS, steps: [] });
        for (const step of STEPS) {
          assert(
            !bare.includes(stepId(step)),
            `không có bước mà template vẫn có ${stepId(step)}`,
          );
        }
      },
    );
  });
}
