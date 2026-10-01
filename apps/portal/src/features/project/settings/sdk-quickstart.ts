import type { SdkKeyWire } from "@udp/shared-types/wire";

/**
 * [Plan #58 UX-13] Mã của ba bước cài SDK (cài gói, khởi tạo với key và địa chỉ, hỏi một flag) — THUẦN, test được.
 * Tên gói và API là của thật: `@udp/openfeature-provider` (packages/openfeature-provider), `udp-openfeature`
 * (sdks/python), và provider OFREP chuẩn của OpenFeature cho key client (ADR-03, §6.1: UDP không viết SDK trình
 * duyệt riêng). Key đọc từ biến môi trường `UDP_SDK_KEY`, cùng tên với Golden Path: bí mật không nằm trong mã.
 */
export type SdkLang = "node" | "python" | "browser";

/** Key server đánh giá tại chỗ (Node, Python); key client hỏi qua OFREP từ trình duyệt */
export const LANGS_OF: Record<SdkKeyWire["keyType"], readonly SdkLang[]> = {
  SERVER: ["node", "python"],
  CLIENT: ["browser"],
};

/**
 * Địa chỉ của dịch vụ flag: `/sdk` và `/ofrep` đi chung origin công khai với Portal (Ingress duy nhất,
 * deploy/k8s/overlays/vm/ingress.yaml), nên địa chỉ đúng là chính origin người dùng đang mở.
 */
export const flagHost = (): string => window.location.origin;

/** Key flag mẫu trong đoạn mã; chữ ở bước 3 bảo người dùng thay bằng key của họ */
export const SAMPLE_FLAG = "my-flag";

export function quickstartCode(
  lang: SdkLang,
  host: string,
): readonly [install: string, init: string, evaluate: string] {
  switch (lang) {
    case "node":
      return [
        "npm install @openfeature/server-sdk @udp/openfeature-provider",
        [
          'import { OpenFeature } from "@openfeature/server-sdk";',
          'import { UDPFeatureFlagProvider } from "@udp/openfeature-provider";',
          "",
          "await OpenFeature.setProviderAndWait(",
          "  new UDPFeatureFlagProvider({",
          `    host: "${host}",`,
          "    sdkKey: process.env.UDP_SDK_KEY,",
          "  }),",
          ");",
        ].join("\n"),
        [
          "const client = OpenFeature.getClient();",
          `const on = await client.getBooleanValue("${SAMPLE_FLAG}", false, {`,
          "  targetingKey: user.id,",
          "});",
        ].join("\n"),
      ];
    case "python":
      return [
        "pip install openfeature-sdk udp-openfeature",
        [
          "import os",
          "from openfeature import api",
          "from udp_openfeature import UDPFeatureFlagProvider",
          "",
          "api.set_provider_and_wait(",
          `    UDPFeatureFlagProvider("${host}", os.environ["UDP_SDK_KEY"])`,
          ")",
        ].join("\n"),
        [
          "from openfeature.evaluation_context import EvaluationContext",
          "",
          "client = api.get_client()",
          "on = client.get_boolean_value(",
          `    "${SAMPLE_FLAG}", False, EvaluationContext(targeting_key=user_id)`,
          ")",
        ].join("\n"),
      ];
    case "browser":
      return [
        "npm install @openfeature/web-sdk @openfeature/ofrep-web-provider",
        [
          'import { OpenFeature } from "@openfeature/web-sdk";',
          'import { OFREPWebProvider } from "@openfeature/ofrep-web-provider";',
          "",
          "await OpenFeature.setProviderAndWait(",
          // [Plan #60 H7] Đã đối chiếu với gói phát hành: @openfeature/ofrep-web-provider 0.4.3 (ofrep-core 2.3.0)
          // khai `headers?: [string, string][]`; Service 2 đòi `Authorization: Bearer <key client>` (sdk-key.guard)
          "  new OFREPWebProvider({",
          `    baseUrl: "${host}",`,
          '    headers: [["Authorization", "Bearer " + UDP_CLIENT_KEY]],',
          "  }),",
          ");",
          "await OpenFeature.setContext({ targetingKey: user.id });",
        ].join("\n"),
        `const on = OpenFeature.getClient().getBooleanValue("${SAMPLE_FLAG}", false);`,
      ];
  }
}
