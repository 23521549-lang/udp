import { randomUUID } from "node:crypto";
import type {
  CicdDomainAdapter,
  DomainAdapter,
  WebhookDeployEvent,
} from "@udp/adapter-core";
import { workloadSlugFor } from "@udp/config";
import type { Prisma } from "@udp/db";
import {
  ServiceUnavailableError,
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from "@udp/http";
import type {
  BuildSettings,
  SignatureRejection,
  TrustedDeployRejection,
} from "@udp/shared-types";
import type { DeployAcceptedResponseWire } from "@udp/shared-types/wire";
import type { Request } from "express";
import { z } from "zod";
import { prisma } from "../../core/db.js";
import { WebhookPayloadError } from "../adapter-base/cicd.js";
import { auditEntry } from "../audit/audit.service.js";
import { bindingsOfProject } from "../capability/capability-binding.repository.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import { settingsOf } from "../packaging/build-plan.js";
import { enqueueAfterCommit, type EnqueueDeploy } from "./deploy.service.js";
import { decideRebase, latestDeployment } from "./rebase-decision.js";
import {
  expectedBranchOf,
  isOwnImage,
  verifyDeploySignature,
} from "./signature-gate.js";
import { bodyDigestOf, recordTokenUse } from "./token-use.repository.js";
import {
  absoluteWebhookUrlOf,
  expectationOf,
  isRetryableRejection,
  verifyTrustedDeploy,
} from "./trusted-deploy.js";
import { isSealedWebhookSecret, openWebhookSecret } from "./webhook-secret.js";

/**
 * Luồng 3 — nhận webhook CI/CD (§8.3, Plan #36 QĐ-3). Thứ tự là thứ tự của sơ đồ: tra project +
 * domain CICD → kiểm chữ ký trên byte GỐC → phân tích → chống trùng → quyết định. Mọi lý do từ
 * chối trước khi chữ ký đúng là CÙNG MỘT 401 — "project không có", "chưa bật CI", "chưa sinh
 * secret" và "chữ ký sai" không phân biệt được, để webhook không thành một oracle dò project.
 */

/**
 * [Plan #61 61d-2a] Tín hiệu nội bộ: token đã dùng rồi, và thân lần này KHÁC lần đầu.
 *
 * Ném để transaction rollback — không được ghi `deployment_events` nào cho một lượt replay. Vì rollback
 * xoá luôn mọi thứ ghi trong transaction đó, hàng audit phải ghi ở một câu RIÊNG sau nó (§8.3 đòi ghi nhận
 * mọi lần verify thất bại để thấy dò quét).
 */
class TokenReplayed extends Error {
  constructor(readonly tokenId: string) {
    super("token của lượt chạy này đã được dùng với một thân khác");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z0-9-]{1,50}$/;

const rejected = (): UnauthenticatedError =>
  new UnauthenticatedError("Chữ ký webhook không hợp lệ");

export const isCicdAdapter = (
  adapter: DomainAdapter | undefined,
): adapter is CicdDomainAdapter =>
  adapter !== undefined &&
  typeof (adapter as Partial<CicdDomainAdapter>).verifySignature ===
    "function" &&
  typeof (adapter as Partial<CicdDomainAdapter>).parsePayload === "function";

/** Header dạng chuỗi — Node gộp header lặp thành mảng; lấy cái đầu */
function flatHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value[0] !== undefined)
      out[key] = value[0];
  }
  return out;
}

/**
 * Tag hay digest của image: `…/web:abc` ⇒ `abc`, `…/web@sha256:…` ⇒ `sha256:…`. [Plan #61 QĐ-7] Có cả hai
 * (`…/web:<commit>@sha256:…` — dạng pipeline UDP gửi) ⇒ tag: người đọc thấy commit, deploy vẫn áp nguyên chuỗi.
 */
