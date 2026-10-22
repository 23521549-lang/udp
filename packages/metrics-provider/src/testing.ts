/**
 * Điểm vào cho TEST của các service (`@udp/metrics-provider/testing`).
 *
 * Tách khỏi entry chính để mã chạy thật không kéo theo nguồn metrics giả — và
 * để một import nhầm `FakeMetricsProvider` vào `src/` của service lộ ra ngay
 * trong review bằng chính đường dẫn.
 */
export { FakeMetricsProvider, branchKeyOf } from "./fake.js";
export type { FakeBranch, FakeCall, FakeSeriesFn } from "./fake.js";
