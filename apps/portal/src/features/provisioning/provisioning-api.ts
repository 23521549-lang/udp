import type { ProvisionBody } from "@udp/shared-types/provisioning-api";
import {
  costResponseWire,
  jobDetailResponseWire,
  jobListResponseWire,
  jobResponseWire,
  provisionPreviewResponseWire,
} from "@udp/shared-types/wire";
import { api, API_BASE } from "../../lib/http";

/** Provisioning của project (Plan #28): xem trước, chạy, theo dõi, hủy */
const p = (projectId: string) => `/projects/${projectId}`;

export const provisioningApi = {
  preview: (projectId: string) =>
    api(provisionPreviewResponseWire, `${p(projectId)}/preview`),
  /** Chi phí THỰC từ OpenCost/Kubecost (Plan #38) — khác ước tính của `preview` */
  cost: (projectId: string, days: number) =>
    api(costResponseWire, `${p(projectId)}/cost`, { query: { days } }),
  provision: (projectId: string, body: ProvisionBody, idempotencyKey: string) =>
    api(jobResponseWire, `${p(projectId)}/provision`, {
      method: "POST",
      body,
      idempotencyKey,
    }),
  jobs: (projectId: string) => api(jobListResponseWire, `${p(projectId)}/jobs`),
  job: (projectId: string, jobId: string) =>
    api(jobDetailResponseWire, `${p(projectId)}/jobs/${jobId}`),
  cancel: (projectId: string, jobId: string) =>
    api(jobResponseWire, `${p(projectId)}/jobs/${jobId}/cancel`, {
      method: "POST",
    }),
  /** URL của luồng SSE — EventSource tự gửi cookie cùng origin */
  streamUrl: (projectId: string, jobId: string) =>
    `${API_BASE}${p(projectId)}/jobs/${jobId}/stream`,
};
