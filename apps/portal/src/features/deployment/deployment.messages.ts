import type { DeploymentWire } from "@udp/shared-types/wire";
import { count, defineMessages, plural } from "../../i18n";

/** Chữ của trang Deploy và bốn thẻ DORA (thẻ dùng chung với trang Giám sát) */
const vi = {
  title: "Deploy",
  lead: (env: string) => `Lịch sử triển khai và bốn chỉ số DORA ở ${env}.`,
  range: "Khoảng thời gian",
  days: (n: number) => `${String(n)} ngày`,
  recent: "Deployment gần đây",
  empty: (env: string) => `Chưa có deployment nào ở ${env}`,
  emptyHint:
    "Deploy từ webhook CI/CD và rollback của rollout theo flag sẽ hiện ở đây.",
  list: "Deployment",
  status: {
    DEPLOY_PENDING: "Chờ duyệt",
    DEPLOY_START: "Đang deploy",
    DEPLOY_SUCCESS: "Thành công",
    DEPLOY_FAILURE: "Thất bại",
    FLAG_CHANGE: "Đổi flag",
    ROLLBACK: "Rollback",
  } satisfies Record<DeploymentWire["status"], string>,
  trigger: {
    WEBHOOK: "CI/CD",
    MANUAL: "thủ công",
    ROLLBACK: "rollback",
    AUTO: "tự động",
  } satisfies Record<DeploymentWire["triggeredBy"], string>,
  viewRollout: "xem rollout",
  /** [Plan #61 QĐ-13] Lần deploy do rebase theo lịch: cùng commit, lớp hệ điều hành mới */
  rebase: "Vá image nền",
  log: "Nhật ký",
  logLabel: (id: string) => `Nhật ký deploy ${id}`,
  approve: "Duyệt deploy",
  approveTitle: (target: string, env: string) => `Deploy ${target} vào ${env}?`,
  approveDescription:
    "UDP áp image vào workload rồi theo dõi; không lên kịp hạn thì tự hoàn tác về bản cũ. Flag vẫn tắt: deploy không phải release.",
  dora: {
    label: "Chỉ số DORA",
    frequency: "Tần suất deploy",
    perDay: "/ngày",
    successes: (n: number) => `${String(n)} lần thành công`,
    leadTime: "Lead time",
    leadSamples: (n: number) => `${String(n)} mẫu có commit`,
    failureRate: "Tỉ lệ thay đổi lỗi",
    failures: (failed: number, total: number) =>
      `${String(failed)}/${String(total)} deployment`,
    recovery: "Thời gian khôi phục",
    recoveries: (n: number) => `${String(n)} lần khôi phục`,
    rollbacks: (days: number, auto: number, manual: number) =>
      `Rollback trong ${String(days)} ngày: ${String(auto)} tự động (hệ thống canary), ${String(manual)} thủ công.`,
    noDeploys:
      " Chưa có sự kiện deploy nào từ CI/CD nên bốn chỉ số trên chưa có số.",
  },
};

export const deploymentMessages = defineMessages({
  vi,
  en: {
    title: "Deployments",
    lead: (env: string) =>
      `Deployment history and the four DORA metrics in ${env}.`,
    range: "Time range",
    days: (n: number) => count(n, "day", "days"),
    recent: "Recent deployments",
    empty: (env: string) => `No deployments in ${env} yet`,
    emptyHint:
      "Deployments from the CI/CD webhook and rollbacks from flag rollouts will appear here.",
    list: "Deployments",
    status: {
      DEPLOY_PENDING: "Awaiting approval",
      DEPLOY_START: "Deploying",
      DEPLOY_SUCCESS: "Succeeded",
      DEPLOY_FAILURE: "Failed",
      FLAG_CHANGE: "Flag change",
      ROLLBACK: "Rollback",
    },
    trigger: {
      WEBHOOK: "CI/CD",
      MANUAL: "manual",
      ROLLBACK: "rollback",
      AUTO: "automatic",
    },
    viewRollout: "view rollout",
    rebase: "Base image patch",
    log: "Log",
    logLabel: (id: string) => `Deployment log ${id}`,
    approve: "Approve deployment",
    approveTitle: (target: string, env: string) =>
      `Deploy ${target} to ${env}?`,
    approveDescription:
      "UDP applies the image to the workload and watches it; if it is not up in time, it reverts to the previous version automatically. Flags stay off: a deployment is not a release.",
    dora: {
      label: "DORA metrics",
      frequency: "Deployment frequency",
      perDay: "/day",
      successes: (n: number) =>
        count(n, "successful deployment", "successful deployments"),
      leadTime: "Lead time",
      leadSamples: (n: number) =>
        count(n, "sample with a commit", "samples with a commit"),
      failureRate: "Change failure rate",
      failures: (failed: number, total: number) =>
        `${String(failed)}/${String(total)} ${plural(total, "deployment", "deployments")}`,
      recovery: "Time to restore",
      recoveries: (n: number) => count(n, "recovery", "recoveries"),
      rollbacks: (days: number, auto: number, manual: number) =>
        `Rollbacks in the last ${count(days, "day", "days")}: ${String(auto)} automatic (canary system), ${String(manual)} manual.`,
      noDeploys:
        " No deployment events from CI/CD yet, so the four metrics above have no values.",
    },
  },
});
