import { createHmac } from "node:crypto";
import type {
  CicdDomainAdapter,
  PipelineTemplateParams,
} from "@udp/adapter-core";
import { deployBodySchema, WebhookPayloadError } from "./cicd.js";

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

const PARAMS: PipelineTemplateParams = {
  projectSlug: "web",
  environments: [
    { name: "dev", isProduction: false },
    { name: "prod", isProduction: true },
  ],
  registryRef: "ghcr.io/acme",
  flagKeys: ["checkout_v2", "search"],
  rolloutStrategy: "udp-driven",
};

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
  });
}
