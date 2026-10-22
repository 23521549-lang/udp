/**
 * `@udp/cloud-adapters` — Cloud Adapter thật (Plan #26).
 *
 * `.` là lõi dùng chung: cổng trung tính, kế hoạch theo cloud, lõi điều phối. Mỗi cloud
 * thêm subpath riêng của mình khi có hiện thực.
 */
export { GatewayError, isGatewayError, safeMessage } from "./core/gateway.js";
export type {
  CloudGateway,
  CreateRequest,
  GatewayErrorClass,
  PermissionCheck,
} from "./core/gateway.js";
export { CONTROL_PLANE_SERVICE_ACCOUNTS, planProblems } from "./core/plan.js";
export type {
  PricingTable,
  ProviderPlan,
  StepContext,
  StepSpec,
  TagCodec,
} from "./core/plan.js";
export { createPlannedAdapter } from "./core/planned-adapter.js";
export type {
  PlannedAdapterOptions,
  WaitReadyOptions,
} from "./core/planned-adapter.js";
