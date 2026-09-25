import type {
  DomainTargetState,
  PutDomainsBody,
} from "@udp/shared-types/domain-api";
import {
  domainCatalogResponseWire,
  domainDriftResponseWire,
  domainValidationResponseWire,
  projectDomainResponseWire,
  projectDomainsResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/** Domain (Plan #27): catalog dựng từ registry, cấu hình của project, drift */
const d = (projectId: string) => `/projects/${projectId}/domains`;

export const domainApi = {
  catalog: () => api(domainCatalogResponseWire, "/domains/catalog"),
  list: (projectId: string) => api(projectDomainsResponseWire, d(projectId)),
  one: (projectId: string, type: string) =>
    api(projectDomainResponseWire, `${d(projectId)}/${type}`),
  drift: (projectId: string, type: string) =>
    api(domainDriftResponseWire, `${d(projectId)}/${type}/drift`),
  validate: (projectId: string, body: DomainTargetState) =>
    api(domainValidationResponseWire, `${d(projectId)}/validate`, {
      method: "POST",
      body,
    }),
  put: (projectId: string, body: PutDomainsBody) =>
    api(projectDomainsResponseWire, d(projectId), { method: "PUT", body }),
};
