/**
 * Hằng số nghiệp vụ dùng chung cho cả 3 service.
 *
 * Nguyên tắc: KHÔNG viết số hoặc chuỗi nghiệp vụ trực tiếp trong code.
 * Mọi giá trị có thể phải chỉnh đều nằm ở đây (nếu cố định theo thiết kế)
 * hoặc ở `env` (nếu khác nhau giữa các môi trường).
 *
 * Ranh giới giữa hai nơi:
 *   - constants.ts : giá trị do THIẾT KẾ quy định, giống nhau ở mọi môi trường
 *   - env.ts       : giá trị do MÔI TRƯỜNG quy định, khác nhau giữa dev và prod
 */

// ============================================================
// Environment mặc định khi tạo project (Design v4 §2.2)
// ============================================================

export const DEFAULT_ENVIRONMENTS = [
  { name: "dev", rank: 0, isProduction: false },
  { name: "staging", rank: 1, isProduction: false },
  { name: "prod", rank: 2, isProduction: true },
] as const;

/** Nhãn DNS-1123: chữ thường, số, gạch ngang; bắt đầu và kết thúc bằng chữ-số */
export const K8S_NAMESPACE_MAX_LENGTH = 63;

/** Cắt phần tên project TRƯỚC khi nối hậu tố — xem `k8sNamespaceFor` */
const PROJECT_SLUG_MAX = 20;
const ENV_SLUG_MAX = 12;
const PROJECT_ID_SUFFIX_LENGTH = 6;

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Tên DNS-1123 subdomain (tối đa 253, các nhãn nối bằng dấu chấm) — dạng tên của
 * Deployment/Service Kubernetes, tức `workload_name` của rollout (cột
 * `VARCHAR(253)`, §2.2) và nhãn `service_name` mà mọi truy vấn §7.4 lọc theo.
 */
