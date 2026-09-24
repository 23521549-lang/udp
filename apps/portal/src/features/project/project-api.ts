import {
  auditListResponseWire,
  memberListResponseWire,
  memberResponseWire,
  projectDetailResponseWire,
  projectListResponseWire,
  projectResponseWire,
  sdkKeyCreatedResponseWire,
  sdkKeyListResponseWire,
  sdkKeyResponseWire,
  type ProjectRoleWire,
  type ResourceQuotaWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

export interface CreateProjectInput {
  name: string;
  creationMode: "CREATE_NEW" | "IMPORT_EXISTING";
  languageRuntime: string;
  repoUrl?: string;
}

const p = (projectId: string) => `/projects/${projectId}`;

export const projectApi = {
  list: () => api(projectListResponseWire, "/projects"),
  get: (projectId: string) => api(projectDetailResponseWire, p(projectId)),
  create: (body: CreateProjectInput) =>
    api(projectDetailResponseWire, "/projects", { method: "POST", body }),
  updateQuota: (
    projectId: string,
    resourceQuota: Required<ResourceQuotaWire>,
  ) =>
    api(projectResponseWire, `${p(projectId)}/quota`, {
      method: "PATCH",
      body: { resourceQuota },
    }),
  updateTtl: (projectId: string, expiresAt: string | null) =>
    api(projectResponseWire, `${p(projectId)}/ttl`, {
      method: "PATCH",
      body: { expiresAt },
    }),
  remove: (projectId: string) => api(null, p(projectId), { method: "DELETE" }),

  audit: (projectId: string, query: Record<string, string | undefined>) =>
    api(auditListResponseWire, `${p(projectId)}/audit`, { query }),

  members: (projectId: string) =>
    api(memberListResponseWire, `${p(projectId)}/members`),
  addMember: (
    projectId: string,
    body: { email: string; projectRole: Exclude<ProjectRoleWire, "OWNER"> },
    idempotencyKey: string,
  ) =>
    api(memberResponseWire, `${p(projectId)}/members`, {
      method: "POST",
      body,
      idempotencyKey,
    }),
  updateMember: (
    projectId: string,
    userId: string,
    projectRole: Exclude<ProjectRoleWire, "OWNER">,
  ) =>
    api(memberResponseWire, `${p(projectId)}/members/${userId}`, {
      method: "PATCH",
      body: { projectRole },
    }),
  removeMember: (projectId: string, userId: string) =>
    api(null, `${p(projectId)}/members/${userId}`, { method: "DELETE" }),
  transferOwnership: (projectId: string, userId: string) =>
    api(memberResponseWire, `${p(projectId)}/transfer-ownership`, {
      method: "POST",
      body: { userId },
    }),

  sdkKeys: (projectId: string, envId: string) =>
    api(sdkKeyListResponseWire, `${p(projectId)}/environments/${envId}/keys`),
  createSdkKey: (
    projectId: string,
    envId: string,
    body: { keyType: "SERVER" | "CLIENT"; label: string | null },
  ) =>
    api(
      sdkKeyCreatedResponseWire,
      `${p(projectId)}/environments/${envId}/keys`,
      {
        method: "POST",
        body,
      },
    ),
  revokeSdkKey: (projectId: string, envId: string, keyId: string) =>
    api(
      sdkKeyResponseWire,
      `${p(projectId)}/environments/${envId}/keys/${keyId}`,
      { method: "DELETE" },
    ),
};
