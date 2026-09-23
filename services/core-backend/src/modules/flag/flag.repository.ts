import type { FlagLifecycleStatus, Prisma } from "@udp/db";
import { prisma } from "../../core/db.js";
import type {
  FlagDetail,
  FlagEnvState,
  FlagSummary,
  ListFlagsQuery,
  RuleView,
  RulesView,
} from "./flag.types.js";

/**
 * Service 1 ĐỌC bảng flag (§1.2: READ_ONLY) để hiển thị và để kiểm quyền SỞ
 * HỮU trước khi nhờ Service 2 ghi — S2 không biết env-config thuộc project nào.
 * Mọi câu đọc ở đây đều lọc theo `projectId` của URL.
 */

const envStateSelect = {
  id: true,
  isEnabled: true,
  defaultVariantId: true,
  isTracked: true,
  updatedAt: true,
  environment: { select: { id: true, name: true, isProduction: true } },
  _count: { select: { rules: true } },
} satisfies Prisma.FlagEnvConfigSelect;

type EnvStateRow = Prisma.FlagEnvConfigGetPayload<{
  select: typeof envStateSelect;
}>;

const toEnvState = (row: EnvStateRow): FlagEnvState => ({
  environment: row.environment,
  configId: row.id,
  isEnabled: row.isEnabled,
  defaultVariantId: row.defaultVariantId,
  isTracked: row.isTracked,
  ruleCount: row._count.rules,
  updatedAt: row.updatedAt.toISOString(),
});