export const DNS_1123_SUBDOMAIN =
  /^(?=.{1,253}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * Bỏ dấu tiếng Việt rồi rút về nhãn DNS-1123.
 *
 * `normalize("NFD")` tách nguyên âm khỏi dấu thanh để `\p{M}` xoá được phần
 * dấu. Riêng `đ`/`Đ` không phải nguyên âm ghép nên NFD không tách ra, phải thay
 * tay — thiếu dòng đó thì mọi chữ `đ` biến thành gạch ngang.
 */
const toLabel = (value: string, max: number): string =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");

/**
 * [v4.11] Tên workload mà template pipeline Golden Path dựng cho project (§11, Plan #36): một
 * Deployment và container CÙNG tên — thứ webhook deploy đổi image (§8.3). Cùng luật bỏ dấu với
 * namespace; tên project không còn ký tự nào dùng được ⇒ `app`.
 */
const WORKLOAD_SLUG_MAX = 40;

export const workloadSlugFor = (projectName: string): string =>
  toLabel(projectName, WORKLOAD_SLUG_MAX) || "app";

/**
 * Sinh namespace K8s cho một environment.
 *
 * Bản trước — `udp-{project}-{env}` rồi `slice(0, 63)` — hỏng ba cách, cả ba
 * đều đã đo được chứ không phải suy đoán:
 *
 *  1. Tên project dài 64 ký tự làm `dev`, `staging` và `prod` ra CÙNG MỘT
 *     chuỗi, vì phép cắt ăn mất đúng phần hậu tố phân biệt chúng. Hai
 *     environment lẽ ra cô lập lại dùng chung một namespace — phá ranh giới của
 *     ADR-04 và T10, và không index nào bắt được.
 *  2. `"Dự án Bán hàng"` và `"Dứ àn Bán hàng"` cùng ra `udp-d---n-b-n-h-ng-dev`,
 *     vì mọi ký tự có dấu đều bị thay bằng `-`.
 *  3. Tên dài 58 hoặc 63 ký tự cho ra chuỗi kết thúc bằng `-`, vi phạm
 *     DNS-1123 — API server từ chối, nhưng mãi tới lúc provisioning, rất xa chỗ
 *     gây ra lỗi.
 *
 * Ba biện pháp tương ứng: cắt tên project TRƯỚC khi nối env, bỏ dấu thay vì
 * thay bằng `-`, và trim gạch ngang sau mỗi lần cắt. Sáu ký tự đầu của
 * `projectId` chặn va chạm giữa hai project khác tên nhưng cùng slug.
 *
 * Vẫn ném khi kết quả không hợp lệ. Không phải phòng xa thừa: chuỗi này đi
 * thẳng vào API server, nên chỗ rẻ nhất để phát hiện sai là ngay đây.
 */
export function k8sNamespaceFor(
  projectName: string,
  projectId: string,
  envName: string,
): string {
  const project = toLabel(projectName, PROJECT_SLUG_MAX) || "p";
  const env = toLabel(envName, ENV_SLUG_MAX) || "e";
  const suffix = projectId
    .replace(/-/g, "")
    .slice(0, PROJECT_ID_SUFFIX_LENGTH)
    .toLowerCase();

  const namespace = `udp-${project}-${suffix}-${env}`;

  if (
    namespace.length > K8S_NAMESPACE_MAX_LENGTH ||
    !DNS_1123_LABEL.test(namespace)
  ) {
    throw new Error(
      `Không sinh được namespace hợp lệ từ project "${projectName}" và environment ` +
        `"${envName}": kết quả "${namespace}" không phải nhãn DNS-1123.`,
    );
  }

  return namespace;
}

// ============================================================
// Feature flag (Design v4 §6)
// ============================================================

/**
 * Tổng số bucket cho percentage targeting.
 * 100_000 cho phép ngưỡng tới 0.001% — nhu cầu thật khi canary trên traffic lớn.
 * ĐỔI GIÁ TRỊ NÀY LÀ THAY ĐỔI PHÁ VỠ: mọi người dùng sẽ được phân lại nhóm.
 */
export const TOTAL_BUCKETS = 100_000;

/**
 * Thuộc tính mặc định dùng để hash khi flag không chỉ định rõ.
 *
 * `targetingKey` chứ không phải `userId`: đó là tên chuẩn của OpenFeature cho
 * định danh chính trong evaluation context, nên SDK của bất kỳ ngôn ngữ nào cũng
 * điền sẵn. Dùng `userId` buộc mọi ứng dụng phải tự map lại (§6.4).
 */
export const DEFAULT_STICKINESS_ATTRIBUTE = "targetingKey";

/** Variant tự sinh cho flag kiểu BOOLEAN */
export const BOOLEAN_VARIANTS = { ON: "on", OFF: "off" } as const;

/** Ngưỡng cảnh báo flag chết (Design v4 §6.7) */
export const STALE_FLAG_THRESHOLDS = {
  /** ACTIVE nhưng không có lượt đánh giá nào trong N ngày */
  unusedDays: 30,
  /** 100% lượt đánh giá rơi vào cùng một variant suốt N ngày */
  settledDays: 14,
  /** DRAFT quá N ngày mà chưa từng ACTIVE */
  staleDraftDays: 30,
  /**
   * [v4.9] Chặn ARCHIVE flag còn được đánh giá trong N ngày gần nhất (409
   * `FLAG_RECENTLY_EVALUATED`). Không còn "chặn xoá": flag không bao giờ bị xoá.
   */
  archiveGuardDays: 7,
  /**
   * [v4.9] SETTLED cần ít nhất chừng này lượt trong cửa sổ `settledDays`: vài lượt
   * lẻ cùng rơi vào một variant chưa nói được flag đã "ổn định".
   */
  settledMinEvals: 100,
  /**
   * [v4.9] Số flag tối đa của một lần archive hàng loạt. Mỗi flag là một lời gọi
   * S2 tuần tự (fan-out mọi env): 20 × ~2,2 s ≈ 44 s, dưới hạn 60 s của proxy
   * thường gặp.
   */
  bulkArchiveMax: 20,
  /**
   * [v4.9] Env có CLIENT key được dùng trong N ngày ⇒ `clientTrafficUnobserved`:
   * OFREP bulk không đếm, nên flag chỉ đọc qua bulk trông như không ai gọi.
   */
  clientTrafficDays: 30,
  /**
   * [v4.9] Env có SERVER key được dùng trong N ngày mà không có hàng stats nào ⇒
   * `telemetryGaps` (app đặt `reportStats: false` hoặc provider cũ).
   */
  telemetryGapDays: 7,
} as const;

/**
 * [v4.6] Giới hạn của điều kiện targeting (§6.5) — MỘT bộ số cho schema GHI
 * (S2 từ chối lúc lưu) và lõi ĐÁNH GIÁ (SDK, OFREP). Mỗi số chặn một kiểu tốn
 * kém: danh sách `in` dài là bộ nhớ của Set dựng sẵn; pattern và chuỗi đem so
 * regex dài là CPU của một endpoint công khai (OFREP) — JS không có timeout cho
 * regex, nên trần độ dài chuỗi đầu vào là lớp chặn cuối cùng lúc đánh giá.
 */
export const CONDITION_LIMITS = {
  attributeMaxLength: 100,
  conditionsPerRule: 20,
  inValuesMax: 1000,
  stringValueMax: 256,
  regexPatternMax: 200,
  /** Chuỗi ngữ cảnh dài hơn ⇒ `regex` trả false, không chạy */
  regexInputMax: 256,
  /**
   * Số pattern `regex` KHÁC NHAU tối đa trong một lần ghi. Mỗi pattern là tới
   * `regexCheckTimeoutMs` phân tích ReDoS ở Service 2 (trong worker, không chặn
   * event loop) — trần này giữ tổng thời gian dưới hạn chờ 30 s của Service 1.
   */
  regexPatternsPerWrite: 20,
  /** Hạn phân tích ReDoS cho MỘT pattern; hết hạn ⇒ từ chối như `vulnerable` */
  regexCheckTimeoutMs: 1_000,
  userIdsMax: 10_000,
  userIdMaxLength: 256,
} as const;

/**
 * [v4.9] Segment (§2.2, §6.5). Snapshot và `config_hash` của MỌI environment chứa
 * mọi segment của project, nên mỗi trần ở đây là trần của bộ nhớ và băng thông
 * trên mọi replica, không chỉ của một bảng.
 */
export const SEGMENT = {
  /** Trần số segment mỗi project (422 `QUOTA_EXCEEDED`) */
  maxPerProject: 100,
  /** Chi tiết segment liệt kê tối đa chừng này flag đang dùng nó */
  referencesInView: 50,
  /**
   * Trần body ghi segment ở Service 1. Mọi body hợp lệ theo schema ở trần userIds
   * đều lọt:
   *   - userIds: 10 000 × (256 × 6 + 3) = 15 390 000 B (6 B là một đơn vị UTF-16
   *     escape `\uXXXX`, trường hợp xấu nhất);
   *   - `all` ngang rule path: 1 048 576 B;
   *   - vỏ (tên, mô tả, mốc): 16 384 B;
   *   - tổng 16 454 960 B, làm tròn lên 16 MiB.
   */
  writeBodyLimitBytes: 16 * 1024 * 1024,
  /**
   * Parser của `/internal/segments` ở Service 2: S1 serialize lại body và thêm
   * `projectId`, nên cần một khoảng dư — không thì body sát trần qua S1 nhận 413
   * từ S2, mã S1 không relay, và người dùng thấy 500.
   */
  internalBodyLimitBytes: 16 * 1024 * 1024 + 64 * 1024,
  /**
   * Trần TỔNG `conditions` của mọi segment trong một project, kiểm dưới khoá env
   * lúc tạo và sửa.
   *
   * [v4.10] Thước đo là `octet_length(conditions::text)` của jsonb — thứ SQL
   * cộng được ngay tại chỗ dữ liệu nằm, dưới khoá, không kéo 4 MiB về JS (F6/F7).
   * Trước đó chú thích này nói "canonical JSON" trong khi cưỡng chế bằng jsonb,
   * mà jsonb::text dài hơn canonical ÍT NHẤT bằng số dấu `,` và `:` (Postgres in
   * thêm một khoảng trắng sau mỗi dấu), nên một segment có canonical ĐÚNG bằng
   * trần vẫn bị từ chối. Một trần thì phải có một thước; `segmentPayloadBytesOf`
   * ở JS là chặn dưới của thước này, dùng để từ chối sớm.
   *
   * 4 MiB = 1,61 × segment ASCII lớn nhất theo trần từng segment (canonical
   * 10 000 × (256 + 2) + 9 999 + 23 = 2 590 022 B, đo bằng thước trên là
   * + 10 000 dấu `,` + 2 dấu `:` = 2 600 024 B), nên một segment như vậy luôn
   * lưu được khi project còn trống. Bộ nhớ S2 cho một env ở trần ≈ 26 MiB mỗi
   * replica (hai slot SERVER/CLIENT, mỗi slot giữ snapshot, bản prepared, chunk
   * SSE và body `/sdk/config`); 8 MiB là gấp đôi.
   */
  maxProjectBytes: 4 * 1024 * 1024,
} as const;

// ============================================================
// Progressive delivery (Design v4 §7)
// ============================================================

/** Ngưỡng mặc định khi người dùng không chỉ định lúc tạo rollout (§7.1, §7.4) */
export const DEFAULT_ROLLOUT_THRESHOLDS = {
  /** Ngưỡng TUYỆT ĐỐI cho error rate của nhánh canary */
  errorRate: 0.05,
  /**
   * Ngưỡng TƯƠNG ĐỐI so với nhánh baseline. Cần vì mọi hệ thống đều có nền lỗi
   * sẵn có: so tuyệt đối sẽ rollback nhầm ở service vốn đã có 4% lỗi, và bỏ sót
   * ở service vốn chỉ có 0,01%.
   */
  relativeErrorRate: 1.5,
  latencyP99Ms: 1000,
  /**
   * Số lỗi TỐI THIỂU mới coi là vượt ngưỡng. Ở 100 request, độ phân giải của
   * error rate là 1% — một lỗi duy nhất đã vượt ngưỡng 0,05 nếu không có sàn này.
   */
  minErrors: 5,
  /**
   * Số lần đo LIÊN TIẾP vượt ngưỡng mới rollback.
   * Bằng 1 sẽ rollback vì một spike thoáng qua — E6 đo chính điều này.
   */
  maxConsecutiveBreaches: 2,
} as const;

/**
 * Nhịp của reconciler (§7.1). Bốn con số đầu TÁCH RỜI nhau, và đó là điểm sửa
 * quan trọng nhất của v4 ở tầng progressive delivery.
 *
 * v3 để dwell chặn trước `decide()`, nên sau mỗi lần promote không có phép đo nào
 * trong suốt 5 phút. Với maxConsecutiveBreaches = 2, MTTD tối thiểu thành 10 phút,
 * tự phá lập luận "rollback trong một vòng SSE" và làm phép đo E5 vô nghĩa.
 */
export const ROLLOUT_TIMING = {
  /** Vòng quét của reconciler; mỗi session tự quyết theo analysisInterval của nó */
  loopIntervalMs: 5_000,
  /** Nhịp ĐO metrics */
  analysisIntervalSeconds: 30,
  /** Thời gian tối thiểu ở một bậc TRƯỚC KHI promote */
  stepIntervalSeconds: 300,
  /**
   * Cửa sổ truy vấn metric. Validator ép >= 4 x scrapeInterval mà probe() đo được:
   * cửa sổ hẹp hơn scrape interval thì Prometheus chưa đủ điểm dữ liệu và trả về
   * khoảng trống, dễ bị hiểu nhầm thành "không có lỗi".
   */
  metricWindowSeconds: 60,
  /** Quá hạn này thì kết thúc rollout và revert về baseline, không treo vô hạn */
  maxDurationSeconds: 86_400,
  /** Chưa đủ số request này thì HOLD — một lỗi trên 10 request là 10% error rate */
  warmUpRequests: 100,
  /** Rollback FLAG_LEVEL phải PATCH sang Service 2; hết hạn này ⇒ DEPENDENCY_DOWN */
  rollbackRetrySeconds: 120,
  /**
   * [v4.3] Nhịp của lưới gỡ nhãn (§6.6): flag còn `is_tracked` mà không còn
   * rollout nào chạy. Rollout kết thúc đã gọi untrack ngay; lưới này bắt những lần
   * gọi đó hỏng (S2 chết — chính ca kill-switch) và session bị xoá trước khi gỡ.
   * Chậm hơn vòng quét nhiều lần vì mỗi lượt là một lời gọi mạng mỗi flag.
   */
  untrackSweepMs: 30_000,
  /** Số flag tối đa mỗi lượt quét — trần 3 flag/environment nên lượt thường rất nhỏ */
  untrackSweepBatch: 50,
  /**
   * [v4.4] Probe pha 2 (§7.4): session PENDING chờ nhãn `ff` của flag xuất hiện
   * tối đa chừng này kể từ lúc tạo. Quá hạn ⇒ FAILED/EXPIRED kèm lý do "không thấy
   * nhãn" — không thì một app thiếu hook giữ một chỗ trong trần 3 flag và chỗ của
   * target suốt `maxDurationSeconds` (24 giờ) mà người dùng không biết vì sao.
   */
  labelWaitSeconds: 900,
} as const;

/**
 * [v4.4] Tạo rollout ở Service 1 (§8.5). S1 đang giữ request của người dùng nên
 * chờ `track` ngắn hơn executor của S3.
 *
 * `birthLeaseSeconds` — lease khai sinh S1 đặt lúc INSERT: S3 không claim được
 * session trong cửa sổ `track`, nên bù trừ (xoá session khi `track` thất bại) chắc
 * chắn không đụng thứ S3 đã chạm. PHẢI lớn hơn `trackTimeoutMs` cộng biên cho hai
 * round trip database.
 */
export const ROLLOUT_CREATE = {
  trackTimeoutMs: 5_000,
  birthLeaseSeconds: 20,
} as const;

/**
 * Thử lại side effect sang Service 2 (§7.6). Backoff phải nhỏ hơn NHIỀU so với
 * `rollbackRetrySeconds`, không thì "thử lại tới hạn" chỉ còn một hai lần thử.
 */
export const ROLLOUT_RETRY = {
  /** Hạn chờ một lời gọi PATCH sang S2 — S2 giữ row-lock environment, không được để treo */
  executorTimeoutMs: 10_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 15_000,
} as const;

/**
 * Kiểm định hai tỉ lệ của §7.4: một phía, α = 0.05 ⇒ z tới hạn 1.645. Không phải
 * ngưỡng theo session: đây là mức ý nghĩa thống kê của phép kiểm, đổi nó là đổi
 * phương pháp chứ không phải đổi cấu hình.
 */
export const ROLLOUT_ANALYSIS = {
  zCritical: 1.645,
} as const;

/**
 * Số session reconciler xử lý ĐỒNG THỜI trong một vòng quét tính theo pool:
 * mỗi session đang chạy giữ một transaction (một khe) và gia hạn lease trên một
 * khe khác; `/readyz` cần một khe nữa. Không giữ lại phần này thì lần gia hạn
 * chờ khe quá `DB_POOL.acquireTimeoutMs`, ném, fence đóng, và session bị bỏ tới
 * hết lease — đúng lúc nhiều rollout đang sống nhất.
 */
export const ROLLOUT_POOL_HEADROOM = 2;

/** `rollout_events.reason` là VARCHAR(255) (§2.2) — cắt ở tầng ghi, không để 22001 */
export const ROLLOUT_EVENT = {
  reasonMaxLength: 255,
} as const;

/**
 * §6.6 — Trần số flag được gắn nhãn `ff` cùng lúc trong một environment.
 *
 * Đây là trần CỨNG chứ không phải gợi ý: số series histogram tỉ lệ với
 * (1 + T x V). Với T = 3 và V = 2 thì hệ số là 7, cộng thêm chứ không nhân chéo.
 * Gắn nhãn cho MỌI flag như v3 định làm, với 50 flag, hệ số là 101. E14 đo điều này.
 */
export const MAX_TRACKED_FLAGS_PER_ENV = 3;

// ============================================================
// Điều phối worker — cơ chế lease (Design v4 ADR-05)
// ============================================================

/**
 * Lease của RolloutSession — vòng điều khiển chạy mỗi 5 giây nên mất lease phải
 * phát hiện nhanh.
 */
export const ROLLOUT_LEASE = {
  /** Thời gian giữ lease mỗi lần claim */
  durationSeconds: 60,
  /** Chu kỳ gia hạn — phải NHỎ HƠN NHIỀU so với durationSeconds */
  renewIntervalMs: 20_000,
  /**
   * Gia hạn NÉM (database chập chờn) thì thử lại sớm thay vì chờ chu kỳ kế: lease
   * gần như chắc chắn còn (vừa gia hạn ≤ 20 giây trước, sống 60 giây), và bỏ một
   * rollback đang chạy vì một round trip hỏng là cái giá không đáng. Chỉ khi quá
   * `durationSeconds` kể từ lần gia hạn thành công cuối thì mới coi là mất.
   */
  renewErrorRetryMs: 2_000,
} as const;

/**
 * Nguồn metrics (§5.4). `defaultScrapeLagSeconds` là scrape_interval phổ biến
 * của Prometheus; provider đọc con số thật từ `/api/v1/targets` lúc khởi động và
 * làm mới theo `scrapeLagRefreshMs`, vì `settleGate` ở §7.5 chờ đúng bằng nó.
 */
export const METRICS_PROVIDER = {
  defaultScrapeLagSeconds: 15,
  queryTimeoutMs: 5_000,
  scrapeLagRefreshMs: 300_000,
  /**
   * [v4.4] Cửa sổ của `probe()`: series phải TĂNG trong khoảng này, không chỉ tồn
   * tại. Counter trong process giữ series của rollout trước tới khi pod restart;
   * "tồn tại" vì thế không chứng minh nhãn đang được sinh. 5 phút để app dev ít
   * traffic vẫn qua.
   */
  probeWindowSeconds: 300,
  /**
   * Nguồn SaaS (Datadog, New Relic, Dynatrace — Plan #31): agent của nhà cung cấp scrape
   * `/metrics` rồi đẩy lô theo chu kỳ 60 giây mặc định, và API không cho đo chu kỳ đó.
   * Dùng làm độ trễ scrape VÀ scrape interval "assumed" — validator ép cửa sổ ≥ 4 × 60s.
   */
  saasExportIntervalSeconds: 60,
} as const;

/**
 * Status mà một `RolloutSession` còn "sống" — vị từ DUY NHẤT, dùng ở mọi nơi.
 *
 * Đúng tập của truy vấn giành lease (§7.1) và của các partial index trên
 * `rollout_sessions` (§2.2): `idx_one_active_rollout_per_target`, và [v4.4]
 * `idx_one_active_rollout_per_flag`. Ba giá trị, không phải hai, vì mỗi giá trị đã từng là một
 * lỗi thật:
 *
 *   - `PENDING`: bước ramp ĐẦU TIÊN gửi PATCH sang Service 2 lúc session còn
 *     `PENDING` — `start()` áp bậc đầu rồi mới đổi status (§7.7). Thiếu nó thì
 *     rollout không bao giờ bắt đầu được.
 *   - `PAUSED`: v3 để truy vấn claim chỉ lấy `PENDING, IN_PROGRESS`, nên session
 *     `PAUSED` không bao giờ được claim và intent RESUME/ROLLBACK trên nó không
 *     bao giờ chạy (§7.1, bảng vá lỗi). Service 2 kiểm thiếu `PAUSED` là cài lại
 *     đúng lỗi đó ở phía bên kia: rollback một rollout đang tạm dừng bị chặn.
 *
 * Một danh sách, không phải hai: lỗi v3 sinh ra đúng từ hai danh sách trôi khỏi
 * nhau. Các chỗ SQL kia không import được hằng số TypeScript, nên chú thích này là
 * nơi trỏ tới chúng.
 */
/**
 * Trần số rule của MỘT env-config trong một lời `PUT .../rules`.
 *
 * Không có trong thiết kế — là lựa chọn kỹ thuật, và lý do là phép đo: mỗi rule đổi
 * tốn một lượt đi về (~42ms tới Supabase) trong lúc ĐANG GIỮ khoá environment, và khoá
 * đó chặn luôn PATCH ramp của Service 3. Không có trần thì một request mười nghìn
 * rule giữ khoá tới hết ngân sách 20 giây, rồi chết bằng `P2028`. 100 rule là ~4 giây
 * trong ca xấu nhất — dư cho mọi cấu hình thật, còn xa ngân sách.
 */
export const MAX_RULES_PER_ENV_CONFIG = 100;

export const ACTIVE_ROLLOUT_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "PAUSED",
] as const;

