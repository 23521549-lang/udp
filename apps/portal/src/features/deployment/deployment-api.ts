import {
  deployAcceptedResponseWire,
  deploymentListResponseWire,
  doraResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

const p = (projectId: string) => `/projects/${projectId}`;

export const deploymentApi = {
  list: (projectId: string, envId: string) =>
    api(deploymentListResponseWire, `${p(projectId)}/deployments`, {
      query: { envId, limit: 50 },
    }),
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
