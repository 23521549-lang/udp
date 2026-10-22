import { CLOUD_ERROR_SLUGS } from "@udp/shared-types/cloud-api";
import { DOMAIN_ERROR_SLUGS } from "@udp/shared-types/domain-api";
import { ENVIRONMENT_ERROR_SLUGS } from "@udp/shared-types/environment-api";
import { CSRF_INVALID_SLUG, type ErrorCode } from "@udp/shared-types/problem";
import { PROVISION_ERROR_SLUGS } from "@udp/shared-types/provisioning-api";
import { defineMessages } from "../i18n";

/**
 * Câu cho các mã lỗi của §9 — bất biến I37: `title` của catalog là KHOÁ, câu hiển thị thuộc về frontend.
 *
 * `code` là `Record<ErrorCode, string>` chứ không phải object tự do: thêm mã vào catalog mà quên câu là lỗi
 * biên dịch — ở CẢ HAI ngôn ngữ, vì bản `en` có đúng kiểu của bản `vi`.
 */
const vi = {
  code: {
    MISSING_CAPABILITY: "Thiếu một năng lực mà công cụ này cần.",
    MISSING_ANY_OF: "Cần bật ít nhất một trong các năng lực bắt buộc.",
    VERSION_MISMATCH: "Phiên bản năng lực không tương thích.",
    CONFLICT: "Hai công cụ cùng đòi một năng lực độc quyền.",
    AMBIGUOUS_PROVIDER:
      "Có nhiều nguồn cùng cung cấp năng lực này, hãy chọn một.",
    RECOMMENDED_MISSING: "Nên bật thêm một năng lực được khuyến nghị.",
    CYCLIC_DEPENDENCY: "Cấu hình domain có vòng phụ thuộc.",
    CLOUD_MISMATCH:
      "Công cụ này chỉ chạy trên một cloud khác cloud của project.",
    ORPHAN_RULE: "Có rule trỏ tới một variant không còn tồn tại.",
    VARIANT_IN_USE: "Variant này vẫn đang được một rule dùng.",
    METRICS_NOT_AVAILABLE: "Nguồn metrics chưa có dữ liệu cho workload này.",
    TRACKED_FLAG_LIMIT: "Environment này đã theo dõi quá nhiều flag cùng lúc.",
    FLAG_RECENTLY_EVALUATED:
      "Flag vẫn đang được đánh giá gần đây, chưa lưu trữ được.",
    SEGMENT_IN_USE: "Segment vẫn đang được rule của flag dùng.",
    INSUFFICIENT_PERMISSIONS: "Credential cloud thiếu quyền cần thiết.",
    QUOTA_EXCEEDED: "Vượt trần tài nguyên của project.",
    CLUSTER_UNREACHABLE: "Không kết nối được tới cluster.",
    ROLLOUT_IN_PROGRESS: "Đang có một rollout chạy trên đối tượng này.",
    DUPLICATE_RESOURCE: "Tên hoặc key này đã tồn tại.",
    OPTIMISTIC_LOCK:
      "Dữ liệu vừa được người khác sửa. Đã tải lại bản mới, hãy xem rồi lưu lại.",
    CONFIRMATION_REQUIRED: "Thao tác này cần xác nhận bằng cách gõ lại key.",
    PRECONDITION_FAILED: "Điều kiện của thao tác không còn đúng.",
    PROVIDER_UNAVAILABLE:
      "Một dịch vụ phụ thuộc đang không phản hồi. Thử lại sau.",
    IDEMPOTENCY_KEY_REUSED: "Yêu cầu bị gửi trùng với nội dung khác.",
    EGRESS_BLOCKED: "Địa chỉ đích bị chặn vì lý do an toàn.",
  } satisfies Record<ErrorCode, string>,
  status: {
    400: "Dữ liệu gửi lên không hợp lệ.",
    401: "Phiên đăng nhập đã hết hạn.",
    403: "Bạn không có quyền làm việc này.",
    404: "Không tìm thấy dữ liệu.",
    413: "Dữ liệu gửi lên quá lớn.",
    429: "Thao tác quá nhanh. Đợi một chút rồi thử lại.",
  } as Record<number, string>,
  /**
   * [v4.11] Lỗi KHÔNG có mã nghiệp vụ nhưng có slug `type` riêng — hai lỗi cùng status mà người dùng cần hai
   * câu khác nhau (403 vì CSRF khác 403 vì thiếu quyền). Slug không có ở đây thì đi tiếp các nhánh sau, và
   * `detail` của máy chủ vẫn được dùng.
   */
  slug: {
    [CSRF_INVALID_SLUG]: "Phiên làm việc đã đổi. Tải lại trang rồi thử lại.",
    [CLOUD_ERROR_SLUGS.notConfigured]:
      "Project chưa cấu hình cloud. Lưu credential trước rồi kiểm tra.",
    [DOMAIN_ERROR_SLUGS.needsApplyJob]:
      "Project đang có lượt triển khai chạy. Lưu cấu hình domain sau khi lượt đó xong.",
    [DOMAIN_ERROR_SLUGS.notRunning]:
      "Domain này không chạy trên cluster của project.",
    [DOMAIN_ERROR_SLUGS.upToDate]: "Domain đã ở bản mới nhất máy chủ có.",
    [DOMAIN_ERROR_SLUGS.notRetryable]:
      "Domain này chưa áp lại được: đang có lượt triển khai, chưa từng triển khai, hoặc cần nâng cấp trước.",
    [DOMAIN_ERROR_SLUGS.versionUnavailable]:
      "Máy chủ vừa đổi bản adapter. Mở lại hộp nâng cấp để xem bản mới.",
    [DOMAIN_ERROR_SLUGS.costNotEnabled]:
      "Project chưa bật Cost Management: bật OpenCost hay Kubecost ở trang Domain.",
    [DOMAIN_ERROR_SLUGS.metricsNotEnabled]:
      "Project chưa có nguồn số đo: bật domain Monitoring ở trang Domain để xem request, lỗi và độ trễ.",
    [CLOUD_ERROR_SLUGS.methodUnavailable]:
      "Cách xác thực này chưa được bật trên máy chủ UDP. Chọn cách khác hoặc báo quản trị.",
    [PROVISION_ERROR_SLUGS.blocked]:
      "Chưa triển khai được. Xem lý do ở phần xem trước.",
    [PROVISION_ERROR_SLUGS.notCancellable]:
      "Lượt này đã qua điểm hủy được: đang dọn tài nguyên hoặc đã kết thúc.",
    [PROVISION_ERROR_SLUGS.credentialLocked]:
      "Đang có lượt triển khai dùng credential hiện tại. Đổi sau khi lượt đó kết thúc.",
    [PROVISION_ERROR_SLUGS.notRetryable]:
      "Chỉ thử lại được lượt thêm/bớt environment đã thất bại.",
    [ENVIRONMENT_ERROR_SLUGS.limit]:
      "Project đã đủ số environment tối đa. Xoá một environment không dùng trước.",
    [ENVIRONMENT_ERROR_SLUGS.last]:
      "Không xoá được environment cuối cùng của project.",
    [ENVIRONMENT_ERROR_SLUGS.rolloutActive]:
      "Environment còn rollout đang chạy. Kết thúc rollout trước khi xoá.",
    [ENVIRONMENT_ERROR_SLUGS.flagsEnabled]:
      "Environment còn flag đang bật. Tắt các flag đó trước khi xoá.",
    [ENVIRONMENT_ERROR_SLUGS.hasHistory]:
      "Environment đã có lịch sử (SDK key, deploy, bật tắt flag) nên được giữ lại: lịch sử không bị xoá theo.",
    [ENVIRONMENT_ERROR_SLUGS.projectBusy]:
      "Project đang có một lượt triển khai chạy. Thử lại khi lượt đó xong.",
  } as Record<string, string>,
  unexpected: "Có lỗi không mong đợi.",
  network: "Mất kết nối tới máy chủ.",
  contract:
    "Phản hồi của máy chủ không đúng định dạng. Tải lại trang, nếu vẫn lỗi hãy báo cho quản trị.",
  withTrace: (text: string, traceId: string) =>
    `${text} Mã tra cứu: ${traceId}`,
  system: (traceId: string) => `Lỗi hệ thống. Mã tra cứu: ${traceId}`,
  generic: "Có lỗi xảy ra.",
};

