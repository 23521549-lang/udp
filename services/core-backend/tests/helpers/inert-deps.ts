import {
  capabilitiesOf,
  type CloudPlatform,
} from "../../src/modules/cloud/cloud.platform.js";
import type { ProvisioningRuntime } from "../../src/core/app-deps.js";
import type { DomainAdapterRegistry } from "../../src/modules/domain/domain-adapter.registry.js";
import type { RepoSourceFactory } from "../../src/modules/golden-path/repo-source.js";
import { UnprocessableError } from "@udp/http";

/**
 * Phụ thuộc "trơ" cho test không đụng tới phần đó của `AppDeps` — mọi lời gọi tới chúng
 * là lỗi của chính test, không phải một giá trị giả trả về im lặng.
 */

export const inertCloudPlatform: CloudPlatform = {
  capabilities: capabilitiesOf({ MANAGED_CLOUDS: [] }, null),
  adapterFor: () => null,
  exchange: () => Promise.reject(new Error("test này không dùng cloud")),
};

const EMPTY_REGISTRY: DomainAdapterRegistry = {
  get: () => undefined,
  all: () => [],
};

/** Registry không có adapter nào — catalog vẫn trả đủ hàng của bảng, tool rỗng */
export const noDomainAdapters = (): Promise<DomainAdapterRegistry> =>
  Promise.resolve(EMPTY_REGISTRY);

/** Không dải egress, không hàng đợi: `POST /provision` bị chặn với lý do rõ ràng */
export const inertProvisioning: ProvisioningRuntime = {
  egressCidrs: [],
  enqueue: null,
  enqueueDeploy: null,
  withCluster: null,
  scanDrift: null,
};

/** Không nguồn repo: route quét trả 422 rõ ràng thay vì gọi mạng thật (Plan #48) */
export const noRepoSource: RepoSourceFactory = () => {
  throw new UnprocessableError("test: không có nguồn repo");
};
