import type { ReactNode } from "react";
import { count, defineMessages, plural } from "../../i18n";
import { formatNumber } from "../../lib/format";

/** Chữ của trang chủ developer */
export const homeMessages = defineMessages({
  vi: {
    home: "Trang chủ",
    createProject: "Tạo project",
    hello: (name: ReactNode) => <>Chào {name}</>,
    lead: "Việc cần xử lý, rollout đang chạy và deploy của mọi project bạn tham gia.",
    minis: {
      projects: (_n: number) => "project",
      rollouts: (_n: number) => "rollout đang chạy",
      attention: (_n: number) => "việc cần xử lý",
    },
    createFirst: "Tạo project đầu tiên",
    /** [Plan #58 UX-11] Lần đầu vào: UDP làm gì và ba bước, thay cho "chưa tham gia project nào" */
    firstRun: {
      title: "Bắt đầu với UDP",
      intro:
        "UDP giúp bạn bật tắt tính năng bằng feature flag, phát hành dần và tự lùi lại khi có lỗi, rồi dựng hạ tầng trên cloud của chính bạn.",
      steps: [
        {
          title: "Tạo project",
          body: "Một project là một ứng dụng hoặc một nhóm service. Nó có sẵn ba environment: dev, staging và prod.",
        },
        {
          title: "Dùng flag ngay, chưa cần cloud",
          body: "Tạo SDK key, cài SDK vào ứng dụng rồi tạo flag đầu tiên. Flag chạy được cả khi project còn là Nháp.",
        },
        {
          title: "Kết nối cloud sau",
          body: "Khi cần hạ tầng, kết nối tài khoản cloud của bạn và chọn công cụ. UDP dựng mạng, cluster và cài công cụ.",
        },
      ],
      invited:
        "Đồng nghiệp đã mời bạn? Mở đường dẫn mời trong email, project sẽ hiện ở đây.",
    },
    attentionTitle: "Việc cần xử lý",
    attentionNone: "Không có gì cần xử lý. Mọi project đều ổn.",
    rolloutsTitle: "Rollout đang chạy",
    rolloutsNone: "Không có rollout nào đang chạy.",
    projectsTitle: "Project",
    allProjects: "Mọi project",
    card: {
      environments: (n: number) => `${formatNumber(n)} environment`,
      rollouts: (value: ReactNode, _n: number) => <>{value} rollout</>,
      attention: (value: ReactNode, _n: number) => <>{value} việc cần xử lý</>,
    },
    deploys: "Deploy 14 ngày",
    succeeded: "Thành công",
    failed: "Thất bại",
    /** Câu của một việc cần xử lý; `subject` là tên deploy, domain, rollout hoặc nhãn của job */
    attention: {
      deployPending: (subject: string) => `Deploy ${subject} chờ duyệt`,
      domainError: (domain: string) => `Domain ${domain} lỗi`,
      domainDrifted: (domain: string) => `Domain ${domain} lệch cấu hình`,
      jobFailed: (job: string) => `${job} thất bại`,
      projectExpiring: "Project hết hạn trong 48 giờ",
      rolloutPaused: (subject: string) => `Rollout ${subject} đang tạm dừng`,
    },
  },
  en: {
    home: "Home",
    createProject: "Create project",
    hello: (name: ReactNode) => <>Hi {name}</>,
    lead: "What needs attention, running rollouts and deployments across every project you belong to.",
    minis: {
      projects: (n: number) => plural(n, "project", "projects"),
      rollouts: (n: number) => plural(n, "running rollout", "running rollouts"),
      attention: (_n: number) => "needing attention",
    },
    createFirst: "Create your first project",
    firstRun: {
      title: "Get started with UDP",
      intro:
        "UDP lets you turn features on and off with feature flags, release gradually with automatic rollback, and set up infrastructure in your own cloud.",
      steps: [
        {
          title: "Create a project",
          body: "A project is one app or a group of services. It comes with three environments: dev, staging and prod.",
        },
        {
          title: "Use flags right away, no cloud needed",
          body: "Create an SDK key, add the SDK to your app, then create your first flag. Flags work even while the project is a Draft.",
        },
        {
          title: "Connect your cloud later",
          body: "When you need infrastructure, connect your cloud account and choose tools. UDP sets up the network and cluster and installs the tools.",
        },
      ],
      invited:
        "Invited by a teammate? Open the invitation link from your email and the project will show up here.",
    },
    attentionTitle: "Needs attention",
    attentionNone: "Nothing needs attention. Every project is healthy.",
    rolloutsTitle: "Running rollouts",
    rolloutsNone: "No rollouts are running.",
    projectsTitle: "Projects",
    allProjects: "All projects",
    card: {
      environments: (n: number) => count(n, "environment", "environments"),
      rollouts: (value: ReactNode, n: number) => (
        <>
          {value} {plural(n, "rollout", "rollouts")}
        </>
      ),
      attention: (value: ReactNode, _n: number) => (
        <>{value} needing attention</>
      ),
    },
    deploys: "Deployments, 14 days",
    succeeded: "Succeeded",
    failed: "Failed",
    attention: {
      deployPending: (subject: string) =>
        `Deployment ${subject} awaiting approval`,
      domainError: (domain: string) => `Domain ${domain} has an error`,
      domainDrifted: (domain: string) => `Domain ${domain} drifted`,
      jobFailed: (job: string) => `${job} failed`,
      projectExpiring: "Project expires within 48 hours",
      rolloutPaused: (subject: string) => `Rollout ${subject} is paused`,
    },
  },
});
