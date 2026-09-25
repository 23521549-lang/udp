import type {
  DomainTargetState,
  DomainUpgradeBody,
  PutDomainsBody,
} from "@udp/shared-types/domain-api";
import {
  domainCatalogResponseWire,
  domainDriftResponseWire,
  domainValidationResponseWire,
  jobResponseWire,
  projectDomainResponseWire,
  projectDomainsResponseWire,
  putDomainsResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/** Domain (Plan #27, #30): catalog, cấu hình của project, drift, quét ngay, nâng cấp */
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
  /** Project đang chạy: 202 kèm job DOMAIN_APPLY; project nháp: `job: null` */
  put: (projectId: string, body: PutDomainsBody) =>
    api(putDomainsResponseWire, d(projectId), { method: "PUT", body }),
  scanNow: (projectId: string, type: string) =>
    api(domainDriftResponseWire, `${d(projectId)}/${type}/drift`, {
      method: "POST",
    }),
  upgrade: (projectId: string, type: string, body: DomainUpgradeBody) =>
    api(jobResponseWire, `${d(projectId)}/${type}/upgrade`, {
      method: "POST",
      body,
    }),
};
