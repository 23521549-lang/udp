import type { AdminOrphanRow } from "./admin-api";

/**
 * [Plan #58 UX-33] Lối sang console của cloud để tìm và xoá tay một tài nguyên mồ côi. Azure có id tài nguyên đầy đủ
 * nên mở thẳng trang của tài nguyên; GCP mở đúng project nằm trong id; AWS mở console ở đúng region, nơi người vận hành
 * dán id vừa sao chép vào ô tìm. Không đoán đường dẫn theo loại tài nguyên: sai một đường là một trang trắng.
 */
export function cloudConsoleUrl(
  r: Pick<AdminOrphanRow, "provider" | "region" | "providerId">,
): string {
  switch (r.provider) {
    case "AWS":
      return `https://console.aws.amazon.com/console/home?region=${encodeURIComponent(r.region)}`;
    case "AZURE":
      return r.providerId?.startsWith("/subscriptions/") === true
        ? `https://portal.azure.com/#@/resource${r.providerId}`
        : "https://portal.azure.com/";
    case "GCP": {
      const project = /^projects\/([^/]+)\//.exec(r.providerId ?? "")?.[1];
      return project === undefined
        ? "https://console.cloud.google.com/"
        : `https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(project)}`;
    }
  }
}