/**
 * Lease của ProvisioningJob — KHÁC ROLLOUT_LEASE, và khác có chủ đích (§2.2).
 *
 * Một bước provisioning gọi API cloud có thể mất vài phút (tạo cluster, chờ
 * load balancer cấp IP). Dùng chung 60 giây thì worker vẫn đang sống sẽ bị coi
 * là chết giữa chừng, và một worker thứ hai nhảy vào tạo tài nguyên trùng — đúng
 * kịch bản tốn tiền thật mà ADR-02 sinh ra để chặn. Gia hạn cùng nhịp `touch()`
 * của pg-boss.
 */
export const JOB_LEASE = {
  durationSeconds: 300,
  renewIntervalMs: 30_000,
  /** Gia hạn ném (DB chập chờn) ⇒ thử lại sớm; chỉ quá `durationSeconds` mới là mất lease */
  renewErrorRetryMs: 5_000,
} as const;

/**
 * [v4.11] Nhịp của hàng đợi job (Plan #28, ADR-02). Polling 5 giây: provisioning dài hàng
 * chục phút nên vài giây trễ lúc nhận việc không đáng một kết nối LISTEN. Đối soát 5 phút
 * một lần — nó chữa lệch sau khi tiến trình chết, không phải đường chính.
 */
export const JOB_QUEUE = {
  pollingIntervalSeconds: 5,
  reconcileCron: "*/5 * * * *",
  /** Mỗi giờ: mốc cảnh báo nhỏ nhất của TTL là 1 giờ (§4.4 lớp 3) */
  projectTtlCron: "0 * * * *",
  /** Mỗi 10 phút (§2.2 quy trình ghi sổ) */
  orphanScanCron: "*/10 * * * *",
  /** Mỗi 6 giờ (§8.6 nhánh A) */
  driftScanCron: "0 */6 * * *",
} as const;