export function tagOf(imageRef: string): string {
  const at = imageRef.indexOf("@");
  const bare = at >= 0 ? imageRef.slice(0, at) : imageRef;
  const colon = bare.lastIndexOf(":");
  if (colon > bare.lastIndexOf("/")) return bare.slice(colon + 1);
  return at >= 0 ? imageRef.slice(at + 1) : "latest";
}

/** Chữ ký đúng mới mở được secret; mọi đường trượt khác là cùng một 401 */
async function verified(
  projectId: string,
  provider: string,
  rawBody: Buffer,
  request: Request,
  registry: DomainAdapterRegistry,
): Promise<{
  adapter: CicdDomainAdapter;
  cicdConfigId: string;
  toolConfig: unknown;
  oidcRequired: boolean;
}> {
  if (!UUID.test(projectId) || !PROVIDER.test(provider)) throw rejected();
  const row = await prisma.domainConfig.findFirst({
    where: {
      projectId,
      domainType: "CICD",
      isEnabled: true,
      selectedTool: provider,
      project: { status: { not: "DELETED" } },
    },
    select: {
      id: true,
      webhookSecret: true,
      toolConfig: true,
      oidcRequired: true,
    },
  });
  const adapter = registry.get("CICD", provider);
  if (
    row === null ||
    !isSealedWebhookSecret(row.webhookSecret) ||
    !isCicdAdapter(adapter)
  ) {
    throw rejected();
  }
  const secret = openWebhookSecret(projectId, row.webhookSecret);
  if (adapter.verifySignature(flatHeaders(request), rawBody, secret)) {
    // [Plan #61 61d-2a] Trả kèm cấu hình của hàng CICD: Trusted Deploy cần `toolConfig` để suy issuer và
    // claim mong đợi, và `oidcRequired` để biết "không có token" là hợp lệ hay không. Đọc ở đây để không
    // phải một vòng đi về thứ hai — hàng này vừa được đọc xong.
    return {
      adapter,
      cicdConfigId: row.id,
      toolConfig: row.toolConfig,
      oidcRequired: row.oidcRequired,
    };
  }
  // Ghi nhận lần verify thất bại (§8.3) để thấy dò quét — không ghi thân hay header
  await prisma.auditLog.create({
    data: {
      projectId,
      ...auditEntry({
        action: "cicd.webhook.rejected",
        targetType: "Project",
        targetId: projectId,
        actorType: "SYSTEM",
        after: { provider },
        request,
      }),
    },
  });
  throw rejected();
}

function eventOf(adapter: CicdDomainAdapter, rawBody: Buffer) {
  try {
    return adapter.parsePayload(rawBody);
  } catch (e) {
    if (e instanceof WebhookPayloadError) throw new ValidationError(e.message);
    throw e;
  }
}

/** Các cột mọi sự kiện của lần deploy này mang — `metadata.imageRef` là thứ job deploy áp */
function eventBase(
  projectId: string,
  environmentId: string,
  provider: string,
  event: WebhookDeployEvent,
) {
  return {
    projectId,
    environmentId,
    workloadName: event.workloadName,
    pipelineId: event.pipelineId,
    commitSha: event.commitSha,
    ...(event.commitTimestamp === undefined
      ? {}
      : { commitTimestamp: new Date(event.commitTimestamp) }),
    ...(event.imageRef === undefined
      ? {}
      : { imageTag: tagOf(event.imageRef) }),
    triggeredBy: "WEBHOOK" as const,
    metadata: {
      provider,
      repo: event.repo,
      ref: event.ref,
      actor: event.actor,
      ...(event.imageRef === undefined ? {} : { imageRef: event.imageRef }),
      // [Plan #61 QĐ-13] Danh sách deployment đọc cờ này để ghi "Vá image nền"
      ...(event.kind === undefined ? {} : { kind: event.kind }),
    } satisfies Prisma.InputJsonObject,
  };
}

/** Webhook mở lần deploy: báo thành công và có image */
const deploys = (
  event: WebhookDeployEvent,
): event is WebhookDeployEvent & { imageRef: string } =>
  event.status === "success" && event.imageRef !== undefined;

