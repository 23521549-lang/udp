import { count, defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

/**
 * [Plan #59] Chữ của trang giới thiệu. Luật trung thực: không lời chứng thực, không logo khách hàng, không số liệu bịa;
 * số nào cũng đến từ `landing-facts.ts` (đếm trong mã, có test đối chiếu) hoặc là sự thật của thiết kế (credential một
 * giờ của liên kết danh tính, §10 UDP_design). Bản tiếng Anh viết lại cho người đọc tiếng Anh, không dịch từng chữ.
 */

interface Quota {
  maxNodes: number;
  maxDatabases: number;
  maxStorageGb: number;
  maxLoadBalancers: number;
}

const n = formatNumber;

export const landingMessages = defineMessages({
  vi: {
    docTitle: "UDP · Phát hành an toàn trên cloud của bạn",
    skip: "Bỏ qua tới nội dung",
    nav: {
      label: "Điều hướng chính",
      home: "UDP, đầu trang",
      features: "Tính năng",
      byoc: "Cloud của bạn",
      tools: "Công cụ",
      faq: "Câu hỏi",
      signIn: "Đăng nhập",
      start: "Bắt đầu miễn phí",
      /** Nút ghi tên ngôn ngữ ĐÍCH bằng chính ngôn ngữ đó (`LOCALE_NAME`); nhãn này cho trình đọc màn hình */
      switchLabel: "Chuyển sang tiếng Anh",
    },
    hero: {
      badge: "Miễn phí trong giai đoạn thử nghiệm",
      title: "Phát hành an toàn, trên hạ tầng của chính bạn.",
      lead: "UDP dựng Kubernetes và công cụ DevOps trong tài khoản cloud của bạn, phát hành từng phần trăm qua feature flag và tự lùi khi số đo xấu.",
      primary: "Bắt đầu miễn phí",
      secondary: "Xem cách hoạt động",
      note: "Không cần thẻ thanh toán. Tiền cloud bạn trả thẳng cho nhà cung cấp.",
      shotAlt:
        "Trang Kiến trúc của Portal UDP: sơ đồ giao hàng từ mã nguồn qua CI/CD, registry, GitOps tới Progressive Delivery; lưu lượng vào qua Ingress và Service Mesh tới ba environment; dữ liệu ở Database và Secrets.",
    },
    facts: {
      label: "UDP trong bốn con số",
      domains: "domain hạ tầng",
      domainsDetail: "từ CI/CD, giám sát tới chi phí",
      tools: "công cụ có sẵn",
      toolsDetail: "Terraform, Argo CD, Prometheus, Vault…",
      clouds: "cloud",
      cloudsDetail: "AWS, Google Cloud, Azure",
      fee: "0 ₫",
      feeLabel: "phí nền tảng",
      feeDetail: "trong giai đoạn thử nghiệm",
    },
    domains: {
      title: "Bật đúng thứ project cần.",
      body: "Mỗi domain là một loại công cụ: CI/CD, registry, giám sát, secrets… Bạn chọn công cụ cho từng domain; UDP tính thứ tự dựng từ phụ thuộc giữa chúng và kiểm cấu hình trước khi chạy.",
      points: [
        "Gói khởi đầu ba domain cho người mới: CI/CD, Container Registry, Monitoring.",
        "Xem trước kế hoạch dựng rồi mới bấm Triển khai.",
        "Đổi công cụ sau ở trang Domain; UDP báo khi cluster lệch cấu hình.",
      ],
      shotAlt:
        "Bước chọn domain của wizard tạo project: các domain nhóm theo việc, mỗi domain một câu công dụng và một công tắc bật.",
    },
    rollout: {
      title: "Phát hành từng bậc. Tự lùi khi số đo xấu.",
      body: "Bản mới nhận lưu lượng theo bậc, ví dụ 10%, 20%, 30%. Ở mỗi bậc UDP so tỉ lệ lỗi và độ trễ p99 của bản thử với nhóm đối chứng; vượt ngưỡng nhiều lần liên tiếp thì tự rollback.",
      marksLabel: "Chú thích ảnh",
      marks: [
        "Tạm dừng, lên 100% hay rollback bằng một nút.",
        "Lưu lượng của hai bản, và số đo của bản thử cạnh nhóm đối chứng.",
        "Tỉ lệ lỗi theo thời gian, cùng đường ngưỡng bạn đặt.",
      ],
      shotAlt:
        "Trang chi tiết một rollout đang chạy: lưu lượng của bản mới, tỉ lệ lỗi và độ trễ p99 so với nhóm đối chứng, biểu đồ tỉ lệ lỗi và nhật ký các lần lên bậc.",
    },
    flags: {
      title: "Feature flag theo chuẩn OpenFeature.",
      body: "Gắn provider của UDP vào SDK OpenFeature. Ở server, SDK tải luật về và đánh giá ngay trong tiến trình, không gọi mạng cho mỗi lần hỏi; trình duyệt hỏi qua OFREP.",
      points: [
        "Segment và luật nhắm theo thuộc tính người dùng, chia theo phần trăm.",
        "Kill switch tắt một tính năng mà không phải deploy lại.",
        "Trang Dọn dẹp chỉ ra flag đã lâu không còn được hỏi.",
      ],
      langLabel: "Ngôn ngữ của mã mẫu",
      langs: { node: "Node.js", python: "Python", browser: "Trình duyệt" },
      install: (lang: string) => `Lệnh cài cho ${lang}`,
      code: (lang: string) => `Mã mẫu cho ${lang}`,
    },
    byoc: {
      title: "Hạ tầng nằm trong tài khoản của bạn.",
      body: "UDP dựng mạng, cluster EKS, GKE hoặc AKS và các công cụ trong chính tài khoản cloud của bạn. Bạn giữ quyền và hoá đơn; UDP là bên điều phối.",
      yours: "Ở tài khoản cloud của bạn",
      yoursItems: [
        "Mạng, cluster Kubernetes và mọi công cụ đã dựng",
        "Hoá đơn, trả thẳng cho AWS, Google Cloud hoặc Azure",
        "Dữ liệu của ứng dụng",
      ],
      udp: "Ở UDP",
      udpItems: [
        "Cấu hình project, flag, segment và lịch sử phát hành",
        "Credential tạm sống một giờ, khi bạn dùng liên kết danh tính",
        "Nhật ký thao tác của các thành viên",
      ],
      quota: (q: Quota) =>
        `Mỗi project có trần an toàn mặc định: ${n(q.maxNodes)} node cỡ vừa, ${n(q.maxDatabases)} database, ${n(q.maxStorageGb)} GB lưu trữ, ${n(q.maxLoadBalancers)} load balancer. Một vòng lặp lỗi không tiêu tiền thật của bạn.`,
      tags: "Mọi tài nguyên UDP tạo đều gắn tag; một lần dựng hỏng giữa chừng được dọn lại.",
      shotAlt:
        "Bước kết nối cloud của wizard: chọn AWS, Google Cloud hoặc Azure; cách xác thực khuyến nghị là IAM role tin UDP, kèm trust policy để sao chép.",
    },
    tools: {
      title: (domains: number, tools: number) =>
        `${n(domains)} domain, ${n(tools)} công cụ.`,
      body: "Mã nguồn mở và dịch vụ quen thuộc, nhóm theo việc bạn cần làm. Mỗi domain chạy một công cụ do bạn chọn, đổi được về sau.",
    },
    how: {
      title: "Ba bước để bắt đầu.",
      steps: [
        {
          title: "Kết nối cloud",
          body: "Tạo một vai trò truy cập trong tài khoản AWS, Google Cloud hoặc Azure. Portal soạn sẵn trust policy để bạn sao chép.",
        },
        {
          title: "Chọn domain và công cụ",
          body: "Bắt đầu với gói ba domain hoặc tự chọn. Xem trước kế hoạch, bấm Triển khai và theo dõi từng bước dựng.",
        },
        {
          title: "Gắn SDK và phát hành",
          body: "Tạo SDK key cho từng environment, hỏi flag trong mã, rồi mở rollout khi bản mới sẵn sàng.",
        },
      ],
    },
    free: {
      title: "Miễn phí trong giai đoạn thử nghiệm.",
      body: "Chưa có gói trả phí. Bạn chỉ trả cho cloud của mình, theo giá của nhà cung cấp.",
      included: "Bạn dùng được",
      includedItems: (domains: number, tools: number) => [
        `Đủ ${n(domains)} domain và ${n(tools)} công cụ`,
        "Flag, segment, rollout và kill switch",
        "Mời đồng nghiệp, chia quyền theo nhóm",
        "Portal tiếng Việt và tiếng Anh, sáng và tối",
      ],
      notFit: "Chưa hợp với bạn nếu",
      notFitItems: [
        "Bạn cần chạy trên máy chủ riêng, ngoài AWS, Google Cloud và Azure.",
        "Bạn cần cam kết SLA trên hợp đồng: bản thử nghiệm chưa có.",
        "Ứng dụng của bạn chưa đóng gói thành container được.",
      ],
      cta: "Tạo tài khoản miễn phí",
    },
    faq: {
      title: "Câu hỏi thường gặp",
      items: (q: Quota) => [
        {
          q: "UDP có giữ khoá cloud của tôi không?",
          a: "Không, nếu bạn dùng liên kết danh tính như Portal khuyến nghị: IAM role trên AWS, Workload Identity trên Google Cloud, federated credential trên Azure. Mỗi lần làm việc UDP nhận một credential sống một giờ; thu hồi bằng cách xoá quan hệ tin cậy. Khoá tĩnh vẫn dùng được khi không có cách khác, kèm cảnh báo thường trực.",
        },
        {
          q: "Ai trả tiền cho cluster và công cụ?",
          a: "Bạn, trả thẳng cho nhà cung cấp cloud theo giá của họ. UDP gắn tag mọi tài nguyên nó tạo, để bạn luôn biết cái gì là của UDP.",
        },
        {
          q: "Mỗi project được dùng bao nhiêu tài nguyên?",
          a: `Mặc định tối đa ${n(q.maxNodes)} node cỡ vừa, ${n(q.maxDatabases)} database, ${n(q.maxStorageGb)} GB lưu trữ và ${n(q.maxLoadBalancers)} load balancer. Trần này chặn ở mọi lời gọi tới cloud, để lỗi không biến thành hoá đơn.`,
        },
        {
          q: "Ngừng dùng UDP thì sao?",
          a: "Tài nguyên nằm trong tài khoản của bạn; bạn quyết định giữ hay xoá. Mã hỏi flag qua chuẩn OpenFeature, nên đổi sang nhà cung cấp flag khác là đổi provider, không viết lại chỗ hỏi flag.",
        },
        {
          q: "SDK có cho những ngôn ngữ nào?",
          a: "Node.js và Python có provider của UDP, đánh giá flag ngay trong tiến trình. Ứng dụng web dùng provider OFREP chuẩn của OpenFeature, không cần SDK riêng.",
        },
        {
          q: "Portal có tiếng Anh không?",
          a: "Có. Portal có tiếng Việt và tiếng Anh, giao diện sáng và tối; đổi ở menu tài khoản hoặc ở cuối trang này.",
        },
      ],
    },
    final: {
      title: "Dựng nền tảng đầu tiên của bạn.",
      body: "Tạo tài khoản, kết nối cloud, bật ba domain đầu tiên.",
      primary: "Tạo tài khoản miễn phí",
      signIn: "Đã có tài khoản? Đăng nhập",
    },
    footer: {
      label: "Cuối trang",
      tagline: "Nền tảng DevOps cấu hình được, chạy trên cloud của bạn.",
      links: "Liên kết",
      terms: "Điều khoản sử dụng",
      privacy: "Quyền riêng tư",
      copyright: (year: number) => `© ${String(year)} UDP`,
    },
  },
  en: {
    docTitle: "UDP · Ship safely on your own cloud",
    skip: "Skip to content",
    nav: {
      label: "Main",
      home: "UDP, top of page",
      features: "Features",
      byoc: "Your cloud",
      tools: "Tools",
      faq: "FAQ",
      signIn: "Sign in",
      start: "Start free",
      switchLabel: "Switch to Vietnamese",
    },
    hero: {
      badge: "Free during the beta",
      title: "Ship safely, on infrastructure you own.",
      lead: "UDP sets up Kubernetes and your DevOps tools in your own cloud account, releases behind feature flags, and rolls back when the numbers go bad.",
      primary: "Start free",
      secondary: "See how it works",
      note: "No credit card. You pay your cloud provider directly.",
      shotAlt:
        "The Architecture page of the UDP Portal: delivery flows from source through CI/CD, registry and GitOps to Progressive Delivery; traffic enters through Ingress and Service Mesh to three environments; data sits in Database and Secrets.",
    },
    facts: {
      label: "UDP in four numbers",
      domains: "infrastructure domains",
      domainsDetail: "from CI/CD and monitoring to cost",
      tools: "tools ready to run",
      toolsDetail: "Terraform, Argo CD, Prometheus, Vault…",
      clouds: "clouds",
      cloudsDetail: "AWS, Google Cloud, Azure",
      fee: "$0",
      feeLabel: "platform fee",
      feeDetail: "during the beta",
    },
    domains: {
      title: "Turn on only what your project needs.",
      body: "Each domain is one kind of tool: CI/CD, registry, monitoring, secrets and more. Pick a tool for each; UDP works out the install order from their dependencies and checks the config before anything runs.",
      points: [
        "A three-domain starter set for newcomers: CI/CD, Container Registry, Monitoring.",
        "Preview the plan before you press Deploy.",
        "Swap tools later on the Domains page; UDP tells you when the cluster drifts.",
      ],
      shotAlt:
        "The domain step of the new-project wizard: domains grouped by job, each with a one-line purpose and an on switch.",
    },
    rollout: {
      title: "Roll out in steps. Roll back on bad numbers.",
      body: "The new version gets traffic in steps, say 10%, 20%, 30%. At each step UDP compares the canary's error rate and p99 latency with a baseline group, and rolls back on its own after repeated breaches.",
      marksLabel: "Screenshot callouts",
      marks: [
        "Pause, promote to 100% or roll back with one button.",
        "Traffic for both versions, and the canary's numbers next to the baseline.",
        "Error rate over time, with the threshold you set.",
      ],
      shotAlt:
        "The detail page of a running rollout: new-version traffic, error rate and p99 latency against the baseline, an error-rate chart and a log of each step.",
    },
    flags: {
      title: "Feature flags on the OpenFeature standard.",
      body: "Plug the UDP provider into the OpenFeature SDK. On the server, the SDK pulls the rules and evaluates them in process, with no network call per lookup; browsers ask over OFREP.",
      points: [
        "Segments and targeting rules on user attributes, split by percentage.",
        "A kill switch turns a feature off without a redeploy.",
        "The Cleanup page lists flags nobody has asked for in a while.",
      ],
      langLabel: "Sample code language",
      langs: { node: "Node.js", python: "Python", browser: "Browser" },
      install: (lang: string) => `Install command for ${lang}`,
      code: (lang: string) => `Sample code for ${lang}`,
    },
    byoc: {
      title: "Your infrastructure stays in your account.",
      body: "UDP builds the network, an EKS, GKE or AKS cluster and your tools inside your own cloud account. You keep the access and the bill; UDP orchestrates.",
      yours: "In your cloud account",
      yoursItems: [
        "Network, Kubernetes cluster and every tool it set up",
        "The bill, paid straight to AWS, Google Cloud or Azure",
        "Your application data",
      ],
      udp: "At UDP",
      udpItems: [
        "Project config, flags, segments and release history",
        "One-hour credentials, when you use identity federation",
        "An audit log of what members did",
      ],
      quota: (q: Quota) =>
        `Every project starts with safe limits: ${count(q.maxNodes, "medium node", "medium nodes")}, ${count(q.maxDatabases, "database", "databases")}, ${n(q.maxStorageGb)} GB of storage, ${count(q.maxLoadBalancers, "load balancer", "load balancers")}. A runaway loop cannot spend your money.`,
      tags: "Everything UDP creates is tagged; a run that fails halfway is cleaned up.",
      shotAlt:
        "The cloud step of the wizard: pick AWS, Google Cloud or Azure; the recommended sign-in is an IAM role that trusts UDP, with a trust policy to copy.",
    },
    tools: {
      title: (domains: number, tools: number) =>
        `${n(domains)} domains, ${n(tools)} tools.`,
      body: "Open source and familiar services, grouped by the job they do. Each domain runs one tool of your choice, and you can change it later.",
    },
    how: {
      title: "Three steps to start.",
      steps: [
        {
          title: "Connect your cloud",
          body: "Create one access role in your AWS, Google Cloud or Azure account. The Portal writes the trust policy for you to copy.",
        },
        {
          title: "Pick domains and tools",
          body: "Start from the three-domain set or choose your own. Preview the plan, press Deploy and follow each step.",
        },
        {
          title: "Add the SDK and ship",
          body: "Create an SDK key per environment, ask for a flag in code, then open a rollout when the new version is ready.",
        },
      ],
    },
    free: {
      title: "Free during the beta.",
      body: "There is no paid plan yet. You only pay for your own cloud, at your provider's prices.",
      included: "What you get",
      includedItems: (domains: number, tools: number) => [
        `All ${n(domains)} domains and ${n(tools)} tools`,
        "Flags, segments, rollouts and kill switches",
        "Invite teammates, grant access by team",
        "The Portal in Vietnamese and English, light and dark",
      ],
      notFit: "Not a fit yet if",
      notFitItems: [
        "You need to run on your own servers, outside AWS, Google Cloud and Azure.",
        "You need a contractual SLA: the beta has none.",
        "Your application cannot be packaged as a container yet.",
      ],
      cta: "Create a free account",
    },
    faq: {
      title: "Questions",
      items: (q: Quota) => [
        {
          q: "Does UDP keep my cloud keys?",
          a: "No, if you use identity federation as the Portal recommends: an IAM role on AWS, Workload Identity on Google Cloud, a federated credential on Azure. Each time UDP works it gets a credential that lives for one hour; you revoke it by deleting the trust relationship. Static keys still work when nothing else will, with a standing warning.",
        },
        {
          q: "Who pays for the cluster and the tools?",
          a: "You do, straight to your cloud provider at their prices. UDP tags everything it creates, so you always know what belongs to UDP.",
        },
        {
          q: "How much can a project use?",
          a: `By default at most ${count(q.maxNodes, "medium node", "medium nodes")}, ${count(q.maxDatabases, "database", "databases")}, ${n(q.maxStorageGb)} GB of storage and ${count(q.maxLoadBalancers, "load balancer", "load balancers")}. The limit is enforced on every call to the cloud, so a bug never becomes a bill.`,
        },
        {
          q: "What if I stop using UDP?",
          a: "The resources live in your account, so you decide whether to keep or delete them. Your code asks for flags through the OpenFeature standard, so moving to another flag vendor means swapping the provider, not rewriting your flag checks.",
        },
        {
          q: "Which languages have an SDK?",
          a: "Node.js and Python have a UDP provider that evaluates flags in process. Web apps use the standard OpenFeature OFREP provider, with no UDP-specific SDK.",
        },
        {
          q: "Is the Portal available in English?",
          a: "Yes. The Portal comes in Vietnamese and English, light and dark; switch in the account menu or at the bottom of this page.",
        },
      ],
    },
    final: {
      title: "Build your first platform.",
      body: "Create an account, connect a cloud, turn on your first three domains.",
      primary: "Create a free account",
      signIn: "Have an account? Sign in",
    },
    footer: {
      label: "Footer",
      tagline: "A configurable DevOps platform that runs on your cloud.",
      links: "Links",
      terms: "Terms of Service",
      privacy: "Privacy",
      copyright: (year: number) => `© ${String(year)} UDP`,
    },
  },
});
