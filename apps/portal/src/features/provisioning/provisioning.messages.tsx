import type { ReactNode } from "react";
import { count, defineMessages } from "../../i18n";

/**
 * Chữ của trang Hạ tầng: xem trước và bắt đầu triển khai, tiến độ một lượt, lịch sử, chi phí thực tế.
 * Nhãn trạng thái, lý do chặn, mục chi phí dùng chung ở `provisioning-labels.messages.ts`.
 */
export const provisioningMessages = defineMessages({
  vi: {
    infra: {
      title: "Hạ tầng",
      lead: "Mạng, cluster và domain của project trên tài khoản cloud của bạn. Một cluster phục vụ mọi environment.",
      history: "Các lượt triển khai",
      started: "Bắt đầu",
      status: "Trạng thái",
      view: "Xem",
    },
    job: {
      progress: "Tiến độ triển khai",
      status: "Trạng thái",
      started: "Bắt đầu",
      updated: "Cập nhật",
      phases: "Các pha",
      phaseDone: "Xong: ",
      orphans: (n: number, names: string) =>
        `Còn ${String(n)} tài nguyên chưa dọn được: ${names}`,
      resources: "Tài nguyên cloud",
      name: "Tên",
      kind: "Loại",
      domains: "Domain",
      cancel: "Hủy triển khai",
      cancelTitle: "Hủy lượt triển khai này?",
      cancelDescription:
        "UDP dừng ở bước kế tiếp rồi xoá mọi tài nguyên đã dựng trên cloud của bạn.",
      cancelConfirm: "Hủy và dọn",
    },
    preview: {
      label: "Xem trước triển khai",
      cloud: "Cloud",
      cluster: "Cluster",
      nodes: (n: number, size: string) => `${String(n)} node cỡ ${size}`,
      duration: "Thời gian",
      minutes: (min: number, max: number) =>
        `Khoảng ${String(min)} đến ${String(max)} phút`,
      cost: "Chi phí ước tính mỗi tháng",
      item: "Mục",
      perMonth: "Mỗi tháng",
      total: "Tổng",
      pricing: (isEstimate: boolean, asOf: string) =>
        `${isEstimate ? "Ước tính" : "Giá"} theo bảng giá ngày ${asOf}; chi phí thật tính trên tài khoản cloud của bạn.`,
      buildOrder: "Thứ tự dựng",
      resourceOrder: "Thứ tự dựng tài nguyên",
      domainOrder: "Thứ tự cài domain",
      stage: (n: number, domains: ReactNode) => (
        <>
          Bậc {n}: {domains}
        </>
      ),
      blocked: "Chưa triển khai được",
      confirmCost: (amount: string) =>
        `Tôi đồng ý chi phí ước tính ${amount} mỗi tháng trên tài khoản cloud của mình`,
      sending: "Đang gửi…",
      start: "Bắt đầu triển khai",
    },
    cost: {
      title: "Chi phí thực tế",
      window: "Cửa sổ chi phí",
      days: (n: number) => `${String(n)} ngày`,
      notEnabled: "Chưa bật Cost Management",
      notEnabledHint:
        "Bật OpenCost hay Kubecost ở trang Domain để thấy chi phí theo environment.",
      table: "Chi phí theo environment",
      environment: "Environment",
      cpu: "CPU",
      ram: "RAM",
      storage: "Lưu trữ",
      network: "Mạng",
      total: "Tổng",
      footer: (days: number, provider: string) =>
        `Tổng ${String(days)} ngày, nguồn ${provider}`,
    },
  },
  en: {
    infra: {
      title: "Infrastructure",
      lead: "The project's network, cluster, and domains in your cloud account. One cluster serves every environment.",
      history: "Deployment runs",
      started: "Started",
      status: "Status",
      view: "View",
    },
    job: {
      progress: "Deployment progress",
      status: "Status",
      started: "Started",
      updated: "Updated",
      phases: "Phases",
      phaseDone: "Done: ",
      orphans: (n: number, names: string) =>
        `${count(n, "resource", "resources")} could not be cleaned up: ${names}`,
      resources: "Cloud resources",
      name: "Name",
      kind: "Type",
      domains: "Domains",
      cancel: "Cancel deployment",
      cancelTitle: "Cancel this deployment run?",
      cancelDescription:
        "UDP stops at the next step, then deletes every resource it created in your cloud.",
      cancelConfirm: "Cancel and clean up",
    },
    preview: {
      label: "Deployment preview",
      cloud: "Cloud",
      cluster: "Cluster",
      nodes: (n: number, size: string) =>
        `${count(n, "node", "nodes")} of size ${size}`,
      duration: "Estimated time",
      minutes: (min: number, max: number) =>
        `About ${String(min)} to ${String(max)} minutes`,
      cost: "Estimated monthly cost",
      item: "Item",
      perMonth: "Per month",
      total: "Total",
      pricing: (isEstimate: boolean, asOf: string) =>
        `${isEstimate ? "Estimated" : "Priced"} from the price list as of ${asOf}; actual costs are billed to your cloud account.`,
      buildOrder: "Build order",
      resourceOrder: "Resource build order",
      domainOrder: "Domain install order",
      stage: (n: number, domains: ReactNode) => (
        <>
          Stage {n}: {domains}
        </>
      ),
      blocked: "Cannot deploy yet",
      confirmCost: (amount: string) =>
        `I accept the estimated cost of ${amount} per month on my cloud account`,
      sending: "Sending…",
      start: "Start deployment",
    },
    cost: {
      title: "Actual cost",
      window: "Cost window",
      days: (n: number) => count(n, "day", "days"),
      notEnabled: "Cost Management is not enabled",
      notEnabledHint:
        "Enable OpenCost or Kubecost on the Domains page to see cost per environment.",
      table: "Cost per environment",
      environment: "Environment",
      cpu: "CPU",
      ram: "RAM",
      storage: "Storage",
      network: "Network",
      total: "Total",
      footer: (days: number, provider: string) =>
        `Total over ${count(days, "day", "days")}, source ${provider}`,
    },
  },
});
