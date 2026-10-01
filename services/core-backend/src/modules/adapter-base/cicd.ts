import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  CicdDomainAdapter,
  DomainAdapter,
  WebhookDeployEvent,
} from "@udp/adapter-core";

/**
 * `CicdAdapter` — lớp bọc của họ CI/CD (Plan #36 QĐ-1): phần cluster theo họ gốc của tool (mô tả
 * cho GitHub Actions/GitLab CI/CircleCI, Helm cho Jenkins/Tekton/Drone) cộng ba hàm THUẦN của
 * `CicdDomainAdapter`. Route webhook của Service 1 không biết tên tool nào (§8.3 "thêm CI mới không
 * phải sửa Webhook module").
 *
 * Thân webhook là JSON CỦA UDP (QĐ-6) do bước cuối của pipeline — chính template mà
 * `renderPipelineTemplate` sinh — dựng rồi ký ĐÚNG chuỗi byte gửi đi; kiểu header chữ ký là của
 * từng nhà cung cấp. Một bộ phân tích chung cho thân (`parseDeployBody`), một cách so chữ ký
 * (`constantTimeEquals`).
 */

/**
 * Registry mà pipeline đẩy image tới — đọc từ binding `registry.oci`, KHÔNG đoán (luật §5.2): một
 * registry đoán ra đẩy được trên máy người viết và hỏng ở cluster của khách.
 */
export function registryRefOf(
  resolved: Partial<Record<string, { endpoint?: string }>>,
): string {
  const endpoint = resolved["registry.oci"]?.endpoint;
  if (endpoint === undefined) {
    throw new Error("thiếu binding registry.oci trong ctx.resolved");
  }
  return endpoint;
}

export interface CicdSpec {
  /** Phần vòng đời trên cluster — adapter đã dựng bằng lớp nền mô tả hay Helm */
  base: DomainAdapter;
  verifySignature: CicdDomainAdapter["verifySignature"];
  renderPipelineTemplate: CicdDomainAdapter["renderPipelineTemplate"];
}

export function createCicdAdapter(spec: CicdSpec): CicdDomainAdapter {
  const provider = spec.base.toolId;
  return {
    ...spec.base,
    verifySignature: spec.verifySignature,
    parsePayload: (rawBody) => parseDeployBody(provider, rawBody),
    renderPipelineTemplate: spec.renderPipelineTemplate,
  };
}

/**
 * So hai chuỗi byte theo thời gian HẰNG. `timingSafeEqual` ném khi độ dài lệch, nên độ dài được
 * kiểm trước và lệch là `false` — không ném, không rò độ dài tiền tố khớp qua thời gian (sổ nợ
 * `cicd-adapter`). Đây là cách so DUY NHẤT mà adapter CI/CD được dùng trên chữ ký.
 */
export function constantTimeEquals(
  expected: Buffer,
  provided: Buffer,
): boolean {
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** HMAC-SHA256 của thân THÔ */
export const hmacSha256 = (secret: Buffer, rawBody: Buffer): Buffer =>
  createHmac("sha256", secret).update(rawBody).digest();

/** Header theo tên không phân biệt hoa thường — Express hạ chữ, proxy và test thì không chắc */
export function headerOf(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Chữ ký dạng `<tiền tố><hex HMAC-SHA256>` trong một header (GitHub `sha256=`, CircleCI `v1=`,
 * UDP `sha256=`). Header vắng, sai tiền tố hay hex hỏng ⇒ `false`, không ném.
 */
export function verifyHmacHeader(
  headers: Record<string, string>,
  rawBody: Buffer,
  secret: Buffer,
  header: string,
  prefix: string,
): boolean {
  const value = headerOf(headers, header);
  if (value === undefined || !value.startsWith(prefix)) return false;
  const hex = value.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  return constantTimeEquals(
    hmacSha256(secret, rawBody),
    Buffer.from(hex, "hex"),
  );
}

/** Token nguyên văn trong một header (GitLab `X-Gitlab-Token`) — vẫn so theo thời gian hằng */
export function verifyTokenHeader(
  headers: Record<string, string>,
  secret: Buffer,
  header: string,
): boolean {
  const value = headerOf(headers, header);
  return value !== undefined && constantTimeEquals(secret, Buffer.from(value));
}

export class WebhookPayloadError extends Error {
  readonly code = "WEBHOOK_PAYLOAD_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * Thân mà bước "báo UDP" của mọi template gửi (§11, QĐ-6). `.strict()`: một khoá gõ sai trong
 * template là lỗi của template, không được âm thầm bỏ qua.
 */
export const deployBodySchema = z
  .object({
    environment: z.string().regex(/^[a-z0-9-]{1,50}$/),
    status: z.enum(["success", "failure"]),
    commitSha: z.string().regex(/^[0-9a-f]{7,40}$/),
    commitTimestamp: z.string().datetime({ offset: true }).optional(),
    /**
     * Image đầy đủ đã đẩy — vắng khi pipeline hỏng trước bước đẩy. [Plan #61 QĐ-7] Nhận `:tag`, `@sha256:…` và
     * `:tag@sha256:…` (dạng pipeline UDP gửi: commit để đọc, digest để áp)
     */
    imageRef: z
      .string()
      .regex(
        /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+((:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})(@sha256:[0-9a-f]{64})?|@sha256:[0-9a-f]{64})$/,
      )
      .optional(),
    workloadName: z.string().regex(DNS_LABEL),
    pipelineId: z.string().min(1).max(255),
    repo: z.string().min(1).max(255),
    ref: z.string().min(1).max(255),
    actor: z.string().min(1).max(255),
  })
  .strict();

/** Thân thô ⇒ `WebhookDeployEvent`; hỏng ⇒ `WebhookPayloadError` (route trả 400) */
export function parseDeployBody(
  provider: string,
  rawBody: Buffer,
): WebhookDeployEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new WebhookPayloadError("thân webhook không phải JSON");
  }
  const parsed = deployBodySchema.safeParse(json);
  if (!parsed.success) {
    throw new WebhookPayloadError(
      `thân webhook sai hình ở: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  const b = parsed.data;
  return {
    provider,
    repo: b.repo,
    ref: b.ref,
    commitSha: b.commitSha,
    environment: b.environment,
    actor: b.actor,
    pipelineId: b.pipelineId,
    status: b.status,
    workloadName: b.workloadName,
    ...(b.imageRef === undefined ? {} : { imageRef: b.imageRef }),
    ...(b.commitTimestamp === undefined
      ? {}
      : { commitTimestamp: b.commitTimestamp }),
  };
}