/**
 * [v4.11] Webhook CI/CD (§8.3, Plan #36). Thân của UDP chỉ vài trăm byte; trần 1 MiB chặn một CI
 * bị chiếm làm đầy bộ nhớ bằng thân khổng lồ trước khi chữ ký được kiểm.
 */
export const CICD_WEBHOOK = {
  bodyLimitBytes: 1_048_576,
} as const;

/**
 * [v4.11] Theo dõi một lần deploy trên hàng đợi `udp-deploy` (Plan #36 QĐ-5). Hạn thật là
 * `progressDeadlineSeconds` của CHÍNH workload (Kubernetes điền 600 khi vắng); trần một lượt nằm
 * dưới `expireInSeconds` của hàng đợi, để pg-boss không coi một lượt còn sống là đã chết.
 */
export const DEPLOY_WATCH = {
  pollMs: 10_000,
  defaultProgressDeadlineSeconds: 600,
  maxWatchSeconds: 1_800,
  /** Số lần deploy theo dõi song song mỗi tiến trình — mỗi lần giữ một lượt tới 30 phút */
  concurrency: 4,
  /** START chưa kết luận trẻ hơn mốc này có thể đang giữa commit và `send` — chưa phải lệch */
  resendAfterMs: 60_000,
} as const;

/**
 * [v4.10] Vòng thử lại khi `lookup()` trả `indeterminate` (§4.2, điểm crash K2b).
 *
 * Tagging API của cloud là nhất quán cuối: một tag vừa gắn có thể chưa thấy trong vài
 * giây. Runner đọc "chưa thấy" thành "không có" sẽ `create()` lần hai và tạo trùng —
 * đúng chế độ hỏng mà K3 sinh ra để chặn. Nên `indeterminate` là một lỗi TẠM, và runner
 * chờ rồi tra lại thay vì quyết định.
 *
 * Vì sao có một BẤT BIẾN buộc tổng backoff không vượt nửa lease, và vì sao nó được kiểm
 * bằng test chứ không chỉ ghi ở đây: vòng chờ này nằm TRONG một lượt job đang giữ lease.
 * Nếu tổng thời gian chờ vượt `JOB_LEASE.durationSeconds` thì worker thứ hai nhận job và
 * hai worker cùng `lookup`/`create` — tức chính bản sửa này tạo ra điểm crash K9. Nửa
 * lease là mức để một lần gia hạn trượt cũng chưa vỡ.
 *
 * Hết lượt thì job sang `FAILED` và hàng GIỮ `CREATING`: đó là trạng thái mà K2/K3 đã xử
 * lý được khi resume. Đặt `ORPHAN_SUSPECTED` là biến một blip mạng thành hỏng vĩnh viễn,
 * vì trạng thái đó không có cạnh ra (§4.5).
 */
export const LOOKUP_INDETERMINATE = {
  maxAttempts: 5,
  /** Backoff tuyến tính: lần thử thứ n chờ n × giá trị này */
  backoffStepMs: 2_000,
} as const;

/**
 * Hàng `CREATING` quá mốc này phải NHÌN THẤY ĐƯỢC ở `GET /admin/orphan-resources`.
 *
 * Nó KHÔNG đổi `status`: đổi trạng thái chỉ được xảy ra khi `lookup()` ra mismatch, đúng
 * ngữ nghĩa §4.5. Một hàng treo im lặng là tài nguyên có thể đang tính tiền mà không ai
 * biết; một hàng bị đổi trạng thái sai là một hàng không còn resume được.
 */
