/**
 * `@udp/test-support` — thứ mà test của NHIỀU service cùng cần [v4.4], để không
 * có hai bản chép trôi khỏi nhau: dựng một service thật bằng tiến trình con, cổng
 * rảnh, và fixture flag sẵn sàng cho canary. Chỉ là devDependency; không service
 * nào import nó ở `src/`.
 *
 * [v4.7] Entry này nạp `fixture.ts`, tức `env` của `@udp/config` (validate `.env`
 * lúc nạp). Test không cần database import subpath: `@udp/test-support/net`,
 * `/service`, `/i26`, `/flag-target`, `/fixture`.
 */
export { freePort } from "./net.js";
export {
  FLAG_SERVICE,
  startFlagService,
  startService,
  type RunningService,
  type ServiceSpec,
  type StartOptions,
} from "./service.js";
export {
  newFlagTarget,
  type FlagTarget,
  type FlagTargetOptions,
} from "./flag-target.js";
export {
  createActiveFlag,
  createScratchProject,
  disposeProject,
  internalCall,
  issueSdkKey,
  newSdkKeyToken,
  sdkKeyData,
  sha256,
  stableOwner,
  type HttpTarget,
  type ScratchProject,
  type SdkKeySpec,
  type SdkKeyType,
} from "./fixture.js";
export {
  I26_EXAMPLES,
  I26_NAME,
  I26_USERS,
  i26Arbitraries,
  i26SegmentConditions,
  type I26RuleSpec,
  type I26VariantKey,
} from "./i26.js";
