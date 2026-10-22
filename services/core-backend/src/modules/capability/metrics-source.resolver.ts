import { ServiceUnavailableError, UnprocessableError } from "@udp/http";
import type { MetricsSource } from "@udp/metrics-provider";
import { prisma } from "../../core/db.js";
import type { DomainAdapterRegistry } from "../domain/domain-adapter.registry.js";
import { openSecrets } from "../domain/tool-secrets.js";
import { bindingsOfProject } from "./capability-binding.repository.js";

/**
 * Nguồn metrics của MỘT environment (§5.4, Plan #31 AC-5): binding `metrics.query` đang sống
 * ⇒ adapter cung cấp nó ⇒ `metricsSource` adapter đã khai, trên cấu hình ĐÃ MỞ bí mật.
 *
 * Chọn binding theo đúng luật của lúc deploy: bản riêng của environment thắng bản
 * cluster-scoped, và `CapabilityPreference` quyết định khi có nhiều provider. Nhiều provider
 * mà không có lựa chọn là 422 `AMBIGUOUS_PROVIDER` — đoán một nguồn cho canary analysis là
 * đo nhầm chỗ. `null` khi project chưa có binding nào: đường `PROMETHEUS_URL` chung (§16).
 */

const CAPABILITY = "metrics.query";

export async function metricsSourceFor(args: {
  projectId: string;
  environmentId: string;
  registry: DomainAdapterRegistry;
}): Promise<MetricsSource | null> {
  return (await metricsBindingFor(args))?.source ?? null;
}

/**
 * [v4.11, Plan #53] Như `metricsSourceFor`, kèm KHOÁ của tool cung cấp nguồn (`providedBy`,
 * `"monitoring:prometheus-grafana"`) — trang Giám sát cần biết tool nào để chỉ đường mở nó.
 */
export async function metricsBindingFor(args: {
  projectId: string;
  environmentId: string;
  registry: DomainAdapterRegistry;
}): Promise<{ source: MetricsSource; providedBy: string } | null> {
  const { projectId, environmentId } = args;
  const [bindings, preference] = await Promise.all([
    bindingsOfProject(prisma, projectId),
    prisma.capabilityPreference.findUnique({
      where: {
        projectId_capabilityId: { projectId, capabilityId: CAPABILITY },
      },
      select: { providerToolId: true },
    }),
  ]);
  const rank = (environment: string | null | undefined): number =>
    environment == null ? 1 : environment === environmentId ? 2 : 0;
  const candidates = bindings
    .filter(
      (b) =>
        b.capabilityId === CAPABILITY &&
        rank(b.environmentId) > 0 &&
        (preference === null || b.providedBy === preference.providerToolId),
    )
    .sort((a, b) => rank(b.environmentId) - rank(a.environmentId));
  const providers = [...new Set(candidates.map((b) => b.providedBy))];
  if (providers.length > 1) {
    throw new UnprocessableError(
      `Nhiều nguồn cung cấp ${CAPABILITY} (${providers.join(", ")}) — chọn một trong cấu hình domain`,
      undefined,
      "AMBIGUOUS_PROVIDER",
    );
  }
  const chosen = candidates[0];
  if (chosen === undefined) return null;

  const loaded = args.registry.all().find((l) => l.key === chosen.providedBy);
  const row = await prisma.domainConfig.findUnique({
    where: { id: chosen.domainConfigId },
    select: { domainType: true, toolConfig: true },
  });
  if (loaded?.metricsSource === undefined || row === null) {
    throw new ServiceUnavailableError(
      `Nguồn metrics ${chosen.providedBy} không có trong registry đang chạy`,
    );
  }
  const stored =
    typeof row.toolConfig === "object" &&
    row.toolConfig !== null &&
    !Array.isArray(row.toolConfig)
      ? (row.toolConfig as Record<string, unknown>)
      : {};
  // Mở bí mật TRONG bộ nhớ, kiểm bằng chính configSchema — khoá không rời tiến trình này
  const parsed = loaded.adapter.configSchema.safeParse(
    openSecrets({ projectId, domainType: row.domainType }, stored),
  );
  if (!parsed.success) {
    throw new ServiceUnavailableError(
      `Cấu hình của ${chosen.providedBy} không còn khớp schema của adapter`,
    );
  }
  const endpoint = chosen.endpoint ?? undefined;
  return {
    source: loaded.metricsSource.of(
      parsed.data as Record<string, unknown>,
      endpoint === undefined ? {} : { endpoint },
    ),
    providedBy: chosen.providedBy,
  };
}
