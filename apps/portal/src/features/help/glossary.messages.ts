import { defineMessages } from "../../i18n";

/**
 * [Plan #58 UX-19, UX-20] Bảng thuật ngữ — MỘT khái niệm MỘT từ, cho cả hai portal và hai ngôn ngữ. Mỗi mục: tên
 * (lời thường trước, thuật ngữ trong ngoặc khi cần) và một định nghĩa ngắn. `InfoTip` và trang Trợ giúp đọc từ đây;
 * sửa một chỗ là mọi nơi đổi theo.
 */

export const TERMS = [
  "project",
  "environment",
  "domain",
  "tool",
  "capability",
  "drift",
  "flag",
  "variant",
  "rule",
  "segment",
  "targetingKey",
  "sdkKey",
  "ofrep",
  "rollout",
  "canary",
  "baseline",
  "step",
  "dwell",
  "autoRollback",
  "killSwitch",
  "workload",
  "namespace",
  "cluster",
  "byoc",
  "provisioning",
  "dora",
  "red",
  "p99",
  "orphan",
  "goldenPath",
  "approval",
  "buildpacks",
  "buildIdentity",
  "rebase",
] as const;
export type TermKey = (typeof TERMS)[number];

interface Term {
  name: string;
  def: string;
}

export const glossaryMessages = defineMessages({
  vi: {
    title: "Thuật ngữ",
    explain: (term: string) => `Giải thích: ${term}`,
    term: {
      project: {
        name: "Project",
        def: "Một ứng dụng hoặc một nhóm service bạn quản lý trên UDP: flag, rollout, hạ tầng và thành viên của nó.",
      },
      environment: {
        name: "Environment",
        def: "Một nơi chạy ứng dụng, thường là dev, staging và prod. Mỗi environment có flag, khoá SDK và cấu hình riêng.",
      },
      domain: {
        name: "Domain",
        def: "Một loại công cụ hạ tầng, ví dụ CI/CD hay Monitoring. Không phải tên miền. Mỗi domain bạn chọn một công cụ.",
      },
      tool: {
        name: "Công cụ (tool)",
        def: "Phần mềm cụ thể UDP cài cho một domain, ví dụ Prometheus cho Monitoring.",
      },
      capability: {
        name: "Năng lực (capability)",
        def: 'Thứ một công cụ cung cấp cho công cụ khác, ví dụ "đọc số đo". UDP tự nối công cụ cần với công cụ cung cấp.',
      },
      drift: {
        name: "Lệch cấu hình (drift)",
        def: "Cấu hình đang chạy trên cluster khác với cấu hình bạn đã lưu, thường do ai đó sửa tay.",
      },
      flag: {
        name: "Feature flag",
        def: "Công tắc bật, tắt hoặc chia một tính năng cho người dùng mà không cần deploy lại.",
      },
      variant: {
        name: "Giá trị (variant)",
        def: "Một giá trị flag có thể trả về, ví dụ bật/tắt hoặc giao diện A/B.",
      },
      rule: {
        name: "Luật",
        def: "Điều kiện chọn ai nhận giá trị nào. Xét từ trên xuống, luật đầu tiên khớp thắng; không luật nào khớp thì trả giá trị mặc định.",
      },
      segment: {
        name: "Nhóm người dùng (segment)",
        def: 'Một nhóm người dùng đặt tên sẵn, ví dụ "khách VIP", dùng lại trong nhiều luật.',
      },
      targetingKey: {
        name: "Khoá người dùng (targeting key)",
        def: "Mã định danh ổn định của một người dùng, ví dụ userId. Cùng khoá thì luôn rơi vào cùng nhóm phần trăm.",
      },
      sdkKey: {
        name: "Khoá SDK",
        def: "Chìa khoá ứng dụng dùng để hỏi flag. Khoá server dùng ở máy chủ và giữ bí mật; khoá client dùng ở trình duyệt, chỉ đọc được giá trị.",
      },
      ofrep: {
        name: "OFREP",
        def: "Giao thức chuẩn của OpenFeature để hỏi giá trị flag qua mạng. Khoá client dùng nó nên luật không rời máy chủ.",
      },
      rollout: {
        name: "Phát hành dần (rollout)",
        def: "Đưa một thay đổi tới người dùng từng phần trăm, theo dõi số đo ở mỗi bậc và lùi lại nếu xấu.",
      },
      canary: {
        name: "Bản thử (canary)",
        def: "Phần nhỏ người dùng nhận bản mới trước. Số đo của họ được so với nhóm đối chứng.",
      },
      baseline: {
        name: "Nhóm đối chứng (baseline)",
        def: "Người dùng vẫn ở bản cũ trong lúc phát hành dần. Lỗi và độ trễ của bản thử được so với nhóm này.",
      },
      step: {
        name: "Bậc",
        def: "Một mức phần trăm của phát hành dần, ví dụ 10% rồi 25% rồi 50%.",
      },
      dwell: {
        name: "Thời gian giữ bậc",
        def: "Thời gian tối thiểu ở một bậc trước khi được lên bậc tiếp, để có đủ số đo.",
      },
      autoRollback: {
        name: "Tự lùi lại (auto-rollback)",
        def: "Khi tỉ lệ lỗi hoặc độ trễ của bản thử vượt ngưỡng liên tục, UDP tự đưa mọi người về bản cũ.",
      },
      killSwitch: {
        name: "Công tắc khẩn (kill switch)",
        def: "Tắt ngay một tính năng cho mọi người. Luôn dùng được, kể cả khi đang phát hành dần.",
      },
      workload: {
        name: "Workload",
        def: "Một thứ chạy trên cluster, thường là một service của bạn, ví dụ checkout-api.",
      },
      namespace: {
        name: "Namespace",
        def: "Một ngăn riêng trong cluster. Mỗi environment của project có namespace riêng.",
      },
      cluster: {
        name: "Cluster",
        def: "Cụm máy Kubernetes chạy ứng dụng và các công cụ hạ tầng.",
      },
      byoc: {
        name: "Cloud của bạn (BYOC)",
        def: "UDP dựng hạ tầng trong tài khoản cloud của chính bạn. Tài nguyên và chi phí là của bạn; UDP không giữ tiền.",
      },
      provisioning: {
        name: "Dựng hạ tầng (provisioning)",
        def: "UDP tạo mạng, cluster và cài công cụ trên cloud của bạn theo từng bước, ghi lại mọi thứ đã tạo.",
      },
      dora: {
        name: "Chỉ số DORA",
        def: "Bốn chỉ số đo giao hàng phần mềm: tần suất deploy, thời gian từ commit tới production, tỉ lệ deploy lỗi, thời gian khôi phục.",
      },
      red: {
        name: "Số đo RED",
        def: "Ba số đo sức khoẻ của một service: số request (Rate), tỉ lệ lỗi (Errors) và độ trễ (Duration).",
      },
      p99: {
        name: "Độ trễ p99",
        def: "99% request nhanh hơn con số này. Cho thấy trải nghiệm của những người chờ lâu nhất.",
      },
      orphan: {
        name: "Tài nguyên mồ côi",
        def: "Tài nguyên cloud UDP đã tạo nhưng chưa xoá được sau khi gỡ. Có thể vẫn đang tính tiền.",
      },
      goldenPath: {
        name: "Mẫu dự án (Golden Path)",
        def: "Dự án mẫu Node hoặc Python đã cài sẵn SDK, Dockerfile và pipeline, chạy được ngay.",
      },
      approval: {
        name: "Chờ duyệt",
        def: "Deploy vào environment cần duyệt sẽ dừng cho tới khi người có quyền bấm Duyệt.",
      },
      buildpacks: {
        name: "Tự đóng gói (Buildpacks)",
        def: "Cách build image không cần Dockerfile: Buildpacks tự nhận ngôn ngữ (Node.js, Python, Go, Java, .NET, Ruby, PHP, web tĩnh) và dựng image chạy bằng người dùng thường.",
      },
      rebase: {
        name: "Vá image nền (rebase)",
        def: "Mỗi ngày, pipeline thay lớp hệ điều hành dưới image Buildpacks bằng bản vá mới nhất mà không build lại. UDP chỉ deploy khi production đang chạy đúng commit đó, nên không bao giờ đè một lần rollback.",
      },
      buildIdentity: {
        name: "Danh tính build",
        def: "Vai trò trong cloud của bạn mà CI dùng để đẩy image, qua token ngắn hạn (OIDC). Không có khoá nào được lưu; chỉ đúng repo và nhánh của project dùng được.",
      },
    } satisfies Record<TermKey, Term>,
  },
  en: {
    title: "Glossary",
    explain: (term: string) => `Explain: ${term}`,
    term: {
      project: {
        name: "Project",
        def: "An app or a group of services you manage on UDP: its flags, rollouts, infrastructure and members.",
      },
      environment: {
        name: "Environment",
        def: "A place where the app runs, usually dev, staging and prod. Each has its own flags, SDK keys and settings.",
      },
      domain: {
        name: "Domain",
        def: "A kind of infrastructure tool, such as CI/CD or Monitoring. Not a web domain. You pick one tool per domain.",
      },
      tool: {
        name: "Tool",
        def: "The specific software UDP installs for a domain, such as Prometheus for Monitoring.",
      },
      capability: {
        name: "Capability",
        def: 'Something one tool provides to others, such as "query metrics". UDP wires tools that need it to the tool that provides it.',
      },
      drift: {
        name: "Drift",
        def: "The configuration running on the cluster differs from what you saved, usually because someone changed it by hand.",
      },
      flag: {
        name: "Feature flag",
        def: "A switch that turns a feature on, off or splits it between users without redeploying.",
      },
      variant: {
        name: "Variant",
        def: "A value a flag can return, such as on/off or design A/B.",
      },
      rule: {
        name: "Rule",
        def: "A condition that decides who gets which value. Rules run top to bottom and the first match wins; if none match, the default applies.",
      },
      segment: {
        name: "Segment",
        def: 'A named group of users, such as "VIP customers", reused across rules.',
      },
      targetingKey: {
        name: "Targeting key",
        def: "A stable identifier for a user, such as the user ID. The same key always lands in the same percentage bucket.",
      },
      sdkKey: {
        name: "SDK key",
        def: "The key your app uses to ask for flags. Server keys stay secret on your servers; client keys work in browsers and only read values.",
      },
      ofrep: {
        name: "OFREP",
        def: "OpenFeature's standard protocol for evaluating flags over the network. Client keys use it, so rules never leave the server.",
      },
      rollout: {
        name: "Rollout",
        def: "Delivers a change to users a percentage at a time, watching metrics at each step and rolling back if they look bad.",
      },
      canary: {
        name: "Canary",
        def: "The small share of users who get the new version first. Their metrics are compared with the baseline.",
      },
      baseline: {
        name: "Baseline",
        def: "Users who stay on the old version during a rollout. The canary's errors and latency are compared with them.",
      },
      step: {
        name: "Step",
        def: "One percentage level of a rollout, for example 10%, then 25%, then 50%.",
      },
      dwell: {
        name: "Hold time",
        def: "The minimum time at a step before moving to the next one, so there is enough data.",
      },
      autoRollback: {
        name: "Automatic rollback",
        def: "When the canary's error rate or latency stays above the threshold, UDP moves everyone back to the old version.",
      },
      killSwitch: {
        name: "Kill switch",
        def: "Turns a feature off for everyone at once. Always available, even during a rollout.",
      },
      workload: {
        name: "Workload",
        def: "Something running on the cluster, usually one of your services, such as checkout-api.",
      },
      namespace: {
        name: "Namespace",
        def: "A separate compartment in the cluster. Each environment of a project has its own.",
      },
      cluster: {
        name: "Cluster",
        def: "The Kubernetes machines that run your app and the infrastructure tools.",
      },
      byoc: {
        name: "Your own cloud (BYOC)",
        def: "UDP builds infrastructure inside your own cloud account. Resources and costs are yours; UDP never holds your money.",
      },
      provisioning: {
        name: "Provisioning",
        def: "UDP creates the network and cluster and installs tools on your cloud step by step, recording everything it creates.",
      },
      dora: {
        name: "DORA metrics",
        def: "Four measures of software delivery: deployment frequency, lead time to production, change failure rate and time to recover.",
      },
      red: {
        name: "RED metrics",
        def: "Three health measures of a service: request Rate, Errors and Duration (latency).",
      },
      p99: {
        name: "p99 latency",
        def: "99% of requests are faster than this. It shows what the slowest-served users experience.",
      },
      orphan: {
        name: "Orphaned resource",
        def: "A cloud resource UDP created but could not delete during teardown. It may still be billing.",
      },
      goldenPath: {
        name: "Golden Path template",
        def: "A ready-to-run Node or Python starter with the SDK, Dockerfile and pipeline already set up.",
      },
      approval: {
        name: "Awaiting approval",
        def: "Deploys to an environment that needs approval wait until someone with permission clicks Approve.",
      },
      buildpacks: {
        name: "Automatic packaging (Buildpacks)",
        def: "Building an image without a Dockerfile: Buildpacks detect the language (Node.js, Python, Go, Java, .NET, Ruby, PHP, static sites) and build an image that runs as a regular user.",
      },
      rebase: {
        name: "Base image patch (rebase)",
        def: "Every day the pipeline swaps the operating-system layers under a Buildpacks image for the latest patched ones, without rebuilding. UDP deploys it only when production runs that exact commit, so a rollback is never overridden.",
      },
      buildIdentity: {
        name: "Build identity",
        def: "A role in your cloud that CI uses to push images through short-lived tokens (OIDC). No key is stored; only this project's repository and branches can use it.",
      },
    },
  },
});
