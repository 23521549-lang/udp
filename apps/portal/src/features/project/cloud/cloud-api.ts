import type {
  CloudProviderWire,
  PutCloudBody,
} from "@udp/shared-types/cloud-api";
import {
  cloudPreflightResponseWire,
  cloudResponseWire,
  cloudSetupResponseWire,
  cloudValidationResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../../lib/http";

/** Bước cloud của project (§9, Plan #26): năm route, mọi response kiểm bằng schema dây */
const c = (projectId: string) => `/projects/${projectId}/cloud`;

export const cloudApi = {
  get: (projectId: string) => api(cloudResponseWire, c(projectId)),
  setup: (projectId: string, provider: CloudProviderWire) =>
    api(cloudSetupResponseWire, `${c(projectId)}/setup`, {
      query: { provider },
    }),
  put: (projectId: string, body: PutCloudBody) =>
    api(cloudResponseWire, c(projectId), { method: "PUT", body }),
  validate: (projectId: string) =>
    api(cloudValidationResponseWire, `${c(projectId)}/validate`, {
      method: "POST",
    }),
  preflight: (projectId: string) =>
    api(cloudPreflightResponseWire, `${c(projectId)}/preflight`, {
      method: "POST",
    }),
};
