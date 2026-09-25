import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { CloudAdapter, ResolvedCredential } from "@udp/adapter-core";
import { isGatewayError, safeMessage } from "@udp/cloud-adapters";
import {
  ConflictError,
  ServiceUnavailableError,
  UnprocessableError,
} from "@udp/http";
import {
  CLOUD_ERROR_SLUGS,
  FEDERATED_AUTH_KINDS,
  payloadOf,
  type CloudAuthKindWire,
  type CloudCredentialInput,
  type CloudProviderWire,
  type PutCloudBody,
} from "@udp/shared-types/cloud-api";
import { PROVISION_ERROR_SLUGS } from "@udp/shared-types/provisioning-api";
import type {
  CloudCredentialWire,
  CloudPreflightWire,
  CloudSetupWire,
  CloudValidationWire,
} from "@udp/shared-types/wire";
import { requireUser } from "../../core/http/middlewares/auth.middleware.js";
import { auditEntry } from "../audit/audit.service.js";
import {
  encryptCredential,
  fingerprintOf,
} from "../credential/credential.crypto.js";
import { resolveCredential } from "../credential/credential.resolver.js";
import { providerFromDb } from "../provisioning/provider-codec.js";
import { activeJobOf } from "../provisioning/provisioning.service.js";
import type { CloudPlatform, PlatformCapabilities } from "./cloud.platform.js";
import * as repository from "./cloud.repository.js";
import type { CredentialEnvelope, CredentialMeta } from "./cloud.repository.js";
import {
  buildSetup,
  managedTargetOf,
  unavailableReason,
} from "./cloud.setup.js";

/**
 * Cấu hình cloud của project (Plan #26 P6, §4.3, §9): lưu credential đã mã hoá, và kiểm
 * nó bằng CHÍNH adapter sẽ provisioning. `PUT` không gọi cloud — lưu nhanh, kiểm riêng —
 * để khách sửa quyền bên cloud rồi bấm kiểm lại mà không phải nhập bí mật lần nữa.
 */

/** Số ký tự fingerprint lên dây — đủ để đối chiếu, không đủ để thành định danh */
const FINGERPRINT_SHOWN = 12;

/** DEK version khi ghi bản mới: xoay DEK là việc riêng, tăng từ đây */
const FIRST_DEK_VERSION = 1;

const FEDERATED_KIND_OF: Readonly<
  Record<CloudProviderWire, CloudAuthKindWire>
> = {
  AWS: "AWS_ROLE",
  GCP: "GCP_WIF",
  AZURE: "AZURE_FEDERATED",
};

export function toView(row: CredentialMeta): CloudCredentialWire {
  return {
    provider: row.provider,
    mode: row.mode,
    authKind: row.authKind,
    federated:
      row.mode === "MANAGED" || FEDERATED_AUTH_KINDS.includes(row.authKind),
    region: row.region,
    fingerprint: row.fingerprint.slice(0, FINGERPRINT_SHOWN),
    lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
  };
}

export async function get(
  projectId: string,
): Promise<CloudCredentialWire | null> {
  const row = await repository.activeMeta(projectId);
  return row === null ? null : toView(row);
}

export const setup = (
  projectId: string,
  provider: CloudProviderWire,
  platform: CloudPlatform,
): CloudSetupWire => buildSetup(provider, projectId, platform.capabilities);

/**
 * Định danh CÔNG KHAI của credential — thứ `fingerprint` băm (§4.3: băm định danh, không
 * băm bí mật, vì băm của một bí mật ngắn là một oracle để dò nó).
 */
function publicIdentifierOf(credential: CloudCredentialInput): string {
  switch (credential.authKind) {
    case "AWS_ROLE":
      return credential.roleArn;
    case "AWS_KEY":
      return credential.accessKeyId;
    case "GCP_WIF":
      return credential.serviceAccountEmail;
    case "GCP_KEY":
      return credential.client_email;
    case "AZURE_FEDERATED":
    case "AZURE_SECRET":
      return `${credential.tenantId}/${credential.clientId}`;
  }
}

function methodUnavailable(what: string): UnprocessableError {
  return new UnprocessableError(
    `${what} chưa được bật trên triển khai UDP này`,
  ).withTypeSlug(CLOUD_ERROR_SLUGS.methodUnavailable);
}

interface ToStore {
  authKind: CloudAuthKindWire;
  payload: object;
  identifier: string;
}

function byocToStore(
  credential: CloudCredentialInput,
  caps: PlatformCapabilities,
): ToStore {
  if (unavailableReason(credential.authKind, caps) !== null) {
    throw methodUnavailable(credential.authKind);
  }
  const { authKind, payload } = payloadOf(credential);
  return { authKind, payload, identifier: publicIdentifierOf(credential) };
}

/** MANAGED: đích là cấu hình của UDP, không phải thứ khách nhập */
function managedToStore(
  provider: CloudProviderWire,
  caps: PlatformCapabilities,
): ToStore {
  const target = managedTargetOf(provider, caps);
  if (target === null) {
    throw methodUnavailable(`MANAGED ${provider}`);
  }
  return {
    authKind: FEDERATED_KIND_OF[provider],
    payload: target,
    identifier: `managed:${provider}:${JSON.stringify(target)}`,
  };
}

function requireAdapter(
  platform: CloudPlatform,
  provider: CloudProviderWire,
  region: string,
): CloudAdapter {
  const adapter = platform.adapterFor(providerFromDb(provider), region);
  if (adapter === null) {
    throw new ServiceUnavailableError(
      `Cloud ${provider} không được bật trên triển khai UDP này`,
    );
  }
  return adapter;
}

