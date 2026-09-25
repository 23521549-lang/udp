import {
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
};