export async function list(
  projectId: string,
  query: ListFlagsQuery,
): Promise<FlagSummary[]> {
  const rows = await prisma.featureFlag.findMany({
    where: {
      projectId,
      ...(query.status === undefined ? {} : { lifecycleStatus: query.status }),
      ...(query.search === undefined
        ? {}
        : {
            OR: [
              { key: { contains: query.search, mode: "insensitive" } },
              { description: { contains: query.search, mode: "insensitive" } },
            ],
          }),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: query.limit,
    skip: query.offset,
    select: {
      id: true,
      key: true,
      flagType: true,
      description: true,
      lifecycleStatus: true,
      activatedAt: true,
      updatedAt: true,
      // Trạng thái ở MỘT env chỉ khi được hỏi; không hỏi thì không đọc hàng nào
      envConfigs: {
        where: query.envId === undefined ? {} : { environmentId: query.envId },
        take: query.envId === undefined ? 0 : 1,
        select: envStateSelect,
      },
    },
  });
  return rows.map((row) => {
    const env = row.envConfigs[0];
    return {
      id: row.id,
      key: row.key,
      flagType: row.flagType,
      description: row.description,
      lifecycleStatus: row.lifecycleStatus,
      activatedAt: row.activatedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      ...(query.envId === undefined || env === undefined
        ? {}
        : {
            env: {
              configId: env.id,
              isEnabled: env.isEnabled,
              isTracked: env.isTracked,
              ruleCount: env._count.rules,
            },
          }),
    };
  });
}

export async function detail(
  projectId: string,
  flagId: string,
): Promise<FlagDetail | undefined> {
  const row = await prisma.featureFlag.findFirst({
    where: { id: flagId, projectId },
    select: {
      id: true,
      key: true,
      flagType: true,
      description: true,
      lifecycleStatus: true,
      stickinessAttribute: true,
      defaultVariantId: true,
      permanent: true,
      activatedAt: true,
      createdAt: true,
      updatedAt: true,
      variants: {
        select: { id: true, key: true, value: true },
        orderBy: { key: "asc" },
      },
      envConfigs: {
        select: envStateSelect,
        orderBy: { environment: { rank: "asc" } },
      },
    },
  });
  if (row === null) return undefined;
  return {
    id: row.id,
    key: row.key,
    flagType: row.flagType,
    description: row.description,
    lifecycleStatus: row.lifecycleStatus,
    stickinessAttribute: row.stickinessAttribute,
    defaultVariantId: row.defaultVariantId,
    permanent: row.permanent,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    variants: row.variants,
    envs: row.envConfigs.map(toEnvState),
  };
}

/** Flag của project — đủ để quyết định quyền và xác nhận ở `flag.service.update` */
export async function flagOf(
  projectId: string,
  flagId: string,
): Promise<
  | {
      key: string;
      lifecycleStatus: FlagLifecycleStatus;
      stickinessAttribute: string;
    }
  | undefined
> {
  const row = await prisma.featureFlag.findFirst({
    where: { id: flagId, projectId },
    select: { key: true, lifecycleStatus: true, stickinessAttribute: true },
  });
  return row ?? undefined;
}

export async function environmentBelongsTo(
  projectId: string,
  envId: string,
): Promise<boolean> {
  const row = await prisma.environment.findFirst({
    where: { id: envId, projectId },
    select: { id: true },
  });
  return row !== null;
}

/** Environment của project — để gắn TÊN vào `byEnv` của stats (§3.1) */
export const environmentsOf = (
  projectId: string,
): Promise<{ id: string; name: string; isProduction: boolean }[]> =>
  prisma.environment.findMany({
    where: { projectId },
    select: { id: true, name: true, isProduction: true },
    orderBy: { rank: "asc" },
  });

/**
 * [v4.9] Id của những flag trong `flagIds` THẬT SỰ thuộc project — MỘT câu cho cả
 * lô archive.
 *
 * `WHERE id IN (…) AND project_id = $p` là đúng khuôn chống R05: id con luôn được
 * kiểm cùng project trong CÙNG câu. Bên gọi so số lượng để trả 404 cho CẢ request
 * trước khi ghi flag nào (V16) — archive một nửa lô rồi mới phát hiện id lạ là
 * thứ không hoàn tác được.
 */
export const flagIdsInProject = async (
  projectId: string,
  flagIds: readonly string[],
): Promise<Set<string>> =>
  new Set(
    (
      await prisma.featureFlag.findMany({
        where: { projectId, id: { in: [...flagIds] } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

/**
 * Tên project — chỉ dùng để so `confirmProjectName` của lô archive (V16).
 *
 * Đọc ở đây chứ không gọi sang `modules/project`: một chuỗi để so xác nhận không
 * đáng một phụ thuộc module-tới-module, và câu này không bao giờ rời file này.
 */
export const projectNameOf = async (
  projectId: string,
): Promise<string | undefined> =>
  (
    await prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true },
    })
  )?.name;

/** Trạng thái của MỘT env-config — response của PATCH env, cùng hình với `envs[]` của GET */
export async function envStateOf(
  configId: string,
): Promise<FlagEnvState | undefined> {
  const row = await prisma.flagEnvConfig.findUnique({
    where: { id: configId },
    select: envStateSelect,
  });
  return row === null ? undefined : toEnvState(row);
}

export interface EnvTarget {
  configId: string;
  flagKey: string;
  isProduction: boolean;
}

/**
 * `(project, flag, environment)` ⇒ env-config — trong MỘT câu, chỉ khi cả ba
 * thuộc về nhau. Không thuộc ⇒ `undefined` ⇒ 404 TRƯỚC khi gọi Service 2 (D2).
 */
export async function envTargetOf(
  projectId: string,
  flagId: string,
  envId: string,
): Promise<EnvTarget | undefined> {
  const row = await prisma.flagEnvConfig.findFirst({
    where: {
      flagId,
      environmentId: envId,
      flag: { projectId },
      environment: { projectId },
    },
    select: {
      id: true,
      flag: { select: { key: true } },
      environment: { select: { isProduction: true } },
    },
  });
  return row === null
    ? undefined
    : {
        configId: row.id,
        flagKey: row.flag.key,
        isProduction: row.environment.isProduction,
      };
}

const ruleSelect = {
  id: true,
  priority: true,
  ruleType: true,
  condition: true,
  serve: true,
  description: true,
} satisfies Prisma.FlagTargetingRuleSelect;

const ruleViewOf = (row: {
  id: string;
  priority: number;
  ruleType: string;
  condition: unknown;
  serve: unknown;
  description: string | null;
}): RuleView => ({
  id: row.id,
  priority: row.priority,
  ruleType: row.ruleType,
  condition: row.condition,
  serve: row.serve,
  description: row.description,
});

/** `undefined` khi env-config vừa biến mất giữa lần kiểm sở hữu và lần đọc này */
export async function rulesOf(
  configId: string,
): Promise<RulesView | undefined> {
  const row = await prisma.flagEnvConfig.findUnique({
    where: { id: configId },
    select: {
      updatedAt: true,
      rules: { select: ruleSelect, orderBy: { priority: "asc" } },
    },
  });
  if (row === null) return undefined;
  return {
    updatedAt: row.updatedAt.toISOString(),
    rules: row.rules.map(ruleViewOf),
  };
}
