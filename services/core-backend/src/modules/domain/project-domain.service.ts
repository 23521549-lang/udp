import type { Request } from "express";
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  UnprocessableError,
} from "@udp/http";
import {
  DOMAIN_ERROR_SLUGS,
  type DomainTargetState,
  type PutDomainsBody,
} from "@udp/shared-types/domain-api";
import type {
  DomainDriftWire,
  DomainValidationWire,
  DomainVersionsWire,
  ProjectDomainWire,
  ProjectDomainsResponseWire,
  PutDomainsResponseWire,
} from "@udp/shared-types/wire";
import type { CloudProviderWire } from "@udp/shared-types/cloud-api";
import { prisma } from "../../core/db.js";
import { auditEntry } from "../audit/audit.service.js";
import { bindingsOfProject } from "../capability/capability-binding.repository.js";
import { activeMeta } from "../cloud/cloud.repository.js";
import { driftRecordOf } from "../day2/domain-config.repository.js";
import type { EnqueueJob } from "../provisioning/provisioning.service.js";
import { applyToRunning } from "./domain-apply.service.js";
import type { DomainAdapterRegistry } from "./domain-adapter.registry.js";
import * as store from "./domain-config.store.js";
import { resolveKept, sealSecrets } from "./tool-secrets.js";
import {
  cloudIssues,
  resolveTarget,
  validateTarget,
  validationView,
  type ResolvedTarget,
} from "./domain-target.js";

/**
 * Domain của một project (Plan #27, Plan #30): đọc, kiểm trạng thái đích, lưu cả tập. Project
 * nháp hay lỗi lưu thẳng vào bảng (§8.1); project ĐANG chạy nhận job `DOMAIN_APPLY` và bảng
 * đổi theo từng thay đổi đã áp (§8.2). Project đang triển khai: 409 kèm slug.
 */

const PROJECT_NOT_FOUND = "Không tìm thấy project";

export async function list(
  projectId: string,
): Promise<ProjectDomainsResponseWire> {
  const state = await store.projectDomains(projectId);
  if (state === null) throw new NotFoundError(PROJECT_NOT_FOUND);
  return state.view;
}

async function rowOrNotFound(projectId: string, domainType: string) {
  const row = await store.domainRow(projectId, domainType);
  if (row === null) throw new NotFoundError(`Không có domain ${domainType}`);
  return row;
}

export async function one(
  projectId: string,
  domainType: string,
): Promise<ProjectDomainWire> {
  return (await rowOrNotFound(projectId, domainType)).view;
}

/**
 * Kết quả quét drift gần nhất (QĐ-6), đọc từ `last_error` do `scanDomainDrift` ghi. "Chưa
 * triển khai" khác "sạch": domain chưa từng lên cluster thì không có gì để trôi.
 */
export async function drift(
  projectId: string,
  domainType: string,
): Promise<DomainDriftWire> {
  const { view, lastError } = await rowOrNotFound(projectId, domainType);
  if (view.status === null || view.status === "PENDING") {
    return { verdict: "NOT_DEPLOYED", message: null, at: null };
  }
  const record = driftRecordOf(lastError);
  if (record === null) return { verdict: "CLEAN", message: null, at: null };
  return {
    verdict: record.adapterResult === "DRIFTED" ? "DRIFTED" : "SCAN_FAILED",
    message: record.message,
    at: record.at === "" ? null : record.at,
  };
}

/**
 * [v4.11, Plan #45] Bản đang chạy và bản máy chủ đang nạp (§9 `GET …/versions`, §8.6, §10.13) —
 * không chạm cluster. Registry nạp MỘT bản mỗi tool, nên có tối đa một bản nâng được; kèm
 * capability đổi gì so với binding ĐANG lưu, và `validate` trên trạng thái đang lưu với adapter
 * của registry — đúng phép `declarationsAfterUpgrade` mà worker chạy trước khi chạm cluster.
 */
export async function versions(
  projectId: string,
  domainType: string,
  registry: DomainAdapterRegistry,
): Promise<DomainVersionsWire> {
  const { view } = await rowOrNotFound(projectId, domainType);
  const adapter =
    view.selectedTool === null
      ? undefined
      : registry.get(domainType, view.selectedTool);
  if (!view.isEnabled || adapter === undefined) {
    throw new ConflictError(
      `Domain ${domainType} không chạy trên cluster của project`,
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.notRunning);
  }
  const base = {
    domainType,
    toolId: adapter.toolId,
    current: view.adapterVersion,
  };
  if (view.adapterVersion === adapter.version) {
    return { ...base, available: [] };
  }

  const row = await prisma.domainConfig.findUniqueOrThrow({
    where: { projectId_domainType: { projectId, domainType } },
    select: { id: true },
  });
  const running = new Map(
    (await bindingsOfProject(prisma, projectId))
      .filter((b) => b.domainConfigId === row.id)
      .map((b) => [b.capabilityId, b.schemaVersion]),
  );
  const provides = adapter.capabilities.provides.map((p) => ({
    id: p.id,
    version: p.version,
  }));
  const next = new Map(provides.map((p) => [p.id as string, p.version]));
  const changes = [...new Set([...running.keys(), ...next.keys()])]
    .sort()
    .map((capabilityId) => ({
      capabilityId,
      from: running.get(capabilityId) ?? null,
      to: next.get(capabilityId) ?? null,
    }))
    .filter((c) => c.from !== c.to);

  const { domains, preferences } = await list(projectId);
  const stored: DomainTargetState = {
    domains: domains
      .filter((d) => d.isEnabled && d.selectedTool !== null)
      .map((d) => ({
        domainType: d.domainType,
        toolId: d.selectedTool ?? "",
        config: d.toolConfig ?? {},
      })),
    preferences,
  };
  return {
    ...base,
    available: [
      {
        version: adapter.version,
        provides,
        changes,
        validation: await validate(projectId, stored, registry),
      },
    ],
  };
}

