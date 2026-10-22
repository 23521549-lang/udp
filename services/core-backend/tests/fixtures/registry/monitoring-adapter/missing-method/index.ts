/**
 * [v4.10] Adapter fixture THIẾU `teardown` — dùng cho ca âm của type guard 7 + 6.
 *
 * Nó cố tình KHÔNG khai kiểu `DomainAdapter`: nếu khai, `tsc` sẽ chặn ngay và ca âm này
 * không dựng được. Điều cần kiểm ở đây là guard LÚC CHẠY, vì adapter thật có thể đến từ
 * một tệp `.js` đã build mà TypeScript không soát.
 */
const adapter = {
  domainType: "MONITORING",
  toolId: "missing-method",
  version: "1.0.0",
  scope: "cluster",
  capabilities: { provides: [], requires: [] },
  configSchema: { parse: (v: unknown) => v },
  deploy: () => Promise.resolve({ status: "SUCCESS" }),
  configure: () => Promise.resolve({ status: "SUCCESS" }),
  upgrade: () => Promise.resolve({ status: "SUCCESS" }),
  detectDrift: () => Promise.resolve({ status: "SUCCESS" }),
  onDependencyChanged: () => Promise.resolve({ status: "SUCCESS" }),
  healthcheck: () => Promise.resolve({ status: "SUCCESS" }),
};

export default adapter;
