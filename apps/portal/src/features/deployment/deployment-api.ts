import {
  deployAcceptedResponseWire,
  deploymentLatestResponseWire,
  deploymentListResponseWire,
  deploymentLogsResponseWire,
  doraResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

const p = (projectId: string) => `/projects/${projectId}`;

export const deploymentApi = {
  list: (projectId: string, envId: string) =>
    api(deploymentListResponseWire, `${p(projectId)}/deployments`, {
      query: { envId, limit: 50 },
    }),
  /** [Plan #45] Lần deploy gần nhất của một env — thẻ Tổng quan (§10.6) */
  latest: (projectId: string, envId: string) =>
    api(deploymentLatestResponseWire, `${p(projectId)}/deployments/latest`, {
      query: { envId },
    }),
  /** [Plan #45] Mọi sự kiện của một lần deploy */
  logs: (projectId: string, deploymentId: string) =>
    api(
      deploymentLogsResponseWire,
      `${p(projectId)}/deployments/${deploymentId}/logs`,
    ),
  dora: (projectId: string, envId: string, days: number) =>
    api(doraResponseWire, `${p(projectId)}/metrics/dora`, {
      query: { envId, days },
    }),
  /** §8.3: deploy chờ duyệt (`autoDeploy = false`) ⇒ chạy; S1 trả ngay, việc áp ở hàng đợi */
  approve: (projectId: string, deploymentId: string) =>
    api(
      deployAcceptedResponseWire,
      `${p(projectId)}/deployments/${deploymentId}/approve`,
      { method: "POST" },
    ),
};
