import {
  capabilitiesOf,
  type CloudPlatform,
} from "../../src/modules/cloud/cloud.platform.js";
import type { DomainAdapterRegistry } from "../../src/modules/domain/domain-adapter.registry.js";

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