/**
 * [Plan #61 QĐ-16] Mọi project: image phải thuộc repository của chính nó (`<registryRef>/<slug>`) — secret webhook lộ
 * cũng không deploy được image ở nơi khác. Trả slug cho bước kiểm chữ ký.
 */
async function assertOwnImage(
  projectId: string,
  provider: string,
  event: WebhookDeployEvent,
  request: Request,
): Promise<string> {
  const [project, bindings] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true },
    }),
    bindingsOfProject(prisma, projectId),
  ]);
  const slug = workloadSlugFor(project.name);
  if (!deploys(event)) return slug;
  const registryRef = bindings.find(
    (b) => b.capabilityId === "registry.oci",
  )?.endpoint;
  const repository = registryRef == null ? null : `${registryRef}/${slug}`;
  if (repository !== null && isOwnImage(event.imageRef, repository)) {
    return slug;
  }
  await prisma.auditLog.create({
    data: {
      projectId,
      ...auditEntry({
        action: "cicd.webhook.foreign-image",
        targetType: "Project",
        targetId: projectId,
        actorType: "SYSTEM",
        after: { provider, imageRef: event.imageRef, repository },
        request,
      }),
    },
  });
  throw new UnprocessableError(
    repository === null
      ? "Project chưa có registry.oci — UDP không deploy image ngoài registry của project"
      : `Image ${event.imageRef} không thuộc repository ${repository} của project`,
  );
}

type SignatureVerdict =
  | { kind: "verified"; keyId: string; issuedAt: string }
  | { kind: "rejected"; code: SignatureRejection; detail: string }
  | { kind: "unchecked" };

const signedMetadata = z.object({
  signature: z.object({ issuedAt: z.string() }),
});

/**
 * `issued-at` của chữ ký trên lần deploy THÀNH CÔNG gần nhất của workload — chữ ký mới không được cũ hơn
 *
 * [Plan #61, sửa trong 61d-1] Thứ tự dựa vào `occurred_at` do DATABASE cấp, không phải đồng hồ của tiến trình ghi:
 * nếu không, một lệch đồng hồ giữa Service 1 và Service 3 làm UDP nhận một chữ ký cũ hơn bản đang chạy — đúng thứ
 * AC-10 cấm. Khoá phụ `id` chỉ là khoá chốt cho tính xác định, không phải một đồng hồ (xem `latestDeployment`).
 */