export const STALE_CREATING_MINUTES = 15;

// ============================================================
// Change feed — ba tầng có tự kiểm (Design v4 ADR-05)
// ============================================================

/**
 * Pool kết nối database — luật chung cho cả ba service (áp ở `createPgAdapter`).
 *
 * `acquireTimeoutMs`: chờ một khe trong pool tối đa bao lâu trước khi trả 503.
 * Bằng `maxWait` mà `writeWithOutbox` và đường đọc snapshot cũ đã dùng, để không
 * có hai con số cho cùng một câu hỏi "quá tải là bao lâu". Trần số khe là biến
 * môi trường (`DATABASE_POOL_MAX`) vì nó phụ thuộc gói database; còn đây là
 * ngưỡng nghiệp vụ, không đổi theo nơi triển khai.
 */
export const DB_POOL = {
  acquireTimeoutMs: 5_000,
} as const;

export const CHANGE_FEED = {
  /** Chu kỳ poll config_version (tầng 1) */
  pollIntervalMs: 500,
  /** Jitter ngẫu nhiên để các replica không đồng pha */
  pollJitterMs: 200,
  /**
   * Định kỳ tính lại sha256 của snapshot và so với Environment.configHash.
   * configVersion là SỐ ĐẾM nên nó không phải checksum: replica áp delta sai nội
   * dung nhưng đúng số vẫn lọt nếu chỉ so version (I15a).
   */
  hashVerifyIntervalMs: 60_000,
  /** Số lần fallback liên tiếp trước khi ngắt mạch tầng 2 */
  circuitBreakerThreshold: 3,
  /** Thời gian tắt tầng 2 sau khi ngắt mạch */
  circuitBreakerCooldownMs: 5 * 60_000,
  /**
   * Giữ ConfigChangeLog bao lâu. PHẢI bằng số ngày viết cứng trong hàm
   * `udp_prune_config_change_log` — `design-lint/tests/retention.test.ts` chốt trôi.
   */
  retentionDays: 7,
  /**
   * Dọn `ConfigChangeLog` (§2.2) qua hàm `udp_prune_config_change_log` — S2 không
   * có DELETE trên bảng. Mỗi lượt xoá theo lô để không giữ khoá lâu, và có trần số
   * lô để một lượt không chạy vô hạn khi tồn đọng lớn.
   */
  prune: { intervalMs: 60 * 60_000, batchSize: 1_000, maxBatchesPerRun: 50 },
  /**
   * [v4.9] Ngân sách byte của MỘT lô delta ở tầng 2 (tổng `payload` các dòng đọc
   * sau con trỏ). Vượt ⇒ rơi về snapshot với lý do `too-large`, không đếm vào
   * breaker. Bằng 2 × `SEGMENT.maxProjectBytes`: một lần sửa segment ở trần luôn
   * đi bằng delta (text jsonb dài hơn canonical khoảng 1 B mỗi phần tử), còn lô
   * lớn hơn thế thì snapshot (≤ 4 MiB segment + flag) rẻ hơn.
   */
  maxDeltaBytes: 8 * 1024 * 1024,
} as const;

/**
 * Kênh LISTEN dùng chung (`createListenAccelerator` của `@udp/db`) — tầng 3 của
 * Service 2 và `rollout_intent` của Service 3 [v4.3]. Mọi con số dưới đây là HẠN
 * GIỜ, vì đã đo: một kết nối chết im (TCP còn sống, không byte nào về) làm
 * `SELECT 1` treo vô hạn và `end()` treo — không có hạn thì kênh điếc mãi mà vẫn
 * trông khoẻ, và tắt máy mất trọn 10 giây rồi thoát cưỡng bức.
 */
export const LISTEN_TIMING = {
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 30_000,
  healthCheckMs: 60_000,
  healthCheckTimeoutMs: 5_000,
  identityTimeoutMs: 5_000,
  stopTimeoutMs: 1_000,
} as const;

// ============================================================
// Xác thực (Design v4 §10.4)
// ============================================================

export const AUTH = {
  /**
   * bcrypt cắt âm thầm mọi thứ sau byte thứ 72. Không chặn ở tầng validate thì
   * hai mật khẩu khác nhau ở ký tự thứ 80 sẽ đăng nhập được cho nhau.
   */
  passwordMinLength: 8,
  passwordMaxLength: 72,
  /** Số byte ngẫu nhiên của CSRF token */
  /**
   * KHÔNG dùng nữa. Token CSRF không còn là chuỗi ngẫu nhiên mà là HMAC của
   * `family_id` (§1.2) — độ dài do SHA-256 quyết định, không phải hằng số này.
   * Giữ lại để lần sau không ai thêm lại một token ngẫu nhiên trần.
   */
  csrfTokenBytes: 32,
} as const;

/**
 * Tên cookie. Tập trung ở đây vì cả backend lẫn Portal đều tham chiếu tới —
 * đổi tên ở một chỗ là đủ.
 */
export const COOKIE_NAMES = {
  accessToken: "udp_access",
  refreshToken: "udp_refresh",
  /** Cố ý KHÔNG httpOnly để Portal đọc được và gắn vào header */
  csrfToken: "udp_csrf",
} as const;

export const CSRF_HEADER = "X-CSRF-Token";

/**
 * Header mang bí mật dùng chung của lời gọi `/internal/*` (§9 "mTLS hoặc shared
 * secret"). Một tên cho bên nhận (S2) và mọi bên gọi (S1, S3) — gõ lệch một bên
 * là 401 im lặng.
 */
export const INTERNAL_SECRET_HEADER = "X-Internal-Secret";

/**
 * [v4.5] Ngữ cảnh người dùng mà Service 1 chuyển tiếp cho lời gọi `/internal/*`
 * ghi cấu hình: ai (id user đã xác thực ở S1) và từ đâu (IP, UA của CHÍNH người
 * dùng, không phải của S1). Service 2 ghi chúng vào `audit_logs` trong transaction
 * của nó. Chỉ tin sau khi lời gọi đã qua bí mật nội bộ — bên giữ bí mật giả được
 * cả ba (§12).
 */
export const ACTOR_HEADER = "X-Udp-Actor-Id";
export const CLIENT_IP_HEADER = "X-Udp-Client-Ip";
export const CLIENT_UA_HEADER = "X-Udp-User-Agent";

/**
 * [v4.5] Hạn chờ lời gọi GHI cấu hình từ S1 sang S2: PHẢI dài hơn ngân sách
 * transaction của `writeWithOutbox` (20 s + 5 s chờ khe) — ngắn hơn thì S1 trả
 * 503 trong khi S2 vẫn commit, và người dùng thử lại gặp DUPLICATE.
 */
export const INTERNAL_CALL = {
  configWriteTimeoutMs: 30_000,
  /**
   * [v4.6] Lời gọi CHỈ ĐỌC (Flag Evaluation Tester): không có transaction nào để
   * chờ commit, nên hạn chờ ngắn — người dùng đang đứng trước Portal.
   */
  readTimeoutMs: 10_000,
} as const;

/**
 * Khoảng của kiểu INTEGER (int4) trong PostgreSQL.
 *
 * Mọi con số đi từ dây xuống một cột int4 — `config_version`, `RolloutSession.version`,
 * `priority` — phải bị chặn ở ranh giới HTTP: lọt xuống Postgres thì nó ném `22003`
 * và thành 500 thay vì 400. Một chỗ khai cho mọi nơi kiểm [v4.5: dời từ Service 2
 * khi schema rule thành hợp đồng dùng chung].
 */
