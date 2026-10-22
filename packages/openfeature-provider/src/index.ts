/**
 * `udp-openfeature` (§6.8) [v4.7] — provider OpenFeature cho SERVER key, chạy TRONG ứng dụng của khách.
 * Middleware đo lường ở subpath `udp-openfeature/metrics` (prom-client là peer tuỳ chọn).
 *
 * Trong kho, package này mang một tên có scope riêng của workspace, cố ý không cài được từ registry nào;
 * tên phát hành khai đúng một chỗ, ở `publishConfig.name` (§6.8).
 *
 * Provider web (CLIENT key) không nằm ở đây: dùng `@openfeature/ofrep-web-provider`
 * chuẩn trỏ tới `/ofrep` của Service 2 (ADR-03).
 *
 * Chỉ xuất bề mặt ứng dụng khách dùng. Transport, parser SSE, cache và tham số
 * nội bộ là chi tiết hiện thực (test import thẳng từ `src/`) — không thành cam
 * kết semver khi đóng gói (#22).
 */
export { UDPFeatureFlagProvider, type UDPProviderOptions } from "./provider.js";
export {
  requestStore,
  UDPRequestLabelHook,
  type RequestLabels,
} from "./labels.js";