async function currentIssuedAt(
  tx: Prisma.TransactionClient,
  where: { projectId: string; environmentId: string; workloadName: string },
): Promise<Date | null> {
  const last = await tx.deploymentEvent.findFirst({
    where: { ...where, eventType: "DEPLOY_SUCCESS" },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { deploymentId: true },
  });
  if (last === null) return null;
  const opening = await tx.deploymentEvent.findFirst({
    where: {
      projectId: where.projectId,
      deploymentId: last.deploymentId,
      eventType: { in: ["DEPLOY_START", "DEPLOY_PENDING"] },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: { metadata: true },
  });
  const meta = signedMetadata.safeParse(opening?.metadata);
  return meta.success ? new Date(meta.data.signature.issuedAt) : null;
}

/**
 * [Plan #61 QĐ-16] Phán quyết của cổng deploy. Project chưa có khoá ⇒ không kiểm. Chữ ký có mà sai ⇒ luôn từ chối;
 * thiếu chữ ký ⇒ từ chối khi `enforce`, không thì deploy và ghi là chưa kiểm.
 */
async function signatureVerdict(
  tx: Prisma.TransactionClient,
  args: {
    projectId: string;
    environment: { id: string; name: string; isProduction: boolean };
    event: WebhookDeployEvent & { imageRef: string };
    slug: string;
    signing: BuildSettings["signing"];
  },
): Promise<SignatureVerdict> {
  const { event, signing } = args;
  if (signing.keys.length === 0) return { kind: "unchecked" };
  if (event.signature === undefined) {
    return signing.enforce
      ? {
          kind: "rejected",
          code: "SIGNATURE_MISSING",
          detail: "pipeline không gửi chữ ký",
        }
      : { kind: "unchecked" };
  }
  const check = verifyDeploySignature(event.signature, signing.keys, {
    imageRef: event.imageRef,
    project: args.slug,
    commit: event.commitSha,
    branch: expectedBranchOf(args.environment),
    notBefore: await currentIssuedAt(tx, {
      projectId: args.projectId,
      environmentId: args.environment.id,
      workloadName: event.workloadName,
    }),
    now: new Date(),
  });
  return check.ok
    ? { kind: "verified", keyId: check.keyId, issuedAt: check.issuedAt }
    : { kind: "rejected", code: check.code, detail: check.detail };
}

/**
 * Chữ ký hợp lệ đầu tiên ⇒ bật bắt buộc, cùng transaction: từ đây image không chữ ký không deploy được. Chỉ sửa đúng
 * một trường của JSON — không ghi đè cài đặt mà người dùng lưu cùng lúc.
 */
/**
 * [Plan #61 QĐ-17, 61d-2a] Tự bật chế độ bắt buộc ở TOKEN HỢP LỆ ĐẦU TIÊN.
 *
 * Cùng khuôn `enforceSigning` của 61d-1, kể cả chi tiết dễ quên nhất: `AND oidc_required = false` rồi kiểm
 * số hàng đổi, nên nhật ký SYSTEM ghi đúng MỘT lần chứ không một hàng mỗi webhook.
 *
 * Cờ nằm ở HÀNG CICD, nên một lần đổi `selected_tool` phải đưa nó về false — ý nghĩa của nó phụ thuộc nhà
 * cung cấp (issuer, claim, cách xin token). Việc đó do một trigger ở tầng database lo (migration
 * `oidc_required_reset_on_tool_change`), không phải một đoạn mã ở đây: đặt ở đây thì mọi đường ghi tương
 * lai phải nhớ làm lại.
 */
async function enforceOidc(
  tx: Prisma.TransactionClient,
  args: {
    projectId: string;
    cicdConfigId: string;
    provider: string;
    tokenId: string;
    deploymentId: string;
    request: Request;
  },
): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE domain_configs
    SET oidc_required = true
    WHERE id = ${args.cicdConfigId}::uuid
      AND oidc_required = false`;
  if (changed === 0) return;
  await tx.auditLog.create({
    data: {
      projectId: args.projectId,
      ...auditEntry({
        action: "cicd.trusted-deploy.required",
        targetType: "Project",
        targetId: args.projectId,
        actorType: "SYSTEM",
        // Chỉ mã định danh của token, không bao giờ chính token (I24, §8.3)
        after: {
          provider: args.provider,
          tokenId: args.tokenId,
          deploymentId: args.deploymentId,
        },
        request: args.request,
      }),
    },
  });
}

async function enforceSigning(
  tx: Prisma.TransactionClient,
  projectId: string,
  after: { keyId: string; deploymentId: string },
  request: Request,
): Promise<void> {
  const changed = await tx.$executeRaw`
    UPDATE projects
    SET build_settings = jsonb_set(build_settings, '{signing,enforce}', 'true'::jsonb)
    WHERE id = ${projectId}::uuid
      AND build_settings->'signing'->>'enforce' IS DISTINCT FROM 'true'`;
  if (changed === 0) return;
  await tx.auditLog.create({
    data: {
      projectId,
      ...auditEntry({
        action: "project.build.signing-enforced",
        targetType: "Project",
        targetId: projectId,
        actorType: "SYSTEM",
        after,
        request,
      }),
    },
  });
}

/**
 * Một lượt replay: ghi audit ở câu RIÊNG (transaction vừa rollback nên không còn gì để ghi cùng) rồi ném
 * 401. Mô tả nằm ở §8.3: mọi lần verify thất bại phải được ghi nhận để thấy dò quét.
 */
async function onReplay(args: {
  projectId: string;
  provider: string;
  tokenId: string;
  request: Request;
}): Promise<never> {
  await prisma.auditLog.create({
    data: {
      projectId: args.projectId,
      ...auditEntry({
        action: "cicd.webhook.rejected",
        targetType: "Project",
        targetId: args.projectId,
        actorType: "SYSTEM",
        // Chỉ mã và định danh của token, không bao giờ chính token (I24, §8.3)
        after: {
          provider: args.provider,
          trustedDeploy: "TOKEN_REPLAYED",
          tokenId: args.tokenId,
        },
        request: args.request,
      }),
    },
  });
  throw new UnauthenticatedError(
    "Trusted Deploy từ chối lời báo: TOKEN_REPLAYED — token của lượt chạy này đã được dùng với một thân khác",
  );
}

/**
 * [Plan #61 QĐ-17, 61d-2a] Phán quyết Trusted Deploy cho một lời báo, cộng việc cưỡng chế chế độ.
 *
 * Trả `null` nghĩa là KHÔNG kiểm (chưa bắt buộc mà pipeline chưa gửi token, hay provider chưa khả dụng) —
 * đường deploy chạy như trước. Từ chối thì ném ngay, và ghi `AuditLog` `cicd.webhook.rejected` ở một câu
 * RIÊNG: §8.3 đòi ghi nhận mọi lần verify thất bại để thấy dò quét, mà transaction deploy chưa mở nên
 * không có gì để ghi cùng.
 *
 * Hai luật cưỡng chế, mirror đúng cổng chữ ký của 61d-1:
 *  - Token CÓ mà không xác minh được ⇒ **luôn** từ chối, bất kể `oidcRequired`. Không có luật này thì kẻ
 *    có secret HMAC chỉ cần BỎ header là xong, trên mọi project chưa bật cờ.
 *  - Thiếu token ⇒ chỉ từ chối khi `oidcRequired`.
 *
 * Mã HTTP tách theo họ lý do: lỗi hạ tầng (không lấy được khoá công khai) ⇒ 503, lỗi của token hay claim ⇒
 * 401 terminal. Trả 401 cho một lần JWKS không với tới là một lỗi không bao giờ tự khỏi. **Lưu ý một nửa
 * còn thiếu** (phát hiện trong vòng QA của 61d-2b): bước báo mà `notifyScript` sinh ra hiện là
 * `curl -sS --fail`, KHÔNG có `--retry`, nên 503 hôm nay làm bước báo đỏ chứ chưa tự lành; `--retry` thêm
 * vào trong 61d-2b-1 cùng lúc với nhánh CI-trong-cụm, nơi 503 thành lối ra thường gặp. Và tuyệt đối KHÔNG rơi về HMAC khi JWKS hỏng: rơi về HMAC chính là thoái
 * cấp mà chế độ bắt buộc sinh ra để chặn, và nó biến một sự cố của nhà cung cấp thành đường tắt.
 */
async function verifyDeployToken(args: {
  projectId: string;
  provider: string;
  cicd: { toolConfig: unknown; oidcRequired: boolean };
  environment: { name: string; isProduction: boolean };
  authorization: string | undefined;
  egressFetch: typeof fetch;
  request: Request;
}): Promise<{ tokenId: string; issuer: string; expiresAt: Date } | null> {
  const { projectId, provider, cicd, environment, request } = args;

  const refuse = async (
    code: TrustedDeployRejection,
    detail: string,
  ): Promise<never> => {
    await prisma.auditLog.create({
      data: {
        projectId,
        ...auditEntry({
          action: "cicd.webhook.rejected",
          targetType: "Project",
          targetId: projectId,
          actorType: "SYSTEM",
          // Không bao giờ ghi chính token (I24, §8.3 "không ghi thân hay header") — chỉ mã và lý do
          after: { provider, trustedDeploy: code, detail },
          request,
        }),
      },
    });
    const message = `Trusted Deploy từ chối lời báo: ${code} — ${detail}`;
    throw isRetryableRejection(code)
      ? new ServiceUnavailableError(message)
      : new UnauthenticatedError(message);
  };

  const expected = expectationOf({
    provider,
    toolConfig: cicd.toolConfig,
    webhookUrl: absoluteWebhookUrlOf(projectId, provider),
  });
  if ("unavailable" in expected) {
    // Không được bật cờ cho một provider UDP chưa kiểm được (Portal chặn, và `setOidcRequired` chặn lại),
    // nên tới đây là một trạng thái không nên có — từ chối thay vì lặng lẽ cho qua.
    if (cicd.oidcRequired) {
      return await refuse(
        "TOKEN_MISSING",
        `UDP chưa kiểm được token của ${provider}: ${expected.unavailable}`,
      );
    }
    return null;
  }

  const verdict = await verifyTrustedDeploy({
    expected,
    authorization: args.authorization,
    egressFetch: args.egressFetch,
    now: new Date(),
  });
  if (verdict.kind === "rejected") {
    return await refuse(verdict.code, verdict.detail);
  }
  if (verdict.kind === "absent") {
    if (cicd.oidcRequired) {
      return await refuse(
        "TOKEN_MISSING",
        "chế độ bắt buộc đang bật mà lời báo không mang Authorization",
      );
    }
    return null;
  }

  // Nhánh lấy từ CLAIM của token, không từ thân: khi secret HMAC đã lộ thì thân giả mạo được, claim thì
  // không. Đây là phần đáng tiền nhất của AC-11 — "token của nhánh phụ không deploy được production".
  if (verdict.ref !== null) {
    const allowed = `refs/heads/${expectedBranchOf(environment)}`;
    if (verdict.ref !== allowed) {
      return await refuse(
        "TOKEN_CLAIM_MISMATCH",
        `token của ${verdict.ref} không được deploy environment "${environment.name}"`,
      );
    }
  }

  return {
    tokenId: verdict.tokenId,
    issuer: verdict.issuer,
    expiresAt: verdict.expiresAt,
  };
}

export async function receiveWebhook(args: {
  projectId: string;
  provider: string;
  rawBody: Buffer;
  request: Request;
  registry: DomainAdapterRegistry;
  enqueueDeploy: EnqueueDeploy;
  /**
   * [Plan #61 61d-2a] `fetch` đã bọc hàng rào egress — tiêm vào chứ không lấy toàn cục.
   *
   * Luật của repo (`cluster-access/src/transport.ts`): Service 1 gọi URL do người dùng nhập thì phải đi
   * `createEgressFetch`, có chặn SSRF ngay trong `lookup` để không hở DNS rebinding (§12.1 T11). Issuer
   * GitLab đến từ `tool_config.gitlabUrl` của chính project, và regex của nó nhận cả một địa chỉ nội bộ.
   * Tiêm vào cũng là cách làm bộ test khẳng định được "không một lời gọi mạng nào phát ra".
   */
  egressFetch: typeof fetch;
}): Promise<DeployAcceptedResponseWire> {
  const { projectId, provider, rawBody, request } = args;
  const cicd = await verified(
    projectId,
    provider,
    rawBody,
    request,
    args.registry,
  );
  const event = eventOf(cicd.adapter, rawBody);

  const environment = await prisma.environment.findFirst({
    where: { projectId, name: event.environment },
    select: { id: true, autoDeploy: true, isProduction: true },
  });
  if (environment === null) {
    throw new UnprocessableError(
      `Project không có environment "${event.environment}"`,
    );
  }
  if (event.kind === "rebase" && !environment.isProduction) {
    throw new UnprocessableError(
      `Lượt rebase chỉ dành cho environment production, không phải "${event.environment}"`,
    );
  }
  /**
   * [Plan #61 QĐ-17, 61d-2a] Trusted Deploy — NGOÀI transaction, và chỉ tới đây mới chạy.
   *
   * Ngoài transaction vì nó gọi mạng: transaction bên dưới giữ một advisory lock và một dòng project đã
   * khoá, giữ chúng xuyên qua một lời gọi HTTP là cách làm đứng cả control plane khi nhà cung cấp chậm.
   * Sau `verified()` vì §8.3 quy định bốn tình huống trước đó là CÙNG một 401 để webhook không thành
   * oracle dò project — mã lý do chi tiết dưới đây chỉ lộ cho bên đã chứng minh giữ secret của project.
   */
  const trusted = await verifyDeployToken({
    projectId,
    provider,
    cicd,
    // `environment` đọc từ database không mang `name` (webhook tra theo tên), nên ghép lại từ thân như
    // cổng chữ ký của 61d-1 đang làm — tên ở đây chỉ để dựng nhánh mong đợi và câu lý do.
    environment: {
      name: event.environment,
      isProduction: environment.isProduction,
    },
    authorization: flatHeaders(request).authorization,
    egressFetch: args.egressFetch,
    request,
  });

  const slug = await assertOwnImage(projectId, provider, event, request);

  const outcome = await prisma
    .$transaction(async (tx) => {
      // Chống trùng theo pipeline, dưới khoá của (environment, pipeline): hai lần gửi lại đến cùng
      // lúc (retry mạng của CI) không được thành hai lần deploy
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${environment.id}:${event.pipelineId}`}, 0))`;
      const seen = await tx.deploymentEvent.findFirst({
        where: {
          projectId,
          environmentId: environment.id,
          pipelineId: event.pipelineId,
          triggeredBy: "WEBHOOK",
        },
        select: { deploymentId: true },
      });
      if (seen !== null) {
        return {
          deploymentId: seen.deploymentId,
          status: "duplicate" as const,
        };
      }
      // [Plan #61 QĐ-13] UDP quyết lượt rebase: chỉ deploy khi production đang chạy ĐÚNG commit này với digest khác
      if (event.kind === "rebase" && event.imageRef !== undefined) {
        const decision = decideRebase(
          await latestDeployment(tx, {
            projectId,
            environmentId: environment.id,
            workloadName: event.workloadName,
          }),
          event.imageRef,
        );
        if (decision.action === "unchanged") {
          return {
            deploymentId: decision.deploymentId,
            status: "unchanged" as const,
          };
        }
        if (decision.action === "skipped") {
          return {
            deploymentId: decision.deploymentId,
            status: "skipped" as const,
            reason: decision.reason,
          };
        }
      }
      const deploymentId = randomUUID();

      // [Plan #61 QĐ-17, 61d-2a] Tiêu token ĐÚNG ở đây: sau nhánh chống trùng và sau quyết định rebase, tức
      // tại điểm mà mọi đường còn lại đều ghi đúng một `deployment_events`. Đặt sớm hơn thì một lượt chạy bị
      // bỏ qua (`duplicate`, `unchanged`, `skipped`) cũng đốt mất token của nó.
      if (trusted !== null) {
        const use = await recordTokenUse(tx, {
          projectId,
          issuer: trusted.issuer,
          tokenId: trusted.tokenId,
          pipelineId: event.pipelineId,
          environmentId: environment.id,
          bodyDigest: bodyDigestOf(rawBody),
          deploymentId,
          expiresAt: trusted.expiresAt,
        });
        if (use.kind === "replayed") {
          // Ném để transaction rollback: không ghi sự kiện deploy nào. Audit cho lần này ghi ở câu riêng
          // SAU transaction, vì ghi trong đây sẽ mất cùng lượt rollback.
          throw new TokenReplayed(trusted.tokenId);
        }
        if (use.kind === "retry") {
          // Thân giống hệt lần đầu ⇒ retry thật của CI. Trả lại kết quả cũ chứ không để bước báo đỏ trong
          // khi lần deploy kia đã chạy thật.
          return {
            deploymentId: use.deploymentId ?? deploymentId,
            status: "duplicate" as const,
          };
        }
      }
      const base = eventBase(projectId, environment.id, provider, event);
      if (!deploys(event)) {
        await tx.deploymentEvent.create({
          data: { ...base, deploymentId, eventType: "DEPLOY_FAILURE" },
        });
        return { deploymentId, status: "failure-recorded" as const };
      }
      // Khoá dòng project tới hết transaction: lượt bật bắt buộc và lượt đọc nó không lướt qua nhau. NO KEY: không chặn
      // các bảng khác ghi khoá ngoại tới project
      const [row] = await tx.$queryRaw<{ build_settings: unknown }[]>`
      SELECT build_settings FROM projects WHERE id = ${projectId}::uuid FOR NO KEY UPDATE`;
      const signing = settingsOf(row?.build_settings).signing;
      const verdict = await signatureVerdict(tx, {
        projectId,
        environment: { ...environment, name: event.environment },
        event,
        slug,
        signing,
      });
      if (verdict.kind === "rejected") {
        await tx.deploymentEvent.create({
          data: {
            ...base,
            deploymentId,
            eventType: "DEPLOY_FAILURE",
            metadata: {
              ...base.metadata,
              reason: `Cổng deploy từ chối image: ${verdict.code} (${verdict.detail})`,
              signature: { code: verdict.code, detail: verdict.detail },
            },
          },
        });
        return {
          deploymentId,
          status: "rejected" as const,
          code: verdict.code,
          detail: verdict.detail,
        };
      }
      const [eventType, status] = environment.autoDeploy
        ? (["DEPLOY_START", "started"] as const)
        : // §2.2: không cho deploy tự động ⇒ bản ghi chờ, người có quyền duyệt trên Portal
          (["DEPLOY_PENDING", "pending"] as const);
      await tx.deploymentEvent.create({
        data: {
          ...base,
          deploymentId,
          eventType,
          metadata: {
            ...base.metadata,
            ...(verdict.kind === "verified"
              ? {
                  signature: {
                    keyId: verdict.keyId,
                    issuedAt: verdict.issuedAt,
                  },
                }
              : {}),
            // [Plan #61 61d-2a] Chỉ mã định danh của token, không bao giờ chính token (I24, §8.3)
            ...(trusted === null
              ? {}
              : { trustedDeploy: { tokenId: trusted.tokenId } }),
          },
        },
      });
      // [Plan #61 61d-2a] Tự bật Trusted Deploy sau khi sự kiện deploy đã được ghi, trong CÙNG transaction
      if (trusted !== null && !cicd.oidcRequired) {
        await enforceOidc(tx, {
          projectId,
          cicdConfigId: cicd.cicdConfigId,
          provider,
          tokenId: trusted.tokenId,
          deploymentId,
          request,
        });
      }
      if (verdict.kind === "verified" && !signing.enforce) {
        await enforceSigning(
          tx,
          projectId,
          { keyId: verdict.keyId, deploymentId },
          request,
        );
      }
      return { deploymentId, status };
    })
    .catch(async (err: unknown) => {
      if (!(err instanceof TokenReplayed)) throw err;
      return await onReplay({
        projectId,
        provider,
        tokenId: err.tokenId,
        request,
      });
    });

  if (outcome.status === "rejected") {
    // Sự kiện từ chối đã ghi (Portal hiện lý do); 422 làm bước báo của CI đỏ — người đẩy code thấy ngay
    throw new UnprocessableError(
      `UDP từ chối deploy image: ${outcome.code} — ${outcome.detail}`,
    );
  }
  if (outcome.status === "started") {
    await enqueueAfterCommit(args.enqueueDeploy, outcome.deploymentId);
  }
  return outcome;
}