export const INT4_MIN = -2_147_483_648;
export const INT4_MAX = 2_147_483_647;

/** Giới hạn tần suất cho endpoint nhạy cảm — chống dò mật khẩu */
export const RATE_LIMIT = {
  auth: { windowMs: 15 * 60_000, max: 20 },
  general: { windowMs: 60_000, max: 300 },
  /**
   * Giới hạn cho SDK (§2.2, bảng "Khác biệt giữa hai loại key").
   *
   * Hai hằng số này là hạn mức của HAI LOẠI KHOÁ trên HAI BỀ MẶT khác nhau —
   * KHÔNG phải hai tầng chồng lên cùng một endpoint. Bản trước mô tả chúng như
   * hai trục chồng nhau, và cách đọc đó dẫn thẳng tới việc nối cả hai limiter
   * lên `/sdk/config`, nơi trục thứ hai vừa sai chỗ vừa không bao giờ chạm tới.
   *
   *   - `perKey` — **SERVER key**, trên `GET /sdk/config`. Việc MỞ `GET /sdk/stream`
   *     có limiter riêng (`streamOpensPerKey` bên dưới) — chung bucket thì một lần
   *     restart replica là bão 429.
   *     100/phút là dư xa cho một backend: SDK giữ cache in-process và chỉ tải
   *     lại khi version đổi, còn bản thân phép đánh giá chạy tại chỗ nên không
   *     sinh request nào. Đếm theo KHOÁ chứ không theo IP vì SDK chạy sau NAT
   *     hoặc trong cluster — trục IP ở đây gom cả một cụm vào một bucket.
   *
   *   - `perKeyIp` — **CLIENT key**, trên OFREP và `/sdk/stream?mode=notify`.
   *     Cao hơn hẳn vì mỗi người dùng cuối là một request: một khoá CLIENT phục
   *     vụ cả một website. Trục IP ở đây là BẮT BUỘC, không phải bổ sung — khoá
   *     CLIENT nằm trong trình duyệt nên ai cũng đọc được, và không có trục IP
   *     thì một người lấy được khoá sẽ khoá cả tổ chức bằng đúng một máy.
   */
  sdk: {
    perKey: { windowMs: 60_000, max: 100 },
    perKeyIp: { windowMs: 60_000, max: 600 },
    /** CLIENT key: số kết nối SSE `mode=notify` đồng thời tối đa cho mỗi IP (§2.2) */
    maxStreamsPerIp: 5,
    /**
     * SERVER key: số lần MỞ `GET /sdk/stream` mỗi phút mỗi khoá — limiter RIÊNG,
     * không chung bucket với `perKey` của `/sdk/config`.
     *
     * Chung bucket thì một lần replica restart là bão 429: N tiến trình dùng chung
     * khoá nối lại cùng lúc, phần vượt 100 bị chặn, SDK rơi về polling `/sdk/config`
     * trên CHÍNH bucket đó và cũng bị chặn — cấu hình đứng im nhiều phút, kill-switch
     * không tới. 1 000/phút đủ cho E9 (1 000 SDK) nối lại trong một phút.
     */
    streamOpensPerKey: { windowMs: 60_000, max: 1000 },
    /**
     * SERVER key: số stream mở đồng thời tối đa của một khoá trên MỖI replica. Chặn
     * một khoá bị lộ giữ vô hạn kết nối; vượt ⇒ 429 kèm `Retry-After`, SDK rơi về
     * polling (§6.3). Đếm theo replica, nên trần thực tế nhân theo số replica (§16).
     */
    maxStreamsPerKey: 1000,
    /**
     * [v4.6] OFREP: trần theo IP ĐỨNG TRƯỚC trần (khoá, IP) và trước bước tra khoá.
     * Trục (khoá, IP) băm nguyên header `Authorization`, nên mỗi token rác là một
     * bucket mới — mà vẫn tốn một lần tra database. Trục IP chặn đúng ca đó:
     * 1 200/phút gấp đôi trần của một khoá hợp lệ, đủ cho một NAT văn phòng.
     */
    ofrepPerIp: { windowMs: 60_000, max: 1200 },
    /**
     * [v4.9] SERVER key: số lần `POST /sdk/stats` mỗi phút mỗi khoá — bucket RIÊNG,
     * không chung `perKey` của `/sdk/config`. Mỗi tiến trình báo một lần mỗi 60 s,
     * nên 1 000/phút là 1 000 tiến trình dùng chung một khoá.
     */
    statsPerKey: { windowMs: 60_000, max: 1_000 },
  },
} as const;

/**
 * [v4.6] OFREP — đánh giá từ xa cho CLIENT key (§6.2, ADR-03). Endpoint công
 * khai (khoá CLIENT nằm trong trình duyệt), nên mọi trần là trần của CPU/bộ nhớ
 * mà một người lạ tiêu được.
 */
export const OFREP = {
  /** Parser RIÊNG của `/ofrep`, mount trước parser 1 MB toàn cục */
  bodyLimit: "16kb",
  /** Số thuộc tính cấp một của context */
  maxContextKeys: 50,
  /** Độ dài tối đa của một giá trị chuỗi trong context */
  maxContextString: 1024,
  /**
   * Kết quả bulk đã đánh giá, theo (env, configVersion, ngữ nghĩa evaluator, hash
   * context), mỗi replica. Có trần: khoá do người lạ quyết định, không trần là
   * rò bộ nhớ theo số context khác nhau họ gửi.
   */
  resultCacheEntries: 10_000,
  /**
   * Trần BYTE của cùng cache đó — số mục thôi không đủ: một mục là kết quả của
   * MỌI flag trong project, và project không có trần số flag (QA code Plan #20:
   * 10 000 mục × 200 flag ≈ 250 MB).
   */
  resultCacheBytes: 32 * 1024 * 1024,
  /** Preflight CORS được trình duyệt nhớ bao lâu */
  corsMaxAgeSeconds: 600,
} as const;

// ============================================================
// SSE (Design v4 §6.3)
// ============================================================

export const SSE = {
  /** Nhịp tim chống proxy đóng kết nối idle (nginx/ALB thường 60s) */
  heartbeatMs: 20_000,
  /** Số lần SSE thất bại liên tiếp trước khi SDK chuyển sang polling */
  fallbackAfterFailures: 3,
  /** Chu kỳ polling khi SSE không khả dụng */
  pollingFallbackMs: 30_000,
  /**
   * Chu kỳ kiểm khoá của các stream ĐANG MỞ (§12 T7).
   *
   * Guard kiểm khoá ở mỗi request, nhưng một stream là một request sống hàng giờ.
   * Mỗi lần đẩy thay đổi đã lọc khoá trước (không dữ liệu mới nào tới khoá đã thu
   * hồi); chu kỳ này đóng nốt stream đang RỖI. Tách khỏi nhịp tim vì 20 giây là quá
   * dài cho một hành động an ninh — mỗi vòng chỉ MỘT truy vấn cho mọi stream.
   */
  revocationCheckMs: 5_000,
  /**
   * Khoảng của trường `retry:` gửi ở đầu stream và trước khi đóng stream lúc tắt
   * máy — chọn NGẪU NHIÊN trong khoảng này, để N tiến trình mất kết nối cùng lúc
   * không nối lại cùng một mili-giây.
   */
  retryMs: { min: 1_000, max: 10_000 },
  /**
   * Backlog tối đa của MỘT stream, đo bằng `res.writableLength` (đã đo: phản ánh
   * đúng phần đệm phía ứng dụng; `write() === false` thì KHÔNG phải tín hiệu client
   * chậm). Vượt ⇒ huỷ stream; client nối lại bằng `Last-Event-ID` và nhận snapshot
   * mới — snapshot là bản thay thế, giữ bản cũ đang kẹt không để làm gì.
   */
  maxBacklogBytesPerStream: 1024 * 1024,
  /** Tổng backlog của mọi stream trong một tiến trình — trần bộ nhớ thật */
  maxBacklogBytesTotal: 64 * 1024 * 1024,
  /**
   * Lúc tắt máy: sau `retry:` và `end()`, stream nào client chưa đọc hết thì bị
   * huỷ sau chừng này — `end()` không bao giờ xong với client không đọc, và
   * `server.close()` chờ theo tới lúc thoát cưỡng bức.
   */
  closeGraceMs: 1_000,
} as const;

