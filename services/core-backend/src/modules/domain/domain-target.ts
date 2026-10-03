import type { DomainAdapter } from "@udp/adapter-core";
import { UnprocessableError } from "@udp/http";
import type { CloudProviderWire } from "@udp/shared-types/cloud-api";
import {
  DOMAIN_ERROR_SLUGS,
  type DomainTargetState,
} from "@udp/shared-types/domain-api";
import type { DomainValidationWire } from "@udp/shared-types/wire";
import { satisfies } from "semver";
import { ZodError, type ZodIssue } from "zod";
import {
  adapterKey,
  flatRequirements,
  validateAndOrder,
  type ValidationResult,
} from "../capability/capability.resolver.js";
import type { DomainAdapterRegistry } from "./domain-adapter.registry.js";

/**
 * Trạng thái ĐÍCH của domain một project (Plan #27 QĐ-4): body ⇒ adapter đã nạp ⇒ config đã
 * parse bằng CHÍNH `configSchema` của tool ⇒ kết quả của `validateAndOrder` (không viết lại
 * luật nào). Thuần trên registry — không đọc database.
 */

export interface ResolvedTarget {
  domainType: string;
  adapter: DomainAdapter;
  /** Đã parse (có giá trị mặc định) — đúng thứ sẽ lưu vào `tool_config` */
  config: Record<string, unknown>;
}

/**
 * Domain/tool phải có trong registry VÀ domain phải đang dùng được trong catalog. Lỗi ở
 * đây là 422 kèm slug: tool lạ không phải lỗi định dạng của một ô nhập.
 */
export function resolveTarget(
  state: DomainTargetState,
  registry: DomainAdapterRegistry,
  available: ReadonlyMap<string, boolean>,
): ResolvedTarget[] {
  const issues: ZodIssue[] = [];
  const out: ResolvedTarget[] = [];
  state.domains.forEach((d, i) => {
    const adapter = registry.get(d.domainType, d.toolId);
    if (adapter === undefined || adapter.domainType !== d.domainType) {
      throw new UnprocessableError(
        `Không có tool ${d.toolId} cho domain ${d.domainType}`,
      ).withTypeSlug(DOMAIN_ERROR_SLUGS.unknownTool);
    }
    if (available.get(d.domainType) !== true) {
      throw new UnprocessableError(
        `Domain ${d.domainType} không còn dùng được`,
      ).withTypeSlug(DOMAIN_ERROR_SLUGS.unknownTool);
    }
    const parsed = adapter.configSchema.safeParse(d.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        issues.push({
          ...issue,
          path: ["domains", i, "config", ...issue.path],
        });
      }
      return;
    }
    out.push({
      domainType: d.domainType,
      adapter,
      config: parsed.data as Record<string, unknown>,
    });
  });

  const enabled = new Set(out.map((t) => adapterKey(t.adapter)));
  state.preferences.forEach((p, i) => {
    if (!enabled.has(p.providerToolId)) {
      issues.push({
        code: "custom",
        path: ["preferences", i, "providerToolId"],
        message: "tool này không được bật trong cấu hình",
      });
    }
  });

  // Cùng đường 400 mọi lỗi định dạng khác đi: `errorHandler` biến ZodError thành lỗi trường
  if (issues.length > 0) throw new ZodError(issues);
  return out;
}

export function validateTarget(
  targets: readonly ResolvedTarget[],
  state: DomainTargetState,
): ValidationResult {
  return validateAndOrder(
    targets.map((t) => ({
      domainType: t.adapter.domainType,
      toolId: t.adapter.toolId,
      capabilities: t.adapter.capabilities,
    })),
    state.preferences,
  );
}

type Issue = DomainValidationWire["errors"][number];

/**
 * `MISSING_CAPABILITY cap` ⇒ bật tool đầu tiên của registry cung cấp `cap` ở phiên bản thoả
 * ràng buộc của chính consumer (QĐ-5). Không có ⇒ không gợi ý: gợi ý một tool không thoả
 * là gửi người dùng vào một lỗi `VERSION_MISMATCH` kế tiếp.
 */
function enableSuggestion(
  consumerKey: string,
  capability: string,
  targets: readonly ResolvedTarget[],
  registry: DomainAdapterRegistry,
): Issue["suggestedAction"] {
  const consumer = targets.find((t) => adapterKey(t.adapter) === consumerKey);
  const constraint =
    consumer === undefined
      ? "*"
      : (flatRequirements(consumer.adapter).find((r) => r.id === capability)
          ?.constraint ?? "*");
  const provider = registry
    .all()
    .map((l) => l.adapter)
    .find((a) =>
      a.capabilities.provides.some(
        (p) => p.id === capability && satisfies(p.version, constraint),
      ),
    );
  return provider === undefined
    ? undefined
    : {
        type: "ENABLE_DOMAIN",
        domainType: provider.domainType,
        toolId: provider.toolId,
        capabilityId: capability,
      };
}

/**
 * Plan #37 QĐ-5: tool khai `cloud` (ACK, Config Connector, ASO) chỉ chạy trên cloud đó. Cloud của
 * project chưa biết (chưa lưu credential) ⇒ chưa kiểm được — lượt lưu credential và lượt
 * provisioning kiểm lại. Gợi ý: tool CÙNG domain chạy đúng cloud của project.
 */
export function cloudIssues(
  targets: readonly ResolvedTarget[],
  registry: DomainAdapterRegistry,
  cloud: CloudProviderWire | null,
): Issue[] {
  if (cloud === null) return [];
  const loaded = registry.all();
  return targets.flatMap((t): Issue[] => {
    const own = loaded.find((l) => l.adapter === t.adapter)?.cloud;
    if (own === undefined || own === cloud) return [];
    const sibling = loaded.find(
      (l) => l.adapter.domainType === t.adapter.domainType && l.cloud === cloud,
    );
    return [
      {
        code: "CLOUD_MISMATCH",
        subject: adapterKey(t.adapter),
        detail: [own, cloud],
        ...(sibling === undefined
          ? {}
          : {
              suggestedAction: {
                type: "SWITCH_TOOL",
                domainType: t.domainType,
                toolId: sibling.adapter.toolId,
              },
            }),
      },
    ];
  });
}

export function validationView(
  result: ValidationResult,
  targets: readonly ResolvedTarget[],
  registry: DomainAdapterRegistry,
  extra: readonly Issue[] = [],
): DomainValidationWire {
  return {
    valid: result.valid && extra.length === 0,
    errors: [
      ...result.errors.map((e): Issue => {
        const base = {
          code: e.code,
          subject: e.subject,
          detail: [...e.detail],
        };
        const cap = e.detail[0];
        if (e.code === "MISSING_CAPABILITY" && cap !== undefined) {
          const action = enableSuggestion(e.subject, cap, targets, registry);
          return action === undefined
            ? base
            : { ...base, suggestedAction: action };
        }
        if (e.code === "AMBIGUOUS_PROVIDER") {
          const [domainType] = (e.detail[0] ?? "").split(":");
          return {
            ...base,
            suggestedAction: {
              type: "CHOOSE_PROVIDER",
              domainType: (domainType ?? "").toUpperCase(),
              capabilityId: e.subject,
            },
          };
        }
        return base;
      }),
      ...extra,
    ],
    warnings: result.warnings.map((w) => ({
      code: w.code,
      subject: w.subject,
      detail: [...w.detail],
    })),
    deployOrder: extra.length === 0 ? result.order : null,
  };
}
