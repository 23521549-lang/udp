import { MetricsHook, SpanHook } from "@openfeature/open-telemetry-hooks";
import { OpenFeature } from "@openfeature/server-sdk";
import { UDPFeatureFlagProvider } from "@udp/openfeature-provider";

/**
 * Feature flag của UDP — thiết lập MỘT LẦN, trước khi tạo ứng dụng (Golden Path §11.1).
 *
 * - `UDP_FLAG_HOST`, `UDP_SDK_KEY`: địa chỉ Service 2 và SERVER key của environment (trang SDK keys
 *   trên Portal). Không truyền projectId: key đã mang project và environment.
 * - Service 2 không tới được hay khoá bị từ chối: ứng dụng VẪN khởi động và trả giá trị mặc định
 *   trong code; provider tiếp tục thử nền và phát READY khi có cấu hình.
 * - Hook gắn nhãn `ff` do provider TỰ gắn — không có bước cài hook nào ở đây.
 */
export async function startFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Span và counter chuẩn OTel semconv — có tác dụng khi ứng dụng cấu hình OpenTelemetry SDK
  OpenFeature.addHooks(new SpanHook(), new MetricsHook());

  const host = env["UDP_FLAG_HOST"];
  const sdkKey = env["UDP_SDK_KEY"];
  if (host === undefined || sdkKey === undefined) {
    console.warn(
      "Thiếu UDP_FLAG_HOST hoặc UDP_SDK_KEY — mọi flag trả giá trị mặc định trong code",
    );
    return;
  }
  try {
    await OpenFeature.setProviderAndWait(
      new UDPFeatureFlagProvider({ host, sdkKey, logger: console }),
    );
  } catch (err) {
    console.warn("UDP flags chưa sẵn sàng — chạy với giá trị mặc định", err);
  }
}