/**
 * [v4.7] `@udp/openfeature-provider` (§6.8) — giá trị mặc định của provider chạy
 * trong ỨNG DỤNG CỦA KHÁCH. Chu kỳ polling và ngưỡng rơi về polling dùng chung
 * `SSE` ở trên; đây là phần riêng của provider.
 */
export const PROVIDER = {
  /**
   * `initialize()` chờ snapshot đầu tới chừng này rồi NÉM (SDK phát ERROR, app vẫn
   * chạy với default) — provider vẫn thử nền và phát READY khi có. Thiết kế cũ
   * ghi "N lần thử" mà không cho N; một hạn thời gian mới đo được.
   */
  initTimeoutMs: 10_000,
  /** Không xác nhận được cấu hình còn tươi quá chừng này ⇒ STALE (fail-static) */
  staleAfterSeconds: 300,
  /**
   * Stream rỗi quá `heartbeatMs × hệ số` (không một byte nào, kể cả nhịp tim) ⇒
   * coi là hỏng: kết nối nửa mở (mạng bị chặn giữa đường) không bao giờ tự báo lỗi.
   */
  heartbeatTimeoutFactor: 2.5,
  /** Backoff nối lại stream: bắt đầu từ đây, nhân đôi, trần là chu kỳ polling */
  reconnectBackoffMinMs: 1_000,
  /**
   * Hạn của MỘT lần `GET /sdk/config` (bootstrap, poll, thử lại khi 401) — nhỏ hơn
   * `initTimeoutMs`: server nhận kết nối rồi im (event loop bị chặn, proxy nuốt byte)
   * không được treo cả vòng đồng bộ tới `headersTimeout` 300 giây của undici, và
   * bootstrap treo phải kịp nhường cho stream không con trỏ trước khi init hết hạn.
   */
  configRequestTimeoutMs: 5_000,
  /**
   * Trần độ dài MỘT dòng SSE (ký tự). Snapshot là một dòng `data:`; không trần thì
   * một stream hỏng không bao giờ xuống dòng giữ bộ nhớ của ứng dụng khách vô hạn.
   */
  maxSseLineChars: 64 * 1024 * 1024,
} as const;

// ============================================================
// SDK key (Design v4 §2.2)
// ============================================================

export const SDK_KEY = {
  serverPrefix: "udp_sk_",
  clientPrefix: "udp_ck_",
  /** Số byte ngẫu nhiên của key */
  randomBytes: 32,
  /**
   * Số ký tự CUỐI lưu lại để hiển thị trong UI.
   *
   * Đuôi chứ không phải đầu: khoá có dạng `udp_sk_{env}_{random}`, nên tám ký
   * tự đầu là `udp_sk_l` cho MỌI khoá server ở live — lưu chúng không phân
   * biệt được khoá nào với khoá nào, tức là hỏng đúng mục đích của cột.
   */
  displaySuffixLength: 6,
  /** Throttle cập nhật last_used_at để không ghi DB mỗi request */
  lastUsedThrottleMs: 60_000,
  /**
   * [v4.9] Trần số khoá mà một tiến trình nhớ "vừa chạm" để throttle
   * `last_used_at`. Map này đứng trước điều kiện `WHERE` của câu UPDATE (thứ
   * throttle đúng cả giữa các replica); nó chỉ chặn N request đồng thời của CÙNG
   * một khoá cùng bắn trước khi hàng đầu commit, nên đầy thì dọn được, không cần
   * chính xác.
   */
  lastUsedTrackedKeys: 10_000,
  /**
   * [v4.9] Phần tên env trong token (`udp_sk_{envSlug}_…`) cắt ở chừng này ký tự:
   * đủ cho `production` và các tên có hậu tố. Token không bao giờ được parse, nên
   * đây chỉ là nhãn cho người đọc.
   */
  envSlugMaxLength: 20,
  /**
   * [v4.9] Trần khoá CHƯA thu hồi mỗi environment (422 `QUOTA_EXCEEDED`): một
   * OWNER bấm lặp không tạo khoá vô hạn. Muốn nới thì chỉ đổi số này.
   */
  maxActivePerEnvironment: 20,
  /**
   * [v4.9] Nhãn người dùng đặt cho khoá — ĐÚNG bề rộng cột `sdk_keys.label`
   * (`VarChar(100)`, §2.2). Cắt ở zod của CẢ HAI biên chứ không để Postgres ném
   * `22001`: lỗi đó nổ giữa transaction tạo khoá, sau khi đã khoá environment và
   * đã đếm quota — tức trả 500 cho một thứ lẽ ra là 400 ở ngoài cùng.
   */
  labelMaxLength: 100,
  /** [v4.9] Danh sách khoá chỉ trả chừng này khoá đã thu hồi mới nhất */
  revokedListLimit: 50,
  /**
   * [v4.9] Transaction tạo khoá ở S2 (khoá env, tra hash, đếm quota, INSERT, audit)
   * — ghi tường minh thay vì dựa vào mặc định của Prisma, để hạn chờ khe khớp
   * `DB_POOL.acquireTimeoutMs` và S1 biết khi nào thử lại.
   */
  createTransaction: { maxWait: 5_000, timeout: 10_000 },
} as const;

// ============================================================
// Telemetry đánh giá flag (Design v4 §2.2 FlagEvaluationStat, §6.7, §6.8)
// ============================================================

/**
 * [v4.9] Số đếm lượt đánh giá: provider gom rồi báo `POST /sdk/stats`, Service 2
 * gộp trong bộ nhớ rồi UPSERT theo lô, rollup hàng giờ cũ thành hàng ngày.
 */