export async function put(
  projectId: string,
  body: PutCloudBody,
  request: Request,
  platform: CloudPlatform,
): Promise<CloudCredentialWire> {
  const user = requireUser(request);
  // Cloud chưa bật ở triển khai này thì credential lưu vào cũng không dùng được
  requireAdapter(platform, body.provider, body.region);
  // §2.2: job đang chạy dựng tài nguyên bằng credential HIỆN TẠI — đổi giữa chừng là bù trừ
  // và teardown sau đó gọi nhầm tài khoản
  if ((await activeJobOf(projectId)) !== null) {
    throw new ConflictError(
      "Project đang có job chạy bằng credential hiện tại — đổi sau khi job kết thúc",
    ).withTypeSlug(PROVISION_ERROR_SLUGS.credentialLocked);
  }
  const toStore =
    body.mode === "BYOC"
      ? byocToStore(body.credential, platform.capabilities)
      : managedToStore(body.provider, platform.capabilities);

  const id = randomUUID();
  const plaintext = Buffer.from(JSON.stringify(toStore.payload), "utf8");
  const envelope = (() => {
    try {
      return encryptCredential(plaintext, {
        credentialId: id,
        projectId,
        dekVersion: FIRST_DEK_VERSION,
      });
    } finally {
      plaintext.fill(0);
    }
  })();
  const fingerprint = fingerprintOf(toStore.identifier);

  const created = await repository.replaceActive(
    {
      id,
      projectId,
      provider: body.provider,
      mode: body.mode,
      authKind: toStore.authKind,
      region: body.region,
      ...envelope,
      fingerprint,
      createdById: user.sub,
    },
    auditEntry({
      action: "cloud.credential.set",
      targetType: "CloudCredential",
      targetId: id,
      // Chỉ metadata: audit không bao giờ mang giá trị bí mật hay định danh (§4.3)
      after: {
        provider: body.provider,
        mode: body.mode,
        authKind: toStore.authKind,
        region: body.region,
        fingerprint: fingerprint.slice(0, FINGERPRINT_SHOWN),
      },
      request,
    }),
  );
  return toView(created);
}

async function activeOrConflict(
  projectId: string,
): Promise<CredentialEnvelope> {
  const row = await repository.activeEnvelope(projectId);
  if (row === null) {
    throw new ConflictError(
      "Project chưa cấu hình cloud — lưu credential trước",
    ).withTypeSlug(CLOUD_ERROR_SLUGS.notConfigured);
  }
  return row;
}

/**
 * Credential bị CLOUD hoặc CẤU HÌNH từ chối (sai, bị thu hồi, cơ chế chưa bật) là câu trả
 * lời cho người dùng; lỗi mạng/giới hạn tốc độ thì không — chúng là 503 để thử lại.
 */
const isRejection = (e: unknown): boolean =>
  isGatewayError(e) &&
  (e.errorClass === "permission" || e.errorClass === "configuration");

type Resolution =
  | { kind: "resolved"; credential: ResolvedCredential }
  | { kind: "rejected"; reason: string };

async function resolveOrReject(
  row: CredentialEnvelope,
  platform: CloudPlatform,
): Promise<Resolution> {
  try {
    return {
      kind: "resolved",
      credential: await resolveCredential(row, platform),
    };
  } catch (e) {
    if (isRejection(e)) return { kind: "rejected", reason: safeMessage(e) };
    throw new ServiceUnavailableError(
      `Không đổi được credential: ${safeMessage(e)}`,
    );
  }
}

/** Dùng credential ngắn hạn cho MỘT lời gọi adapter rồi huỷ nó, dù lời gọi ra sao */
async function withCredential<T>(
  credential: ResolvedCredential,
  use: (c: ResolvedCredential) => Promise<T>,
): Promise<T> {
  try {
    return await use(credential);
  } finally {
    credential.dispose();
  }
}

export async function validate(
  projectId: string,
  platform: CloudPlatform,
  now: () => Date = () => new Date(),
): Promise<CloudValidationWire> {
  const row = await activeOrConflict(projectId);
  const adapter = requireAdapter(platform, row.provider, row.region);
  const checkedAt = now();
  const resolution = await resolveOrReject(row, platform);
  if (resolution.kind === "rejected") {
    return {
      valid: false,
      reason: resolution.reason,
      checkedAt: checkedAt.toISOString(),
    };
  }
  const result = await withCredential(resolution.credential, (c) =>
    adapter.validateCredential(c),
  );
  if (result.status !== "SUCCESS" || result.data === undefined) {
    throw new ServiceUnavailableError(
      result.message ?? "Adapter không kiểm được credential",
    );
  }
  if (result.data.valid) await repository.markValidated(row.id, checkedAt);
  return {
    valid: result.data.valid,
    reason: result.data.reason ?? null,
    checkedAt: checkedAt.toISOString(),
  };
}

export async function preflight(
  projectId: string,
  platform: CloudPlatform,
  now: () => Date = () => new Date(),
): Promise<CloudPreflightWire> {
  const row = await activeOrConflict(projectId);
  const adapter = requireAdapter(platform, row.provider, row.region);
  const resolution = await resolveOrReject(row, platform);
  if (resolution.kind === "rejected") {
    throw new UnprocessableError(
      `Credential không dùng được: ${resolution.reason}`,
    ).withTypeSlug(CLOUD_ERROR_SLUGS.credentialInvalid);
  }
  const result = await withCredential(resolution.credential, (c) =>
    adapter.preflightPermissions(c),
  );
  if (result.status !== "SUCCESS" || result.data === undefined) {
    throw new ServiceUnavailableError(
      result.message ?? "Adapter không kiểm được quyền",
    );
  }
  return { ...result.data, checkedAt: now().toISOString() };
}
