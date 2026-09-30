import { NotFoundError, redact } from "@udp/http";
import type {
  DeploymentLogsWire,
  PlatformDoraWire,
} from "@udp/shared-types/wire";
import {
  computeDora,
  dailyOutcomes,
  groupDeployments,
  type DeploymentView,
  type DoraResult,
} from "./deployment.dora.js";
import * as repository from "./deployment.repository.js";
import type {
  DoraQuery,
  LatestDeploymentQuery,
  ListDeploymentsQuery,
} from "./deployment.types.js";

/**
 * Nhìn tối đa bấy nhiêu SỰ KIỆN gần nhất để gom thành deployment. Một lần deploy có
 * 2–3 sự kiện, nên 30 deployment cần ~90; trần 500 đủ cho `limit` 100 mà không kéo cả
 * bảng append-only về.
 */
const MAX_EVENTS = 500;

/**
 * [v4.11, Plan #45] Cửa sổ sự kiện cho deploy GẦN NHẤT: một lần deploy có 2–4 sự kiện, và các lần
 * deploy xen nhau chỉ khi hai pipeline cùng chạy — 50 là dư mà không kéo 500 hàng cho một thẻ.
 */
const LATEST_EVENTS = 50;

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

/** [v4.11, Plan #45] Deploy gần nhất của một env (§9 `GET /deployments/latest`, §10.6) */
export async function latest(
  projectId: string,
  query: LatestDeploymentQuery,
): Promise<DeploymentView | null> {
  if ((await repository.environmentOf(projectId, query.envId)) === null) {
    throw new NotFoundError(ENV_NOT_FOUND);
  }
  const rows = await repository.recentEvents(
    projectId,
    query.envId,
    LATEST_EVENTS,
  );
  return groupDeployments(rows, 1)[0] ?? null;
}

/**
 * [v4.11, Plan #45] Nhật ký của MỘT lần deploy (§9 `GET /deployments/:deploymentId/logs`): mọi sự
 * kiện theo thời gian, `detail` là `metadata` đã qua `redact()` — bên ghi là S1 và S3, nhưng
 * `metadata` của webhook mang chữ do CI gửi lên, nên không tin là sạch.
 */
export async function logs(
  projectId: string,
  deploymentId: string,
): Promise<DeploymentLogsWire> {
  const rows = await repository.eventsOfDeployment(projectId, deploymentId);
  if (rows.length === 0) {
    throw new NotFoundError("Không tìm thấy lần deploy này trong project");
  }
  return {
    deploymentId,
    events: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      occurredAt: r.occurredAt.toISOString(),
      triggeredBy: r.triggeredBy,
      workloadName: r.workloadName,
      imageTag: r.imageTag,
      commitSha: r.commitSha,
      pipelineId: r.pipelineId,
      detail:
        typeof r.metadata === "object" &&
        r.metadata !== null &&
        !Array.isArray(r.metadata)
          ? redact(r.metadata as Record<string, unknown>)
          : null,
    })),
  };
}

const DAY_MS = 86_400_000;

/**
 * [v4.11, Plan #56] E10 (§14) của CẢ nền tảng — trang Bằng chứng của Bảng điều khiển. Mỗi project: env production
 * đầu tiên, năm chỉ số qua CÙNG `computeDora` với `/metrics/dora` (không định nghĩa thứ hai); cộng kết cục deploy
 * theo ngày trên mọi env production. Hai truy vấn cho cả nền tảng, cộng một truy vấn cho mỗi project có ROLLBACK.
 *
 * Cửa sổ canh theo NGÀY UTC: từ đầu ngày cách hôm nay `days − 1` ngày tới hết hôm nay. Cửa sổ cuộn (`now − days`)
 * chạm `days + 1` ngày lịch — biểu đồ "7 ngày" thành 8 cột, hai cột đầu cuối là nửa ngày — và `computeDora` chia tần
 * suất cho đúng độ dài cửa sổ, nên canh ở đây giữ hai con số khớp nhau.
 */
export async function platformDora(
  days: number,
  now: Date = new Date(),
): Promise<PlatformDoraWire> {
  const today = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const from = new Date(today - (days - 1) * DAY_MS);
  const window = { from, to: new Date(today + DAY_MS) };
  const envs = await repository.productionEnvironments();
  const events = await repository.eventsInEnvironments(
    envs.map((e) => e.id),
    window.from,
    window.to,
  );
  const byEnv = new Map<string, typeof events>();
  for (const e of events) {
    const list = byEnv.get(e.environmentId) ?? [];
    list.push(e);
    byEnv.set(e.environmentId, list);
  }
  const projects = await Promise.all(
    envs.map(async (env) => {
      const own = byEnv.get(env.id) ?? [];
      const restored = own.flatMap((e) =>
        e.eventType === "ROLLBACK" && e.restoresDeploymentId !== null
          ? [e.restoresDeploymentId]
          : [],
      );
      const successAt = await repository.successTimesOf(
        env.projectId,
        restored,
      );
      return {
        projectId: env.projectId,
        projectName: env.projectName,
        environmentName: env.name,
        dora: {
          ...computeDora(own, window, successAt),
          environmentId: env.id,
        },
      };
    }),
  );
  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      days,
    },
    projects: projects.sort(
      (a, b) =>
        b.dora.deployments - a.dora.deployments ||
        a.projectName.localeCompare(b.projectName),
    ),
    daily: dailyOutcomes(events, window),
  };
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
  const from = new Date(now.getTime() - query.days * DAY_MS);
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
