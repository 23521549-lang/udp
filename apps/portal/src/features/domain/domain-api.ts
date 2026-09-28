import type {
  DomainRetryBody,
  DomainTargetState,
  DomainUpgradeBody,
  PutDomainsBody,
} from "@udp/shared-types/domain-api";
import {
  cicdSecretResponseWire,
  cicdStatusResponseWire,
  domainCatalogResponseWire,
  domainDriftResponseWire,
  domainValidationResponseWire,
  domainVersionsResponseWire,
  jobResponseWire,
  pipelineTemplateResponseWire,
  projectDomainResponseWire,
  projectDomainsResponseWire,
  putDomainsResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/**
 * Domain (Plan #27, #30): catalog, cấu hình của project, drift, quét ngay, nâng cấp; riêng CI/CD
 * (Plan #36): webhook, sinh/xoay secret, template pipeline.
 */
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
  /** [Plan #45] Bản nâng được kèm capability đổi gì và validator nói gì (§10.13) */
  versions: (projectId: string, type: string) =>
    api(domainVersionsResponseWire, `${d(projectId)}/${type}/versions`),
  /** [Plan #45] Áp lại domain về cấu hình đang lưu — job DOMAIN_APPLY loại reapply */
  retry: (projectId: string, type: string, body: DomainRetryBody) =>
    api(jobResponseWire, `${d(projectId)}/${type}/retry`, {
      method: "POST",
      body,
    }),
  cicd: (projectId: string) =>
    api(cicdStatusResponseWire, `${d(projectId)}/CICD/webhook`),
  /** Giá trị rõ của secret CHỈ có trong response này — không vào cache query */
  rotateWebhookSecret: (projectId: string) =>
    api(cicdSecretResponseWire, `${d(projectId)}/CICD/webhook-secret`, {
      method: "POST",
    }),
  pipelineTemplate: (projectId: string) =>
    api(pipelineTemplateResponseWire, `${d(projectId)}/CICD/pipeline-template`),
};
