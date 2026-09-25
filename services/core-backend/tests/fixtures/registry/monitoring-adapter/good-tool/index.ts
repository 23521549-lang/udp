import { z } from "zod";
import type { DomainAdapter } from "@udp/adapter-core";
import type { MetricsSourceDeclaration } from "@udp/metrics-provider";

/**
 * [v4.10] Adapter FIXTURE — đủ 7 phương thức + 6 thuộc tính, và không làm gì cả.
 *
 * Nó sống dưới `tests/` nên registry của sản phẩm (gốc `src/modules`) **không bao giờ
 * thấy** nó. Đó là cách một fixture không lẫn vào danh mục thật, và là lý do
 * `DomainAdapter` không cần một cờ `isFixture` — thêm cờ đó là nới một interface đã đóng
 * băng (7 + 6) vì lý do của test.
 */
const adapter: DomainAdapter = {
  domainType: "MONITORING",
  toolId: "good-tool",
  version: "1.0.0",
  scope: "cluster",
  capabilities: {
    provides: [{ id: "metrics.query", version: "2.0.0" }],
    requires: [],
  },
  configSchema: z.object({}).passthrough(),
  deploy: () => Promise.resolve({ status: "SUCCESS", data: [] }),
  configure: () => Promise.resolve({ status: "SUCCESS" }),
  upgrade: () => Promise.resolve({ status: "SUCCESS" }),
  detectDrift: () =>
    Promise.resolve({ status: "SUCCESS", data: { drifted: false } }),
  onDependencyChanged: () => Promise.resolve({ status: "SUCCESS" }),
  healthcheck: () => Promise.resolve({ status: "SUCCESS", data: { healthy: true } }),
  teardown: () => Promise.resolve({ status: "SUCCESS" }),
};

export default adapter;

/** §5.4: adapter `provides: metrics.query` phải kèm nguồn metrics — registry kiểm lúc nạp */
export const metricsSource: MetricsSourceDeclaration = {
  kind: "prometheus",
  of: (_config, binding) => ({
    kind: "prometheus",
    baseUrl: binding.endpoint ?? "http://good-tool:9090",
    inCluster: true,
  }),
};
