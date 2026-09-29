import type { ReactNode } from "react";
import { count, defineMessages, plural } from "../../i18n";
import { formatNumber } from "../../lib/format";

/** Chữ của trang chủ developer */
export const homeMessages = defineMessages({
  vi: {
    home: "Trang chủ",
    createProject: "Tạo project",
    hello: (name: string) => `Chào ${name}`,
    lead: "Việc cần xử lý, rollout đang chạy và deploy của mọi project bạn tham gia.",
    minis: {
      projects: (_n: number) => "project",
      rollouts: (_n: number) => "rollout đang chạy",
      attention: (_n: number) => "việc cần xử lý",
    },
    noProjects: "Bạn chưa tham gia project nào",
    createFirst: "Tạo project đầu tiên",
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
      domainError: (subject: string) => `Domain ${subject} lỗi`,
      domainDrifted: (subject: string) => `Domain ${subject} lệch cấu hình`,
      jobFailed: (job: string) => `${job} thất bại`,
      projectExpiring: "Project hết hạn trong 48 giờ",
      rolloutPaused: (subject: string) => `Rollout ${subject} đang tạm dừng`,
    },
  },
  en: {
    home: "Home",
    createProject: "Create project",
    hello: (name: string) => `Hi ${name}`,
    lead: "What needs attention, running rollouts and deployments across every project you belong to.",
    minis: {
      projects: (n: number) => plural(n, "project", "projects"),
      rollouts: (n: number) => plural(n, "running rollout", "running rollouts"),
      attention: (_n: number) => "needing attention",
    },
    noProjects: "You are not in any project yet",
    createFirst: "Create your first project",
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
      domainError: (subject: string) => `Domain ${subject} has an error`,
      domainDrifted: (subject: string) => `Domain ${subject} drifted`,
      jobFailed: (job: string) => `${job} failed`,
      projectExpiring: "Project expires within 48 hours",
      rolloutPaused: (subject: string) => `Rollout ${subject} is paused`,
    },
  },
});