/**
 * Giá trị giữ chỗ của bí mật ⇒ bản rõ của bí mật ĐÃ LƯU, chỉ khi domain vẫn dùng CÙNG tool:
 * đổi tool mà mang theo "giữ nguyên" là đem khoá của tool cũ cho tool mới.
 */
async function withKeptSecrets<T extends DomainTargetState>(
  projectId: string,
  state: T,
  registry: DomainAdapterRegistry,
): Promise<T> {
  const stored = new Map(
    (await store.storedToolConfigs(projectId)).map((r) => [r.domainType, r]),
  );
  return {
    ...state,
    domains: state.domains.map((d) => {
      const adapter = registry.get(d.domainType, d.toolId);
      if (adapter === undefined) return d;
      const previous = stored.get(d.domainType);
      const kept =
        previous !== undefined &&
        previous.selectedTool?.toLowerCase() === d.toolId.toLowerCase()
          ? previous.toolConfig
          : null;
      return {
        ...d,
        config: resolveKept(
          { schema: adapter.configSchema, projectId, domainType: d.domainType },
          d.config,
          kept,
        ),
      };
    }),
  };
}

/** Niêm phong bí mật của trạng thái đích — SAU khi đã kiểm bằng `configSchema` */
const sealed = (
  projectId: string,
  targets: readonly ResolvedTarget[],
): ResolvedTarget[] =>
  targets.map((t) => ({
    ...t,
    config: sealSecrets(
      {
        schema: t.adapter.configSchema,
        projectId,
        domainType: t.domainType,
      },
      t.config,
    ),
  }));

/** Cloud của credential đang dùng — `null` khi project chưa lưu credential */
async function projectCloud(
  projectId: string,
): Promise<CloudProviderWire | null> {
  return (await activeMeta(projectId))?.provider ?? null;
}

async function resolveAndValidate(
  projectId: string,
  state: DomainTargetState,
  registry: DomainAdapterRegistry,
): Promise<{ targets: ResolvedTarget[]; view: DomainValidationWire }> {
  const targets = resolveTarget(
    state,
    registry,
    await store.catalogAvailability(),
  );
  const result = validateTarget(targets, state);
  const cyclic = result.errors.find((e) => e.code === "CYCLIC_DEPENDENCY");
  if (cyclic !== undefined) {
    // Chỉ xảy ra khi adapter khai báo sai (§5.3) — lỗi của mã, không của người dùng
    throw new Error(`đồ thị capability có vòng: ${cyclic.detail.join(" → ")}`);
  }
  const mismatched = cloudIssues(
    targets,
    registry,
    await projectCloud(projectId),
  );
  return {
    targets,
    view: validationView(result, targets, registry, mismatched),
  };
}

export async function validate(
  projectId: string,
  state: DomainTargetState,
  registry: DomainAdapterRegistry,
): Promise<DomainValidationWire> {
  return (
    await resolveAndValidate(
      projectId,
      await withKeptSecrets(projectId, state, registry),
      registry,
    )
  ).view;
}

export async function put(
  projectId: string,
  body: PutDomainsBody,
  request: Request,
  registry: DomainAdapterRegistry,
  enqueue: EnqueueJob,
): Promise<{ status: 200 | 202; body: PutDomainsResponseWire }> {
  const resolved = await resolveAndValidate(
    projectId,
    await withKeptSecrets(projectId, body, registry),
    registry,
  );
  const { view } = resolved;
  // Từ đây trở đi mọi chỗ ghi (bảng, payload job, audit) chỉ thấy bản niêm phong
  const targets = sealed(projectId, resolved.targets);
  const first = view.errors[0];
  if (first !== undefined) {
    const error = new UnprocessableError(
      `${first.subject}: ${first.detail.join(", ")}`,
      undefined,
      first.code,
    );
    throw first.suggestedAction === undefined
      ? error
      : error.withSuggestedAction(first.suggestedAction);
  }

  // Project đang chạy: đích đi vào job DOMAIN_APPLY, bảng giữ thứ ĐANG chạy (Plan #30 QĐ-1)
  const current = await store.projectDomains(projectId);
  if (current === null) throw new NotFoundError(PROJECT_NOT_FOUND);
  if (current.status === "ACTIVE") {
    const job = await applyToRunning({
      projectId,
      body,
      targets,
      request,
      enqueue,
    });
    if (job === "stale-version") {
      throw new OptimisticLockError(
        "Cấu hình domain vừa được người khác lưu",
        await list(projectId),
      );
    }
    return { status: 202, body: { ...(await list(projectId)), job } };
  }

  const outcome = await store.replaceDomains({
    projectId,
    lastKnownVersion: body.lastKnownDomainSetVersion,
    targets,
    preferences: body.preferences,
    audit: auditEntry({
      action: "domain.config.set",
      targetType: "Project",
      targetId: projectId,
      after: {
        enabled: targets.map((t) => `${t.domainType}:${t.adapter.toolId}`),
        preferences: body.preferences,
      },
      request,
    }),
  });
  if (outcome === "stale-version") {
    throw new OptimisticLockError(
      "Cấu hình domain vừa được người khác lưu",
      await list(projectId),
    );
  }
  if (outcome === "not-draft") {
    throw new ConflictError(
      "Project đang có lượt triển khai chạy: lưu cấu hình domain sau khi lượt đó xong",
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.needsApplyJob);
  }
  return { status: 200, body: { ...(await list(projectId)), job: null } };
}