export const SDK_STATS = {
  /** Phía provider (chạy trong ứng dụng của khách) */
  report: {
    intervalMs: 60_000,
    /** ±10% để N tiến trình khởi động cùng lúc không báo cùng một giây */
    jitterRatio: 0.1,
    requestTimeoutMs: 5_000,
    /** `onClose()` gửi nốt báo cáo cuối trong hạn này, không ném */
    shutdownFlushTimeoutMs: 2_000,
    maxEntriesPerReport: 2_000,
    maxCountPerEntry: 1_000_000_000,
    /** Trần số cặp (flag, variant) đang giữ trong tiến trình khách */
    maxPendingEntries: 10_000,
    /**
     * Parser riêng của `/sdk/stats`: 2 000 × (255 + 100 × 6 + 50) — mọi báo cáo
     * hợp lệ ở trần, kể cả khi mọi ký tự bị escape `\uXXXX`, đều lọt.
     */
    maxBodyBytes: 2 * 1024 * 1024,
    /** `sdk.name`/`sdk.version` chỉ để ghi log — có trần để không phình log */
    sdkLabelMaxLength: 100,
  },
  /** Phía Service 2 */
  ingest: {
    /** Mặc định của `SDK_STATS_FLUSH_INTERVAL_MS` */
    flushIntervalMs: 15_000,
    /**
     * Sàn của `SDK_STATS_FLUSH_INTERVAL_MS`: đủ nhỏ cho test tích hợp chờ flush,
     * đủ lớn để một cấu hình gõ nhầm không biến flusher thành vòng lặp bận.
     */
    minFlushIntervalMs: 250,
    flushBatchRows: 1_000,
    shutdownFlushTimeoutMs: 5_000,
    /**
     * [v4.9] Lúc tắt, chờ cổng HTTP đóng nhiều nhất chừng này rồi flush lần đầu.
     * Stream SSE và kết nối keep-alive có thể giữ `server.close()` lâu hơn cả hạn
     * flush, nên không được chờ nó vô điều kiện; ngược lại, chờ một chút thì lần
     * flush đầu đã gom được cả những báo cáo tới sau tín hiệu dừng.
     */
    shutdownHttpWaitMs: 3_000,
    maxPendingEntries: 50_000,
    maxPendingEntriesPerEnvironment: 10_000,
  },
  retention: {
    /**
     * Hàng giờ cũ hơn chừng này ngày UTC được gộp thành hàng ngày. 92 = `maxDays`
     * + 2: cửa sổ 90 ngày theo tz dương tới +14 h bắt đầu sớm hơn mốc 90 ngày UTC
     * tới 14 giờ — giữ đúng 90 thì phần đầu cửa sổ đã bị gộp và đếm thiếu.
     */
    hourlyDays: 92,
    rollupIntervalMs: 6 * 3_600_000,
    /** Mỗi bước gộp MỘT ngày; một lượt tối đa chừng này bước */
    rollupMaxDaysPerRun: 7,
  },
  query: {
    maxDays: 90,
    defaultDays: 7,
    /** `granularity=hour` chỉ khi cửa sổ ≤ chừng này ngày */
    maxHourlyDays: 7,
    /** Độ dài sparkline `daily14` của danh sách flag */
    sparklineDays: 14,
    /**
     * [v4.9] Trần số flag của MỘT lời gọi `GET /internal/flag-stats/summary`:
     * bằng trần `limit` của danh sách flag ở Service 1, vì đúng một trang danh
     * sách sinh ra đúng một lời gọi này (V19).
     */
    summaryMaxFlags: 100,
    /** Tên IANA dài nhất chừng 30 ký tự; trần này chặn chuỗi rác trước khi tra tập */
    tzMaxLength: 64,
    staleList: { defaultLimit: 50, maxLimit: 100 },
  },
} as const;

// ============================================================
// Quota tài nguyên mặc định (Design v4 §4.4)
// ============================================================

/**
 * Trần tài nguyên áp cho project mới. Cưỡng chế ở MỌI lời gọi adapter.
 * Trong mô hình BYOC, bug về vòng lặp provisioning tiêu tiền thật của
 * developer — nên đây là giá trị an toàn, người dùng phải chủ động nâng.
 */
export const DEFAULT_RESOURCE_QUOTA = {
  maxNodes: 3,
  maxNodeSize: "medium",
  maxDatabases: 2,
  maxStorageGb: 50,
  /**
   * [v4 §4.1] Load balancer là nguồn chi phí ẩn lớn thứ hai sau NAT gateway, và
   * nguy hiểm hơn vì nó sinh ra NGOÀI tầm adapter: mỗi Service kiểu LoadBalancer
   * do domain adapter hoặc do chính app của khách tạo đều đẻ một ELB. Trần này
   * được cưỡng chế bằng admission webhook trong cluster, không chỉ ở tầng API.
   */
  maxLoadBalancers: 3,
} as const;

/**
 * TTL mặc định cho project ở môi trường lab (giờ). null = không hết hạn.
 *
 * CHUA CO NGUOI DUNG, va do la co y. `POST /projects` khong dat `expires_at`
 * vi chua co job nao hanh dong theo han do: `project-ttl.job` cua §3.1 doi ha
 * tang pg-boss, ma pg-boss lai doi Cloud Adapter moi co viec that de lam. Dat
 * mot han ma khong ai canh bao hay don theo la tao ao giac — nguoi dung thay
 * project "het han sau 6 gio" roi khong co gi xay ra ca.
 *
 * Nguoi dung dau tien se la `project-ttl.job`. Giu hang so o day chu khong xoa
 * vi §4.4 da chot gia tri nay; xoa di roi them lai la mat mot quyet dinh thiet
 * ke da co.
 */
export const DEFAULT_PROJECT_TTL_HOURS = 6;

// ============================================================
// Redaction — danh sách khóa bị che trước khi ghi log/audit
// (Design v4 §2.2, §12)
// ============================================================

export const REDACTED_KEY_PATTERNS = [
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /apikey/i,
  /api_key/i,
  /private_?key/i,
  /serviceaccountjson/i,
  /accesskey/i,
  /clientsecret/i,
  /** Header xác thực và cookie phiên — lọt vào AuditLog qua payload request */
  /authorization/i,
  /cookie/i,
  /**
   * Mọi trường có tên KẾT THÚC bằng "key": sshKey, dekKey, webhookKey,
   * kubeconfigKey, privateKey. Cố tình rộng — với một biện pháp bảo mật thì
   * chặn-mặc-định là hướng đúng: bỏ sót một khoá là rò rỉ, che nhầm một nhãn
   * chỉ là hiển thị xấu. Những cái che nhầm được liệt kê ở REDACT_ALLOWLIST
   * ngay dưới, nơi mỗi ngoại lệ phải được viết ra và đọc lại.
   */
  /.+key$/i,
  /** Mọi thứ bắt đầu bằng "encrypted" là ciphertext: encryptedPayload, encryptedDek */
  /^encrypted/i,
  /**
   * [v4.5] `bucketSalt` của rule: không phải credential, nhưng biết nó là tính
   * trước được người dùng nào rơi vào nhóm nào. Các view đã bỏ nó; đây là lớp
   * phòng thủ thứ hai cho `before`/`after` của audit và `current` của 409.
   */
  /salt/i,
] as const;

/**
 * Khoá KHÔNG BAO GIỜ được che, dù khớp pattern ở trên.
 *
 * Đây là những cái tên kết thúc bằng "key" nhưng mang định danh để HIỂN THỊ và
 * TRUY VẾT chứ không mang bí mật. Che chúng đi không làm hệ thống an toàn hơn,
 * mà làm mất đúng thứ cần để đọc log: `idempotencyKey` là chìa khoá lần ra job
 * trùng của ADR-02, `targetingKey` là thuộc tính hash mặc định của OpenFeature,
 * `variantKey`/`flagKey` là nhãn của mọi thống kê đánh giá flag.
 *
 * Danh sách này là ngoại lệ có kiểm soát, nên nó phải NGẮN và mỗi mục phải giải
 * thích được. Thêm một dòng ở đây là một quyết định bảo mật, không phải dọn dẹp.
 */
export const REDACT_ALLOWLIST = [
  // `key` tran KHONG can o day: /.+key$/i doi it nhat mot ky tu dung truoc, nen
  // no von khong khop. Mot dong allowlist khong mien tru gi la dong gay hieu nham.
  /^idempotency_?key$/i,
  /^variant_?key$/i,
  /^flag_?key$/i,
  /^targeting_?key$/i,
  /^bucket_?key$/i,
  /^stickiness_?key$/i,
] as const;

export const REDACTED_PLACEHOLDER = "[REDACTED]";
