import type { ArchitectureWire } from "@udp/shared-types/wire";
import type { ReactNode } from "react";
import type { Tone } from "../../components/StatusLabel";
import { count, defineMessages, plural } from "../../i18n";
import { formatNumber } from "../../lib/format";

type WorkloadEvent =
  ArchitectureWire["environments"][number]["workloads"][number]["lastEvent"];

/** Chữ của trang Kiến trúc, sơ đồ, lưới sức khoẻ domain và phán quyết sức khoẻ của `architecture-model.ts` */
export const architectureMessages = defineMessages({
  vi: {
    health: {
      notDeployed: "Chưa triển khai",
      drifted: "Lệch cấu hình",
      scanFailed: "Chưa kiểm được lệch cấu hình",
      healthy: "Ổn định",
    },
    grid: {
      label: "Sức khoẻ domain",
      detectedAt: (time: string) => `Phát hiện lúc ${time}`,
    },
    diagram: {
      noCloud: "Chưa kết nối cloud",
      network: "Mạng",
      noNetwork: "Chưa dựng mạng",
      noCluster: "Chưa có cluster",
      cluster: (id: ReactNode) => <>Cluster {id}</>,
      clusterTools: "Công cụ cấp cluster theo thứ tự deploy",
      outsideOrder: "Ngoài thứ tự deploy",
      unordered: "Ngoài thứ tự",
      tier: (n: number) => `Bậc ${formatNumber(n)}`,
      production: "Production",
      productionHidden: "production",
      noWorkloads: "Chưa có workload nào deploy qua UDP.",
      workloadsIn: (env: string) => `Workload ở ${env}`,
      noTag: "không tag",
      namespaceTools: (namespace: string) =>
        `Công cụ trong namespace ${namespace}`,
      workload: {
        DEPLOY_PENDING: "Chờ duyệt",
        DEPLOY_START: "Đang deploy",
        DEPLOY_SUCCESS: "Đã deploy",
        DEPLOY_FAILURE: "Deploy lỗi",
        ROLLBACK: "Đã rollback",
      } satisfies Record<WorkloadEvent, string>,
    },
    page: {
      title: "Kiến trúc",
      lead: "Hạ tầng và công cụ UDP đã dựng cho project, lồng theo cách chúng chứa nhau. Mũi tên chỉ từ công cụ cần tới công cụ cung cấp.",
      tools: (_n: number) => "công cụ",
      environments: (_n: number) => "environment",
      workloads: (_n: number) => "workload",
      emptyTitle: "Chưa có gì để vẽ",
      emptyBody:
        "Sơ đồ vẽ hạ tầng UDP dựng cho project, nên cần cloud và domain trước. Kết nối cloud và chọn domain; sơ đồ hiện ra ngay khi có một trong hai.",
      emptyCloud: "Kết nối cloud",
      emptyDomains: "Chọn domain",
      invalid: (link: ReactNode) => (
        <>
          Tổ hợp domain đang bật chưa qua kiểm tra, nên chưa có thứ tự deploy và
          chưa có cạnh. {link}
        </>
      ),
      invalidLink: "Xem lỗi ở trang Domain",
      summary: (total: number, h: Record<Tone, number>, updated: string) => {
        const parts = [`${formatNumber(h.ok)} ổn định`];
        if (h.running > 0)
          parts.push(`${formatNumber(h.running)} đang chạy việc`);
        if (h.warn > 0) parts.push(`${formatNumber(h.warn)} cần xem`);
        if (h.error > 0) parts.push(`${formatNumber(h.error)} lỗi`);
        if (h.unknown > 0)
          parts.push(`${formatNumber(h.unknown)} chưa triển khai`);
        return `${formatNumber(total)} công cụ: ${parts.join(", ")}. Cập nhật ${updated}.`;
      },
      edgeList: (n: number) => `Phụ thuộc dạng danh sách (${formatNumber(n)})`,
      edge: (from: ReactNode, capability: ReactNode, to: ReactNode) => (
        <>
          {from} cần {capability} từ {to}
        </>
      ),
    },
    panel: {
      close: "Đóng",
      tool: "Tool",
      status: "Trạng thái",
      drift: "Cấu hình trên cluster",
      scope: "Phạm vi",
      scopeGone: "Máy chủ không còn nạp tool này",
      scopeCluster: "Cả cluster",
      scopeNamespace: "Mỗi environment",
      order: "Thứ tự deploy",
      noOrder: "Chưa có",
      provides: "Cung cấp",
      providesNone: "Không cung cấp capability nào cho tool khác.",
      needs: "Cần",
      needsNone: "Không phụ thuộc tool nào.",
      needsFrom: (capability: ReactNode, from: ReactNode) => (
        <>
          {capability} từ {from}
        </>
      ),
      usedBy: "Được dùng bởi",
      usedByNone: "Chưa tool nào dùng capability của nó.",
      usedByItem: (user: ReactNode, capability: ReactNode) => (
        <>
          {user} dùng {capability}
        </>
      ),
      openDomain: "Mở trang domain",
    },
  },
  en: {
    health: {
      notDeployed: "Not deployed",
      drifted: "Drifted",
      scanFailed: "Drift check failed",
      healthy: "Healthy",
    },
    grid: {
      label: "Domain health",
      detectedAt: (time: string) => `Detected at ${time}`,
    },
    diagram: {
      noCloud: "No cloud connected",
      network: "Network",
      noNetwork: "Network not provisioned",
      noCluster: "No cluster yet",
      cluster: (id: ReactNode) => <>Cluster {id}</>,
      clusterTools: "Cluster-level tools in deploy order",
      outsideOrder: "Outside the deploy order",
      unordered: "Unordered",
      tier: (n: number) => `Stage ${formatNumber(n)}`,
      production: "Production",
      productionHidden: "production",
      noWorkloads: "No workloads deployed through UDP yet.",
      workloadsIn: (env: string) => `Workloads in ${env}`,
      noTag: "no tag",
      namespaceTools: (namespace: string) => `Tools in namespace ${namespace}`,
      workload: {
        DEPLOY_PENDING: "Awaiting approval",
        DEPLOY_START: "Deploying",
        DEPLOY_SUCCESS: "Deployed",
        DEPLOY_FAILURE: "Deploy failed",
        ROLLBACK: "Rolled back",
      },
    },
    page: {
      title: "Architecture",
      lead: "The infrastructure and tools UDP set up for the project, nested the way they contain each other. Arrows point from the tool that needs something to the tool that provides it.",
      tools: (n: number) => plural(n, "tool", "tools"),
      environments: (n: number) => plural(n, "environment", "environments"),
      workloads: (n: number) => plural(n, "workload", "workloads"),
      emptyTitle: "Nothing to draw yet",
      emptyBody:
        "The diagram shows the infrastructure UDP sets up for the project, so it needs a cloud and domains first. Connect a cloud and choose domains; the diagram appears as soon as either exists.",
      emptyCloud: "Connect a cloud",
      emptyDomains: "Choose domains",
      invalid: (link: ReactNode) => (
        <>
          The enabled domain combination has not passed validation, so there is
          no deploy order and no edges yet. {link}
        </>
      ),
      invalidLink: "See the errors on the Domains page",
      summary: (total: number, h: Record<Tone, number>, updated: string) => {
        const parts = [`${formatNumber(h.ok)} healthy`];
        if (h.running > 0) parts.push(`${formatNumber(h.running)} busy`);
        if (h.warn > 0)
          parts.push(
            `${formatNumber(h.warn)} ${plural(h.warn, "needs", "need")} attention`,
          );
        if (h.error > 0) parts.push(`${formatNumber(h.error)} in error`);
        if (h.unknown > 0)
          parts.push(`${formatNumber(h.unknown)} not deployed`);
        return `${count(total, "tool", "tools")}: ${parts.join(", ")}. Updated ${updated}.`;
      },
      edgeList: (n: number) => `Dependencies as a list (${formatNumber(n)})`,
      edge: (from: ReactNode, capability: ReactNode, to: ReactNode) => (
        <>
          {from} needs {capability} from {to}
        </>
      ),
    },
    panel: {
      close: "Close",
      tool: "Tool",
      status: "Status",
      drift: "Cluster configuration",
      scope: "Scope",
      scopeGone: "The server no longer loads this tool",
      scopeCluster: "Whole cluster",
      scopeNamespace: "Each environment",
      order: "Deploy order",
      noOrder: "None",
      provides: "Provides",
      providesNone: "Provides no capability to other tools.",
      needs: "Needs",
      needsNone: "Depends on no other tool.",
      needsFrom: (capability: ReactNode, from: ReactNode) => (
        <>
          {capability} from {from}
        </>
      ),
      usedBy: "Used by",
      usedByNone: "No tool uses its capabilities yet.",
      usedByItem: (user: ReactNode, capability: ReactNode) => (
        <>
          {user} uses {capability}
        </>
      ),
      openDomain: "Open the domain page",
    },
  },
});
