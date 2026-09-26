import type {
  CreateFlagFields,
  ReplaceRulesFields,
} from "@udp/shared-types/flag-api";
import { testerResultSchema } from "@udp/shared-types/flag-api";
import {
  bulkArchiveResponseWire,
  flagEnvResponseWire,
  flagEnvsResponseWire,
  flagListResponseWire,
  flagResponseWire,
  flagStatsViewResponseWire,
  rulesResponseWire,
  staleFlagsResponseWire,
  type FlagSummaryWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

const f = (projectId: string) => `/projects/${projectId}/flags`;

/**
 * [Plan #41 QĐ-5] Cỡ trang của Portal — máy chủ nhận tới 100, Portal không bao giờ xin quá 50 và
 * không bao giờ tải trọn danh sách: project vài trăm flag thì mỗi màn hình đọc đúng thứ nó hiện.
 */
export const FLAG_PAGE_SIZE = 50;

export interface FlagPageQuery {
  search?: string;
  status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  isEnabled?: boolean;
  offset?: number;
  limit?: number;
  /** Kèm số lượt đánh giá 7 ngày + sparkline 14 ngày (qua Service 2) — chỉ trang Flag cần */
  stats?: boolean;
}

/** Một trang `GET /flags` của MỘT env; `total` đếm theo cùng bộ lọc */
const flagPage = (
  projectId: string,
  envId: string,
  tz: string,
  query: FlagPageQuery = {},
) =>
  api(flagListResponseWire, f(projectId), {
    query: {
      envId,
      limit: Math.min(query.limit ?? FLAG_PAGE_SIZE, FLAG_PAGE_SIZE),
      offset: query.offset ?? 0,
      ...(query.stats === true ? { include: "stats", tz } : {}),
      ...(query.search === undefined || query.search === ""
        ? {}
        : { search: query.search }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.isEnabled === undefined
        ? {}
        : { isEnabled: String(query.isEnabled) }),
    },
  });

export interface UpdateFlagInput {
  lastKnownUpdatedAt: string;
  description?: string | null;
  lifecycleStatus?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  permanent?: boolean;
  confirmFlagKey?: string;
}

export interface UpdateEnvInput {
  isEnabled?: boolean;
  defaultVariantId?: string | null;
  confirmFlagKey?: string;
}

export const flagApi = {
  page: flagPage,
  /** Chỉ con số: một hàng (`limit=1`), đọc `total` — tổng quan và thanh số của trang Flag */
  count: async (
    projectId: string,
    envId: string,
    filter: Pick<FlagPageQuery, "status" | "isEnabled"> = {},
  ) => (await flagPage(projectId, envId, "UTC", { ...filter, limit: 1 })).total,
  get: (projectId: string, flagId: string) =>
    api(flagResponseWire, `${f(projectId)}/${flagId}`),
  create: (projectId: string, body: CreateFlagFields) =>
    api(flagResponseWire, f(projectId), { method: "POST", body }),
  update: (projectId: string, flagId: string, body: UpdateFlagInput) =>
    api(flagResponseWire, `${f(projectId)}/${flagId}`, {
      method: "PATCH",
      body,
    }),
  envs: (projectId: string, flagId: string) =>
    api(flagEnvsResponseWire, `${f(projectId)}/${flagId}/envs`),
  updateEnv: (
    projectId: string,
    flagId: string,
    envId: string,
    body: UpdateEnvInput,
  ) =>
    api(flagEnvResponseWire, `${f(projectId)}/${flagId}/envs/${envId}`, {
      method: "PATCH",
      body,
    }),
  rules: (projectId: string, flagId: string, envId: string) =>
    api(rulesResponseWire, `${f(projectId)}/${flagId}/envs/${envId}/rules`),
  replaceRules: (
    projectId: string,
    flagId: string,
    envId: string,
    body: ReplaceRulesFields,
  ) =>
    api(rulesResponseWire, `${f(projectId)}/${flagId}/envs/${envId}/rules`, {
      method: "PUT",
      body,
    }),
  evaluate: (
    projectId: string,
    flagId: string,
    envId: string,
    context: Record<string, unknown>,
  ) =>
    api(testerResultSchema, `${f(projectId)}/${flagId}/evaluate`, {
      method: "POST",
      body: { envId, context },
    }),
  stats: (
    projectId: string,
    flagId: string,
    envId: string,
    days: number,
    tz: string,
  ) =>
    api(flagStatsViewResponseWire, `${f(projectId)}/${flagId}/stats`, {
      query: { envId, days, granularity: "day", tz },
    }),
  stale: (projectId: string, category: string | undefined) =>
    api(staleFlagsResponseWire, `${f(projectId)}/stale`, {
      query: { category, limit: 50 },
    }),
  bulkArchive: (
    projectId: string,
    flags: { flagId: string; lastKnownUpdatedAt: string }[],
    confirmProjectName: string,
  ) =>
    api(bulkArchiveResponseWire, `${f(projectId)}/bulk-archive`, {
      method: "POST",
      body: { flags, confirmProjectName },
    }),
};
