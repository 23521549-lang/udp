import {
  rolloutActionResponseWire,
  rolloutListResponseWire,
  rolloutProbeResponseWire,
  rolloutResponseWire,
  type RolloutIntentActionWire,
} from "@udp/shared-types/wire";
import type {
  ControlModeWire,
  ServiceStrategy,
  TrafficMatch,
} from "@udp/shared-types/rollout";
import { api } from "../../lib/http";

const r = (projectId: string) => `/projects/${projectId}/rollouts`;

export interface CreateFlagRolloutInput {
  scope: "FLAG_LEVEL";
  envId: string;
  /** [Plan #46] BLUE_GREEN "không áp dụng" ở mức flag (§7.2) */
  strategy: "CANARY" | "ATTRIBUTE_SPLIT";
  flagEnvConfigId: string;
  targetingRuleId: string;
  targetVariantId: string;
  workloadName: string;
  stepPercent: number;
  stepIntervalSeconds: number;
  analysisIntervalSeconds: number;
  warmUpRequests: number;
  thresholds: {
    errorRate: number;
    latencyP99Ms: number;
    minErrors: number;
    maxConsecutiveBreaches: number;
  };
}

/**
 * [Plan #51] SERVICE_LEVEL (§7.2, §9): canary theo image — chọn workload và TAG mới; tool (Argo Rollouts/Flagger)
 * là của environment, không khai ở đây.
 */
export interface CreateServiceRolloutInput {
  scope: "SERVICE_LEVEL";
  envId: string;
  strategy: ServiceStrategy;
  controlMode: ControlModeWire;
  workloadName: string;
  imageTag: string;
  trafficMatch?: TrafficMatch;
  stepPercent: number;
  stepIntervalSeconds: number;
  analysisIntervalSeconds: number;
  warmUpRequests: number;
  thresholds: CreateFlagRolloutInput["thresholds"];
}

export const rolloutApi = {
  list: (projectId: string, envId: string) =>
    api(rolloutListResponseWire, r(projectId), {
      query: { envId, limit: 100 },
    }),
  active: (projectId: string) =>
    api(rolloutListResponseWire, r(projectId), {
      query: { status: "IN_PROGRESS", limit: 100 },
    }),
  get: (projectId: string, rolloutId: string) =>
    api(rolloutResponseWire, `${r(projectId)}/${rolloutId}`),
  act: (
    projectId: string,
    rolloutId: string,
    action: RolloutIntentActionWire,
  ) =>
    api(rolloutActionResponseWire, `${r(projectId)}/${rolloutId}/actions`, {
      method: "POST",
      body: { action },
    }),
  probe: (projectId: string, envId: string, workloadName: string) =>
    api(rolloutProbeResponseWire, `${r(projectId)}/probe`, {
      method: "POST",
      body: { envId, workloadName },
    }),
  create: (
    projectId: string,
    body: CreateFlagRolloutInput | CreateServiceRolloutInput,
    idempotencyKey: string,
  ) =>
    api(rolloutResponseWire, r(projectId), {
      method: "POST",
      body,
      idempotencyKey,
    }),
};
