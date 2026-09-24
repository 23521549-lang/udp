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
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

const f = (projectId: string) => `/projects/${projectId}/flags`;

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
  list: (projectId: string, envId: string, tz: string) =>
    api(flagListResponseWire, f(projectId), {
      query: { envId, include: "stats", tz, limit: 100 },
    }),
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
