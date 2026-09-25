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
  ProjectDomainWire,
  ProjectDomainsResponseWire,
} from "@udp/shared-types/wire";
import { auditEntry } from "../audit/audit.service.js";
import { driftRecordOf } from "../day2/domain-config.repository.js";
import type { DomainAdapterRegistry } from "./domain-adapter.registry.js";
import * as store from "./domain-config.store.js";
import {
  resolveTarget,
  validateTarget,
  validationView,
  type ResolvedTarget,
} from "./domain-target.js";

/**
 * Domain của một project (Plan #27): đọc, kiểm trạng thái đích, và lưu cả tập cho project
 * NHÁP (§8.1). Áp cấu hình cho project đã triển khai cần job `DOMAIN_APPLY` — chưa có hàng
 * đợi nên route nói thẳng điều đó (409 kèm slug), không lưu một trạng thái không ai áp.
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

async function resolveAndValidate(
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
  return { targets, view: validationView(result, targets, registry) };
}

export async function validate(
  state: DomainTargetState,
  registry: DomainAdapterRegistry,
): Promise<DomainValidationWire> {
  return (await resolveAndValidate(state, registry)).view;
}

export async function put(
  projectId: string,
  body: PutDomainsBody,
  request: Request,
  registry: DomainAdapterRegistry,
): Promise<ProjectDomainsResponseWire> {
  const { targets, view } = await resolveAndValidate(body, registry);
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
      "Project đã rời trạng thái nháp: áp cấu hình domain cần hàng đợi triển khai, chưa có",
    ).withTypeSlug(DOMAIN_ERROR_SLUGS.needsApplyJob);
  }
  return list(projectId);
}
