import { randomUUID } from "node:crypto";
import type {
  CicdDomainAdapter,
  DomainAdapter,
  WebhookDeployEvent,
} from "@udp/adapter-core";
import type { Prisma } from "@udp/db";
import {
  UnauthenticatedError,
  UnprocessableError,
  ValidationError,
} from "@udp/http";
import type { DeployAcceptedResponseWire } from "@udp/shared-types/wire";
import type { Request } from "express";
import { prisma } from "../../core/db.js";
import { WebhookPayloadError } from "../adapter-base/cicd.js";
import { auditEntry } from "../audit/audit.service.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import { enqueueAfterCommit, type EnqueueDeploy } from "./deploy.service.js";
import { isSealedWebhookSecret, openWebhookSecret } from "./webhook-secret.js";

/**
 * Luồng 3 — nhận webhook CI/CD (§8.3, Plan #36 QĐ-3). Thứ tự là thứ tự của sơ đồ: tra project +
 * domain CICD → kiểm chữ ký trên byte GỐC → phân tích → chống trùng → quyết định. Mọi lý do từ
 * chối trước khi chữ ký đúng là CÙNG MỘT 401 — "project không có", "chưa bật CI", "chưa sinh
 * secret" và "chữ ký sai" không phân biệt được, để webhook không thành một oracle dò project.
 */

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
): Promise<CicdDomainAdapter> {
  if (!UUID.test(projectId) || !PROVIDER.test(provider)) throw rejected();
  const row = await prisma.domainConfig.findFirst({
    where: {
      projectId,
      domainType: "CICD",
      isEnabled: true,
      selectedTool: provider,
      project: { status: { not: "DELETED" } },
    },
    select: { webhookSecret: true },
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
    return adapter;
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
    } satisfies Prisma.InputJsonObject,
  };
}

export async function receiveWebhook(args: {
  projectId: string;
  provider: string;
  rawBody: Buffer;
  request: Request;
  registry: DomainAdapterRegistry;
  enqueueDeploy: EnqueueDeploy;
}): Promise<DeployAcceptedResponseWire> {
  const { projectId, provider, rawBody, request } = args;
  const adapter = await verified(
    projectId,
    provider,
    rawBody,
    request,
    args.registry,
  );
  const event = eventOf(adapter, rawBody);

  const environment = await prisma.environment.findFirst({
    where: { projectId, name: event.environment },
    select: { id: true, autoDeploy: true },
  });
  if (environment === null) {
    throw new UnprocessableError(
      `Project không có environment "${event.environment}"`,
    );
  }

  const outcome = await prisma.$transaction(async (tx) => {
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
      return { deploymentId: seen.deploymentId, status: "duplicate" as const };
    }
    const deploymentId = randomUUID();
    const base = eventBase(projectId, environment.id, provider, event);
    const [eventType, status] =
      event.status === "failure" || event.imageRef === undefined
        ? (["DEPLOY_FAILURE", "failure-recorded"] as const)
        : environment.autoDeploy
          ? (["DEPLOY_START", "started"] as const)
          : // §2.2: không cho deploy tự động ⇒ bản ghi chờ, người có quyền duyệt trên Portal
            (["DEPLOY_PENDING", "pending"] as const);
    await tx.deploymentEvent.create({
      data: { ...base, deploymentId, eventType },
    });
    return { deploymentId, status };
  });

  if (outcome.status === "started") {
    await enqueueAfterCommit(args.enqueueDeploy, outcome.deploymentId);
  }
  return outcome;
}
