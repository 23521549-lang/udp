import { defineMessages } from "../../i18n";

/**
 * [Plan #60 QĐ-6] Điều khoản sử dụng và Chính sách quyền riêng tư. Viết ĐÚNG những gì hệ thống làm (bảng nào giữ gì,
 * cookie nào, bên thứ ba nào nhận gì) — đối chiếu với `UDP_design.md` §2 và mã của Service 1. Chưa có luật sư đọc:
 * sổ nợ `legal-review` chặn việc mở công khai cho tới khi có (Plan #60 §6).
 */

export interface LegalSection {
  title: string;
  /** Đoạn văn; đoạn bắt đầu bằng "• " vẽ thành gạch đầu dòng */
  body: readonly string[];
}

export interface LegalDoc {
  title: string;
  lead: string;
  sections: readonly LegalSection[];
}

export const legalMessages = defineMessages({
  vi: {
    updated: (date: string, version: string) =>
      `Cập nhật lần cuối ${date} · phiên bản ${version}`,
    home: "UDP, về trang giới thiệu",
    toc: "Mục lục",
    otherTerms: "Điều khoản sử dụng",
    otherPrivacy: "Chính sách quyền riêng tư",
    terms: {
      title: "Điều khoản sử dụng",
      lead: "Những điều bạn và UDP cùng đồng ý khi bạn tạo tài khoản và dùng nền tảng. Đọc cùng Chính sách quyền riêng tư.",
      sections: [
        {
          title: "1. UDP là gì",
          body: [
            "UDP là nền tảng DevOps cấu hình được: bạn kết nối tài khoản cloud của mình (AWS, Google Cloud hoặc Azure), chọn công cụ cho từng domain, và UDP dựng, theo dõi, phát hành ứng dụng của bạn trên hạ tầng đó.",
            "UDP đang trong giai đoạn thử nghiệm và miễn phí. Chưa có gói trả phí.",
          ],
        },
        {
          title: "2. Tài khoản",
          body: [
            "Bạn dùng thông tin thật khi đăng ký, giữ bí mật mật khẩu, và chịu trách nhiệm về mọi thao tác dưới tài khoản của mình.",
            "UDP dành cho người từ 16 tuổi.",
            "Bạn có thể đăng nhập bằng email và mật khẩu, hoặc bằng GitHub khi triển khai này bật tính năng đó.",
          ],
        },
        {
          title: "3. Hạ tầng và chi phí cloud",
          body: [
            "Mạng, cluster và công cụ mà UDP dựng nằm trong tài khoản cloud CỦA BẠN. Hoá đơn cloud do nhà cung cấp gửi thẳng cho bạn; UDP không thu và không chịu khoản đó.",
            "Mỗi project có trần tài nguyên mặc định để một lỗi không biến thành hoá đơn lớn, nhưng chi phí thực tế vẫn tuỳ cấu hình và cách dùng của bạn. Theo dõi hoá đơn cloud là việc của bạn.",
          ],
        },
        {
          title: "4. Quyền truy cập cloud",
          body: [
            "Bạn cấp cho UDP quyền vào tài khoản cloud bằng liên kết danh tính (IAM role, Workload Identity, federated credential) hoặc bằng khoá tĩnh. UDP chỉ dùng quyền đó để làm những việc bạn yêu cầu trên Portal.",
            "Bạn thu hồi được quyền bất cứ lúc nào bằng cách xoá quan hệ tin cậy hoặc vô hiệu khoá trong tài khoản cloud.",
          ],
        },
        {
          title: "5. Sử dụng được phép",
          body: [
            "Không dùng UDP để vi phạm pháp luật, tấn công hệ thống khác, phát tán mã độc, đào tiền mã hoá trên tài nguyên không thuộc quyền của bạn, hay làm quá tải nền tảng.",
            "Không dò, vượt hoặc phá các cơ chế bảo mật của UDP.",
          ],
        },
        {
          title: "6. Giai đoạn thử nghiệm",
          body: [
            "Trong giai đoạn thử nghiệm, UDP không cam kết mức độ sẵn sàng (SLA). Tính năng có thể đổi hoặc dừng; thay đổi lớn ảnh hưởng tới dữ liệu của bạn sẽ được báo trước.",
          ],
        },
        {
          title: "7. Dữ liệu của bạn",
          body: [
            "Cấu hình, flag, segment và dữ liệu khác bạn đưa vào UDP là của bạn. UDP xử lý chúng chỉ để cung cấp dịch vụ, theo Chính sách quyền riêng tư.",
          ],
        },
        {
          title: "8. Ngừng dùng",
          body: [
            "Bạn có thể ngừng dùng bất cứ lúc nào. Tài nguyên trong tài khoản cloud của bạn vẫn là của bạn; bạn quyết định giữ hay xoá.",
            "UDP có thể khoá tài khoản vi phạm Mục 5 sau khi xác minh.",
          ],
        },
        {
          title: "9. Giới hạn trách nhiệm",
          body: [
            "Trong giai đoạn thử nghiệm miễn phí, UDP được cung cấp theo hiện trạng. Trong phạm vi pháp luật cho phép, UDP không chịu trách nhiệm cho thiệt hại gián tiếp, kể cả chi phí cloud phát sinh từ cấu hình của bạn.",
          ],
        },
        {
          title: "10. Luật áp dụng và thay đổi",
          body: [
            "Điều khoản này theo pháp luật Việt Nam.",
            "Mỗi bản có ngày làm phiên bản (ghi ở đầu trang). Khi có thay đổi quan trọng, bạn sẽ được hỏi đồng ý lại.",
          ],
        },
      ],
    } satisfies LegalDoc,
    privacy: {
      title: "Chính sách quyền riêng tư",
      lead: "UDP giữ dữ liệu nào, để làm gì, ở đâu, bao lâu, chia sẻ với ai, và bạn có quyền gì. Viết theo Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.",
      sections: [
        {
          title: "1. Dữ liệu UDP giữ",
          body: [
            "• Tài khoản: tên, email, mật khẩu đã băm bằng bcrypt (UDP không biết mật khẩu của bạn), vai trên nền tảng, phiên bản Điều khoản bạn đồng ý và thời điểm đồng ý.",
            "• Đăng nhập GitHub (nếu dùng): id số của tài khoản GitHub và email chính đã xác minh. UDP không lưu token của GitHub.",
            "• Phiên đăng nhập: chỉ bản băm của token, kèm trình duyệt và địa chỉ IP để bạn thấy thiết bị nào đang đăng nhập.",
            "• Project: cấu hình, flag, segment (có thể chứa id người dùng của ứng dụng bạn do bạn nhập), rollout, lịch sử deploy, nhật ký thao tác kèm địa chỉ IP và trình duyệt.",
            "• Cloud: liên kết danh tính không chứa bí mật; khoá tĩnh (nếu bạn chọn) được mã hoá AES-256-GCM trước khi lưu.",
            "• Số đếm đánh giá flag theo variant, không kèm thông tin người dùng cuối.",
          ],
        },
        {
          title: "2. Để làm gì",
          body: [
            "Cung cấp dịch vụ; giữ an toàn tài khoản (phát hiện phiên bị nhân bản, giới hạn số lần đăng nhập); gửi thư đặt lại mật khẩu khi bạn xin. UDP không bán dữ liệu, không chạy quảng cáo, và không gắn công cụ phân tích hành vi của bên thứ ba.",
          ],
        },
        {
          title: "3. Ở đâu",
          body: [
            "Dữ liệu tài khoản và cấu hình nằm trong cơ sở dữ liệu PostgreSQL của triển khai UDP này, có thể ở ngoài Việt Nam. Hạ tầng và ứng dụng của bạn nằm trong tài khoản cloud của chính bạn, ở region bạn chọn.",
          ],
        },
        {
          title: "4. Bên thứ ba nhận dữ liệu",
          body: [
            "• Nhà cung cấp cloud của bạn: khi UDP gọi API của họ thay bạn.",
            "• GitHub: khi bạn chọn đăng nhập bằng GitHub.",
            "• Dịch vụ gửi thư: email của bạn, khi bạn xin đặt lại mật khẩu.",
            "• Google Fonts: trình duyệt của bạn tải phông chữ từ Google, nên Google nhận địa chỉ IP của bạn.",
          ],
        },
        {
          title: "5. Cookie và lưu trữ trên trình duyệt",
          body: [
            "• udp_access, udp_refresh, udp_csrf: giữ phiên đăng nhập và chống giả mạo yêu cầu. Bắt buộc để đăng nhập.",
            "• udp_oauth: sống 10 phút trong lúc đăng nhập bằng GitHub.",
            "• Lưu trữ cục bộ: ngôn ngữ, giao diện sáng/tối, phím tắt bạn chọn; lời mời đang mở dở.",
            "UDP không dùng cookie quảng cáo hay cookie theo dõi.",
          ],
        },
        {
          title: "6. Giữ bao lâu",
          body: [
            "Tài khoản và project: tới khi bạn xoá hoặc xin xoá. Phiên đăng nhập: 7 ngày. Đường dẫn đặt lại mật khẩu: 30 phút, dùng một lần. Nhật ký thao tác là bản ghi chỉ ghi thêm, giữ để bảo đảm trách nhiệm giải trình.",
          ],
        },
        {
          title: "7. Quyền của bạn",
          body: [
            "Bạn có quyền được biết, đồng ý hoặc rút lại đồng ý, truy cập, chỉnh sửa, xoá, hạn chế xử lý, nhận bản sao, phản đối xử lý dữ liệu cá nhân của mình, và khiếu nại. Gửi yêu cầu cho người vận hành triển khai UDP này; yêu cầu được trả lời trong thời hạn pháp luật quy định.",
          ],
        },
        {
          title: "8. Bảo mật",
          body: [
            "Mật khẩu băm bcrypt; token phiên, lời mời và đặt lại mật khẩu chỉ lưu bản băm; khoá cloud mã hoá; cookie đăng nhập httpOnly; mỗi service chỉ có quyền trên đúng những bảng nó cần.",
          ],
        },
        {
          title: "9. Thay đổi",
          body: [
            "Mỗi bản có ngày làm phiên bản. Khi thay đổi ảnh hưởng tới quyền của bạn, bạn sẽ được báo và hỏi đồng ý lại.",
          ],
        },
      ],
    } satisfies LegalDoc,
  },
  en: {
    updated: (date: string, version: string) =>
      `Last updated ${date} · version ${version}`,
    home: "UDP, back to the home page",
    toc: "Contents",
    otherTerms: "Terms of Service",
    otherPrivacy: "Privacy Policy",
    terms: {
      title: "Terms of Service",
      lead: "What you and UDP agree to when you create an account and use the platform. Read together with the Privacy Policy.",
      sections: [
        {
          title: "1. What UDP is",
          body: [
            "UDP is a configurable DevOps platform: you connect your own cloud account (AWS, Google Cloud or Azure), pick a tool for each domain, and UDP builds, observes and ships your application on that infrastructure.",
            "UDP is in beta and free. There is no paid plan yet.",
          ],
        },
        {
          title: "2. Accounts",
          body: [
            "Use accurate details when you sign up, keep your password secret, and you are responsible for everything done under your account.",
            "UDP is for people aged 16 and over.",
            "You can sign in with email and password, or with GitHub when this deployment enables it.",
          ],
        },
        {
          title: "3. Infrastructure and cloud costs",
          body: [
            "The network, cluster and tools UDP builds live in YOUR cloud account. Your cloud provider bills you directly; UDP neither collects nor covers that bill.",
            "Each project starts with safe resource limits so a bug does not become a big bill, but actual costs depend on your configuration and usage. Watching your cloud bill is up to you.",
          ],
        },
        {
          title: "4. Cloud access",
          body: [
            "You give UDP access to your cloud account through identity federation (IAM role, Workload Identity, federated credential) or a static key. UDP uses that access only to do what you ask for in the Portal.",
            "You can revoke access at any time by deleting the trust relationship or disabling the key in your cloud account.",
          ],
        },
        {
          title: "5. Acceptable use",
          body: [
            "Do not use UDP to break the law, attack other systems, spread malware, mine cryptocurrency on resources you do not own, or overload the platform.",
            "Do not probe, bypass or break UDP's security controls.",
          ],
        },
        {
          title: "6. Beta",
          body: [
            "During the beta UDP makes no availability commitment (SLA). Features may change or stop; major changes that affect your data will be announced in advance.",
          ],
        },
        {
          title: "7. Your data",
          body: [
            "The configuration, flags, segments and other data you put into UDP are yours. UDP processes them only to provide the service, as described in the Privacy Policy.",
          ],
        },
        {
          title: "8. Leaving",
          body: [
            "You can stop using UDP at any time. Resources in your cloud account remain yours; you decide whether to keep or delete them.",
            "UDP may suspend an account that breaks Section 5, after verifying it.",
          ],
        },
        {
          title: "9. Limitation of liability",
          body: [
            "During the free beta, UDP is provided as is. To the extent the law allows, UDP is not liable for indirect damages, including cloud costs that arise from your configuration.",
          ],
        },
        {
          title: "10. Governing law and changes",
          body: [
            "These terms are governed by the laws of Vietnam.",
            "Every version is dated (shown at the top). When something important changes, you will be asked to agree again.",
          ],
        },
      ],
    },
    privacy: {
      title: "Privacy Policy",
      lead: "What data UDP keeps, why, where, for how long, who receives it, and what rights you have. Written under Vietnam's Decree 13/2023/ND-CP on personal data protection.",
      sections: [
        {
          title: "1. Data UDP keeps",
          body: [
            "• Account: name, email, bcrypt-hashed password (UDP never knows your password), platform role, and which version of the Terms you accepted and when.",
            "• GitHub sign-in (if used): your GitHub numeric id and verified primary email. UDP does not store GitHub tokens.",
            "• Sessions: only a hash of each token, with browser and IP address so you can see which devices are signed in.",
            "• Projects: configuration, flags, segments (which may hold user ids of your application that you enter), rollouts, deploy history, and an audit log with IP address and browser.",
            "• Cloud: identity federation holds no secret; static keys (if you choose them) are encrypted with AES-256-GCM before storage.",
            "• Flag evaluation counts per variant, with no end-user information.",
          ],
        },
        {
          title: "2. Why",
          body: [
            "To provide the service; to keep accounts safe (detecting cloned sessions, limiting sign-in attempts); to send a password reset email when you ask. UDP does not sell data, run ads, or embed third-party behavioural analytics.",
          ],
        },
        {
          title: "3. Where",
          body: [
            "Account and configuration data live in the PostgreSQL database of this UDP deployment, which may be outside Vietnam. Your infrastructure and application live in your own cloud account, in the region you choose.",
          ],
        },
        {
          title: "4. Third parties that receive data",
          body: [
            "• Your cloud provider: when UDP calls their API on your behalf.",
            "• GitHub: when you choose to sign in with GitHub.",
            "• The email service: your email address, when you request a password reset.",
            "• Google Fonts: your browser loads fonts from Google, so Google receives your IP address.",
          ],
        },
        {
          title: "5. Cookies and browser storage",
          body: [
            "• udp_access, udp_refresh, udp_csrf: keep you signed in and prevent request forgery. Required to sign in.",
            "• udp_oauth: lives for 10 minutes while you sign in with GitHub.",
            "• Local storage: your language, light/dark theme and shortcut choices; a pending invitation.",
            "UDP uses no advertising or tracking cookies.",
          ],
        },
        {
          title: "6. How long",
          body: [
            "Accounts and projects: until you delete them or ask for deletion. Sessions: 7 days. Password reset links: 30 minutes, single use. The audit log is append-only and kept for accountability.",
          ],
        },
        {
          title: "7. Your rights",
          body: [
            "You have the right to be informed, to consent or withdraw consent, to access, correct, delete, restrict, receive a copy of, and object to the processing of your personal data, and to complain. Send requests to the operator of this UDP deployment; they are answered within the time the law requires.",
          ],
        },
        {
          title: "8. Security",
          body: [
            "Passwords are bcrypt-hashed; session, invitation and password reset tokens are stored only as hashes; cloud keys are encrypted; sign-in cookies are httpOnly; each service has rights only on the tables it needs.",
          ],
        },
        {
          title: "9. Changes",
          body: [
            "Every version is dated. When a change affects your rights, you will be told and asked to agree again.",
          ],
        },
      ],
    },
  },
});