export const errorsMessages = defineMessages({
  vi,
  en: {
    code: {
      MISSING_CAPABILITY: "A capability this tool needs is missing.",
      MISSING_ANY_OF: "Enable at least one of the required capabilities.",
      VERSION_MISMATCH: "The capability version is not compatible.",
      CONFLICT: "Two tools claim the same exclusive capability.",
      AMBIGUOUS_PROVIDER:
        "Several sources provide this capability. Choose one.",
      RECOMMENDED_MISSING: "A recommended capability is not enabled.",
      CYCLIC_DEPENDENCY: "The domain configuration has a dependency cycle.",
      CLOUD_MISMATCH:
        "This tool only runs on a different cloud than the project's.",
      ORPHAN_RULE: "A rule points to a variant that no longer exists.",
      VARIANT_IN_USE: "This variant is still used by a rule.",
      METRICS_NOT_AVAILABLE:
        "The metrics source has no data for this workload yet.",
      TRACKED_FLAG_LIMIT:
        "This environment is already tracking too many flags at once.",
      FLAG_RECENTLY_EVALUATED:
        "The flag was evaluated recently and cannot be archived yet.",
      SEGMENT_IN_USE: "This segment is still used by a flag rule.",
      INSUFFICIENT_PERMISSIONS:
        "The cloud credential lacks the required permissions.",
      QUOTA_EXCEEDED: "The project's resource quota was exceeded.",
      CLUSTER_UNREACHABLE: "Could not reach the cluster.",
      ROLLOUT_IN_PROGRESS: "A rollout is already running on this target.",
      DUPLICATE_RESOURCE: "This name or key already exists.",
      OPTIMISTIC_LOCK:
        "Someone else just changed this data. The latest version was loaded; review it and save again.",
      CONFIRMATION_REQUIRED: "Confirm this action by typing the key again.",
      PRECONDITION_FAILED: "A precondition of this action no longer holds.",
      PROVIDER_UNAVAILABLE:
        "A dependent service is not responding. Try again later.",
      IDEMPOTENCY_KEY_REUSED: "This request was resent with different content.",
      EGRESS_BLOCKED: "The destination address is blocked for safety.",
    },
    status: {
      400: "The submitted data is invalid.",
      401: "Your session has expired.",
      403: "You do not have permission to do this.",
      404: "The data was not found.",
      413: "The submitted data is too large.",
      429: "Too many requests. Wait a moment and try again.",
    },
    slug: {
      [CSRF_INVALID_SLUG]:
        "Your session changed. Reload the page and try again.",
      [CLOUD_ERROR_SLUGS.notConfigured]:
        "The project has no cloud configured. Save a credential first, then validate it.",
      [DOMAIN_ERROR_SLUGS.needsApplyJob]:
        "A deployment run is in progress. Save the domain configuration after it finishes.",
      [DOMAIN_ERROR_SLUGS.notRunning]:
        "This domain is not running on the project's cluster.",
      [DOMAIN_ERROR_SLUGS.upToDate]:
        "This domain is already on the newest version the server has.",
      [DOMAIN_ERROR_SLUGS.notRetryable]:
        "This domain cannot be reapplied yet: a deployment is running, it was never deployed, or it needs an upgrade first.",
      [DOMAIN_ERROR_SLUGS.versionUnavailable]:
        "The server just changed the adapter version. Reopen the upgrade dialog to see the new one.",
      [DOMAIN_ERROR_SLUGS.costNotEnabled]:
        "Cost Management is not enabled: turn on OpenCost or Kubecost on the Domains page.",
      [DOMAIN_ERROR_SLUGS.metricsNotEnabled]:
        "The project has no metrics source: enable the Monitoring domain on the Domains page to see requests, errors and latency.",
      [CLOUD_ERROR_SLUGS.methodUnavailable]:
        "This authentication method is not enabled on the UDP server. Choose another one or contact an administrator.",
      [PROVISION_ERROR_SLUGS.blocked]:
        "Cannot deploy yet. See the reasons in the preview.",
      [PROVISION_ERROR_SLUGS.notCancellable]:
        "This run is past the point where it can be cancelled: it is cleaning up or already finished.",
      [PROVISION_ERROR_SLUGS.credentialLocked]:
        "A deployment run is using the current credential. Change it after the run ends.",
      [PROVISION_ERROR_SLUGS.notRetryable]:
        "Only a failed environment add/remove run can be retried.",
      [ENVIRONMENT_ERROR_SLUGS.limit]:
        "The project already has the maximum number of environments. Delete an unused one first.",
      [ENVIRONMENT_ERROR_SLUGS.last]:
        "The project's last environment cannot be deleted.",
      [ENVIRONMENT_ERROR_SLUGS.rolloutActive]:
        "The environment still has a running rollout. Finish it before deleting.",
      [ENVIRONMENT_ERROR_SLUGS.flagsEnabled]:
        "The environment still has enabled flags. Turn them off before deleting.",
      [ENVIRONMENT_ERROR_SLUGS.hasHistory]:
        "The environment has history (SDK keys, deployments, flag changes), so it is kept: history is never deleted with it.",
      [ENVIRONMENT_ERROR_SLUGS.projectBusy]:
        "A deployment run is in progress on the project. Try again when it finishes.",
    },
    unexpected: "Something unexpected went wrong.",
    network: "Lost connection to the server.",
    contract:
      "The server response is not in the expected format. Reload the page; if it persists, tell an administrator.",
    withTrace: (text: string, traceId: string) =>
      `${text} Reference: ${traceId}`,
    system: (traceId: string) => `System error. Reference: ${traceId}`,
    generic: "Something went wrong.",
  },
});
