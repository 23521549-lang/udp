/**
 * [v4.10] `@udp/adapter-core` — hợp đồng mà mọi adapter hiện thực (§4, §5).
 *
 * Vì sao là một package riêng chứ không nằm trong Service 1 như cây §3.1 vẽ: §3.1 mô tả
 * chỗ ADAPTER sống, không phải chỗ KIỂU sống, và bốn thứ buộc phải tách ra.
 *
 *  1. §13.2 đòi MỘT bộ test hợp đồng dùng cho mọi adapter, kể cả adapter do người ngoài
 *     nhóm viết ở kiểm soát (b) của E1. Một bộ test nằm trong `tests/` của một service
 *     thì người ngoài không import được.
 *  2. Runner phải kiểm được mà KHÔNG cần database, vì lưới khôi phục chạy 130 ô.
 *  3. `ResolvedCredential` bị `@udp/shared-types` tự cấm nhận (nó có hành vi), nên nó
 *     không có nhà nào khác.
 *  4. Package này KHÔNG khai `@udp/db`. Đó là cách giữ ma trận writer §1.2 bằng CẤU TRÚC
 *     thay vì bằng kỷ luật: một adapter không thể ghi thẳng vào database dù muốn.
 *
 * Bốn subpath: `.` (hợp đồng), `./runner` (cổng của runner), `./testing` (hiện thực giả
 * tất định), `./contract` (bộ test hợp đồng).
 */

export type {
  CloudAdapter,
  ClusterInfo,
  CostEstimate,
  CreatedResource,
  CreatedResourceKind,
  LookupOutcome,
  NetworkInfo,
  PreflightReport,
  ProvisionClusterParams,
  ProvisionNetworkParams,
  ResourceQuota,
  ResourceStep,
} from "./cloud.js";
export {
  CLOUD_ADAPTER_METHODS,
  CREATED_RESOURCE_KINDS,
  CONDITIONAL_TTL_TAG_KEY,
  expectedTagKeys,
  REQUIRED_TAG_KEYS,
  TEARDOWN_ORDER,
} from "./cloud.js";

export type {
  CloudAuthKind,
  CloudProvider,
  CredentialMode,
  ResolvedCredential,
} from "./credential.js";
export {
  CLOUD_PROVIDERS,
  CREDENTIAL_DISPOSED,
  SECRET_TO_STRING_FORBIDDEN,
  SecretBuffer,
} from "./credential.js";

export type {
  ClusterAccess,
  ClusterAccessMode,
  ControlPlaneIdentity,
  K8sReadVerb,
  K8sWriteVerb,
  KubernetesClient,
  ObjectRef,
  ReadOnlyClusterAccess,
  ReadOnlyKubernetesClient,
} from "./cluster.js";
export {
  IDENTITY_SERVICE_ACCOUNTS,
  K8S_READ_VERBS,
  K8S_WRITE_VERBS,
  readOnlyAccess,
} from "./cluster.js";

export type {
  AdapterFixture,
  CicdDomainAdapter,
  DomainAdapter,
  DomainAdapterContext,
  DomainToolConfig,
  PipelineStep,
  PipelineTemplateParams,
  ReadOnlyAdapterContext,
  WebhookDeployEvent,
} from "./domain.js";
export {
  DOMAIN_ADAPTER_METHODS,
  DOMAIN_ADAPTER_PROPERTIES,
  readOnlyContext,
} from "./domain.js";

export type {
  ProvisionedResourceRow,
  ProvisionStep,
  ResourceStatus,
} from "./ledger.js";
export {
  allowedSourcesOf,
  idempotencyKeyOf,
  parseIdempotencyKey,
  PROVISION_STEPS,
  RESOURCE_STATUSES,
  isLedgerTransitionAllowed,
  LEDGER_TRANSITIONS,
  LedgerMissingRowError,
  LedgerTransitionError,
  PROVISIONED_RESOURCE_ROW_FIELDS,
  PROVISIONED_RESOURCE_ROW_OMITTED,
} from "./ledger.js";

export type {
  CostEstimateProblem,
  ExpiryDecision,
  OrphanReport,
  PlannedUsage,
  ProjectExpiry,
  QuotaViolation,
} from "./guardrails.js";
export {
  classifyOrphans,
  EXPIRY_WARN_HOURS,
  expiryDecision,
  MANDATORY_COST_ITEMS,
  ORPHAN_HOURLY_USD,
  ORPHAN_PRICING_AS_OF,
  PRICING_MAX_AGE_DAYS,
  quotaViolations,
  validateCostEstimate,
} from "./guardrails.js";

export type {
  TeardownBatch,
  TeardownCloud,
  TeardownOutcome,
  WaitGoneResult,
} from "./teardown.js";
export {
  discoverK8sManaged,
  runTeardown,
  TEARDOWN_TIER_OF_KIND,
  teardownBatches,
  teardownTierOf,
  waitGone,
} from "./teardown.js";
