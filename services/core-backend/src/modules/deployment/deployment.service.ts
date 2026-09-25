import { NotFoundError } from "@udp/http";
import {
  computeDora,
  groupDeployments,
  type DeploymentView,
  type DoraResult,
} from "./deployment.dora.js";
import * as repository from "./deployment.repository.js";
import type { DoraQuery, ListDeploymentsQuery } from "./deployment.types.js";

/**
 * Nhìn tối đa bấy nhiêu SỰ KIỆN gần nhất để gom thành deployment. Một lần deploy có
 * 2–3 sự kiện, nên 30 deployment cần ~90; trần 500 đủ cho `limit` 100 mà không kéo cả
 * bảng append-only về.
 */
const MAX_EVENTS = 500;

const ENV_NOT_FOUND = "Không tìm thấy environment trong project này";

export async function list(
  projectId: string,
  query: ListDeploymentsQuery,
): Promise<DeploymentView[]> {
  if ((await repository.environmentOf(projectId, query.envId)) === null) {
    throw new NotFoundError(ENV_NOT_FOUND);
  }
  const rows = await repository.recentEvents(
    projectId,
    query.envId,
    MAX_EVENTS,
  );
  return groupDeployments(rows, query.limit);
}

export async function dora(
  projectId: string,
  query: DoraQuery,
  now: Date = new Date(),
): Promise<DoraResult & { environmentId: string | null }> {
  let envId = query.envId;
  if (envId !== undefined) {
    if ((await repository.environmentOf(projectId, envId)) === null) {
      throw new NotFoundError(ENV_NOT_FOUND);
    }
  } else {
    envId = (await repository.productionEnvOf(projectId))?.id;
  }
  const from = new Date(now.getTime() - query.days * 86_400_000);
  if (envId === undefined) {
    return {
      ...computeDora([], { from, to: now }, new Map()),
      environmentId: null,
    };
  }
  const events = await repository.eventsBetween(projectId, envId, from, now);
  const restored = events.flatMap((e) =>
    e.eventType === "ROLLBACK" && e.restoresDeploymentId !== null
      ? [e.restoresDeploymentId]
      : [],
  );
  const successAt = await repository.successTimesOf(projectId, restored);
  return {
    ...computeDora(events, { from, to: now }, successAt),
    environmentId: envId,
  };
}
