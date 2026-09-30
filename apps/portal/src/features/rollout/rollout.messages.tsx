import type {
  CanaryInvalidCode,
  ControlModeWire,
  ServiceLevelIssue,
  ServiceStrategy,
} from "@udp/shared-types/rollout";
import type {
  RolloutEventWire,
  RolloutIntentActionWire,
  RolloutStatusWire,
  RolloutSummaryWire,
} from "@udp/shared-types/wire";
import type { ReactNode } from "react";
import { count, defineMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";

/**
 * Chữ của phân hệ Rollout: danh sách, hai hộp tạo (theo flag, theo phiên bản), trang chi tiết, nhãn trạng thái
 * dùng chung (`RolloutStatusLabel`) và câu báo của `useRolloutWatcher`.
 */
const vi = {
  status: {
    PENDING: "Đang chờ",
    IN_PROGRESS: "Đang chạy",
    PAUSED: "Tạm dừng",
    DONE: "Hoàn tất",
    FAILED: "Đã rollback",
  } satisfies Record<RolloutStatusWire, string>,
  watcher: {
    finished: (name: string) => `Rollout ${name} đã kết thúc.`,
    view: "Xem kết quả",
  },
  list: {
    title: "Rollout",
    create: "Tạo rollout",
    lead: (env: string) =>
      `Tăng dần một variant, tự lùi lại khi số đo vượt ngưỡng. Đang xem ${env}.`,
    empty: (env: string) => `Chưa có rollout nào ở ${env}`,
    /** [Plan #58 UX-17] Trạng thái trống: vì sao trống, cần gì trước, một nút */
    emptyWhy:
      "Phát hành dần đưa một variant của flag, hay một phiên bản mới của service, tới người dùng từng phần trăm; số đo xấu thì tự lùi lại.",
    emptyNeed:
      "Cần có trước: một flag đang dùng với rule chia tỉ lệ (hoặc một workload đã deploy), và workload đó xuất metric HTTP.",
    emptyRole: (role: string) => `Vai ${role} trở lên mới tạo được rollout.`,
    createFirst: "Tạo rollout đầu tiên",
    label: "Danh sách rollout",
    strategy: {
      CANARY: "Canary",
      ATTRIBUTE_SPLIT: "Chia theo thuộc tính",
      BLUE_GREEN: "Blue-Green",
    } satisfies Record<RolloutSummaryWire["strategy"], string>,
    scope: {
      FLAG_LEVEL: "theo flag",
      SERVICE_LEVEL: "theo phiên bản",
    } satisfies Record<RolloutSummaryWire["scope"], string>,
  },
  /** Phần chung của hai hộp tạo rollout */
  form: {
    title: (env: string) => `Tạo rollout ở ${env}`,
    cancel: "Huỷ",
    creating: "Đang tạo…",
    create: "Tạo rollout",
    scope: "Phạm vi",
    scopeOption: {
      FLAG_LEVEL: "Theo flag",
      SERVICE_LEVEL: "Theo phiên bản",
    } satisfies Record<RolloutSummaryWire["scope"], string>,
    strategy: "Chiến lược",
    workload: "Workload (tên service trong cluster)",
    workloadPlaceholder: "checkout-api…",
    /** [Plan #58 UX-29] Workload lấy từ lịch sử deploy của environment; vẫn gõ tay được */
    workloadKnown: (n: number, env: string) =>
      `${formatNumber(n)} workload đã deploy ở ${env}: chọn trong danh sách hoặc gõ tên.`,
    /** [Plan #58 UX-22] Luật đặt tên bằng lời thường, không dẫn tên chuẩn */
    workloadInvalid:
      "Tên chỉ gồm chữ thường, số, dấu gạch ngang và dấu chấm; bắt đầu và kết thúc bằng chữ hoặc số.",
    checking: "Đang kiểm tra…",
    checkMetrics: "Kiểm tra metric",
    cadence: "Nhịp lên bậc",
    stepPercent: "Mỗi bậc tăng (%)",
    dwell: "Giữ mỗi bậc (giây)",
    dwellHint: "Đủ thời gian này mới lên bậc tiếp.",
    analysis: "Đo lại mỗi (giây)",
    warmUp: "Số request tối thiểu trước khi đánh giá",
    thresholds: "Ngưỡng tự lùi lại",
    errorRate: "Tỉ lệ lỗi tối đa (%)",
    latency: "Độ trễ p99 tối đa (ms)",
    latencyHint: "99% request phải nhanh hơn số này.",
    minErrors: "Số lỗi tối thiểu để tính vượt",
    breaches: "Vượt liên tiếp mấy lần thì tự lùi lại",
    /** [Plan #58 UX-39] Máy chủ trả lỗi theo ô: câu chung ở cuối, lỗi cụ thể nằm dưới từng ô */
    fixFields: "Chưa tạo được rollout: sửa các ô được đánh dấu.",
    metricsGuide: {
      title: (workload: string) => `Workload ${workload} chưa xuất metric HTTP`,
      body: "Rollout cần so tỉ lệ lỗi giữa hai nhánh (flag hay phiên bản). Thêm middleware sau vào ứng dụng, deploy lại, rồi kiểm tra lại.",
      recheck: "Kiểm tra lại",
    },
  },
  /** Hộp tạo rollout FLAG_LEVEL */
  flag: {
    missingConfig: "Flag chưa có cấu hình ở env này",
    descriptionSplit:
      "Chia theo thuộc tính: nhóm khớp một rule theo thuộc tính hay segment nhận variant mới; bạn quyết promote hay rollback.",
    descriptionCanary:
      "Canary theo flag: tăng dần tỉ lệ của một variant trong một rule phân phối, cùng một phiên bản mã.",
    strategy: {
      CANARY: "Canary",
      ATTRIBUTE_SPLIT: "Theo thuộc tính",
    } satisfies Record<"CANARY" | "ATTRIBUTE_SPLIT", string>,
    flag: "Flag (đang dùng)",
    search: "Tìm flag đang dùng",
    searchPlaceholder: "Tìm theo key…",
    chooseFlag: "Chọn flag",
    flagOff: (env: string) => `Flag đang tắt ở ${env}: bật trước khi rollout.`,
    ruleSplit: "Rule theo thuộc tính",
    ruleRamp: "Rule sẽ ramp",
    chooseRule: "Chọn rule",
    ruleOption: (n: number, description: string | null, single: boolean) =>
      `Rule ${String(n)}${description === null ? "" : `: ${description}`}${single ? " (một variant)" : ""}`,
    variantSplit: "Variant mới cho nhóm khớp",
    variantRamp: "Variant tăng dần",
    chooseVariant: "Chọn variant",
    variantOption: (key: string, percent: number) =>
      `${key} (đang ${String(percent)}%)`,
    cannotRamp: (reason: string) => `Không ramp được: ${reason}`,
    /** Lý do theo MÃ của `canaryPairOf` (I37: máy chủ trả mã, câu là của Portal) */
    rampReason: (code: CanaryInvalidCode, branches: number): string => {
      switch (code) {
        case "not-distribution":
          return "rule phục vụ thẳng một variant, chỉ ramp được rule phân phối";
        case "not-two-branches":
          return `rule có ${String(branches)} variant, canary theo flag chỉ hỗ trợ hai nhánh`;
        case "target-missing":
          return "variant mục tiêu không nằm trong phân phối của rule";
        case "already-full":
          return "variant mục tiêu đã phục vụ 100%, không còn gì để ramp";
      }
    },
    singleVariantRule:
      "Rule này phục vụ thẳng một variant; chỉ ramp được rule chia tỉ lệ.",
    hasMetrics: (scrape: string, window: string) =>
      `Có metric. Số đo được đọc mỗi ${scrape}; mỗi lần đánh giá cần ít nhất ${window} số đo.`,
    metricsUnreachable:
      "Không tới được nguồn metrics của project. Rollout cần một Prometheus đang chạy.",
    analysisHint: "Vẫn đo trong lúc chờ lên bậc: vượt ngưỡng là rollback ngay.",
  },
  /** Hộp tạo rollout SERVICE_LEVEL */
  service: {
    strategy: {
      CANARY: "Canary",
      BLUE_GREEN: "Blue/Green",
      ATTRIBUTE_SPLIT: "Theo header",
    } satisfies Record<ServiceStrategy, string>,
    /** Vì sao một ô của ma trận §7.2 không chạy được với tool của environment — theo MÃ của `serviceLevelIssueOf` */
    issue: (i: ServiceLevelIssue): string => {
      switch (i.code) {
        case "no-executor":
          return `${i.toolId} chưa chạy được rollout theo phiên bản: UDP hỗ trợ Argo Rollouts và Flagger.`;
        case "blue-green-needs-argo":
          return "Blue/Green theo phiên bản là Rollout blueGreen của Argo Rollouts; environment này dùng Flagger.";
        case "ab-needs-flagger":
          return "Theo header do công cụ quyết là A/B của Flagger; với Argo Rollouts hãy chọn UDP quyết.";
        case "split-needs-istio":
          return `Theo header do UDP quyết định tuyến bằng VirtualService của Istio; router của environment là ${i.router}.`;
      }
    },
    description:
      "Canary theo phiên bản: phiên bản mới của một workload nhận traffic dần qua công cụ giao hàng của environment.",
    noTool:
      "Project chưa bật domain Progressive Delivery (Argo Rollouts hoặc Flagger): rollout theo phiên bản cần một công cụ giữ đường traffic.",
    deliveryTool: (tool: ReactNode) => <>Công cụ giao hàng: {tool}</>,
    mode: "Chế độ",
    modeOption: {
      "tool-driven": "Công cụ tự quyết",
      "udp-driven": "UDP quyết",
    } satisfies Record<ControlModeWire, string>,
    modeHint: {
      "tool-driven":
        "Công cụ tự phân tích và tự promote; UDP hiển thị tiến độ, bạn vẫn promote hay rollback tay được.",
      "udp-driven":
        "UDP so tỉ lệ lỗi phiên bản mới với phiên bản cũ và cho công cụ đi từng bậc.",
    } satisfies Record<ControlModeWire, string>,
    hasMetrics: (window: string) =>
      `Có metric. Mỗi lần đánh giá cần ít nhất ${window} số đo.`,
    metricsUnreachable: "Không tới được nguồn metrics của project.",
    tag: "Tag image mới",
    tagHint: "Cùng repository với image đang chạy; chỉ tag đổi.",
    tagInvalid: "Tag image không hợp lệ.",
    header: "Header chọn nhóm",
    headerPlaceholder: "X-Beta…",
    headerValue: "Giá trị",
    stepPercentHint: "Số nguyên: công cụ nhận trọng số nguyên.",
  },
  /** Trang chi tiết một rollout */
  detail: {
    back: "Về danh sách rollout",
    fallbackTitle: "rollout",
    action: {
      PAUSE: "Tạm dừng",
      RESUME: "Tiếp tục",
      PROMOTE: "Lên 100%",
      ROLLBACK: "Rollback",
    } satisfies Record<RolloutIntentActionWire, string>,
    makeDefault: (variant: string | undefined) =>
      `Đổi mặc định sang ${variant ?? "variant mới"}`,
    mode: {
      "udp-driven": "UDP quyết",
      "tool-driven": "công cụ tự quyết",
    } satisfies Record<ControlModeWire, string>,
    rampVariant: (variant: ReactNode) => <>Tăng variant {variant}</>,
    versionChange: (from: ReactNode, to: ReactNode) => (
      <>
        Phiên bản {from} → {to}
      </>
    ),
    workload: (name: ReactNode) => <>workload {name}</>,
    autoRollback: "Hệ thống đã tự rollback",
    autoRollbackReason: "Metric vượt ngưỡng liên tiếp.",
    abortFailed: "Không abort được vì không vào được cluster của project",
    abortFailedHint: "Kiểm tra ngay Rollout/Canary của workload trong cluster.",
    rollbackFailed: "Không rollback được vì Flag Service không phản hồi",
    rollbackFailedHint:
      "Cơ chế an toàn thất bại: kiểm tra ngay trạng thái của flag.",
    trafficMatch: (header: ReactNode) => (
      <>Nhóm đi phiên bản mới: request có header {header}</>
    ),
    toolDriven: "Công cụ giao hàng tự phân tích và tự quyết",
    toolDrivenHint:
      "UDP soi gương tiến độ của nó; bạn vẫn promote hay rollback tay được.",
    splitNote: "Chia theo thuộc tính: hệ thống không tự promote hay rollback",
    splitNoteHint:
      "Hai nhóm khác nhau về bản chất, nên chênh lệch dưới đây là số kỹ thuật, không quy được cho nhánh flag. Bạn quyết: đổi variant mặc định sang variant mới, hoặc rollback.",
    traffic: {
      service: "Lưu lượng phiên bản mới",
      split: "Nhóm khớp nhận variant mới",
      flag: "Lưu lượng variant mới",
    },
    /** [Plan #58 UX-20] Lời thường thay "Mốc rollback": lưu lượng của nhánh mới nếu lùi lại */
    baseline: "Lưu lượng khi lùi lại",
    errorRates: {
      service: "Tỉ lệ lỗi phiên bản mới / cũ",
      split: "Tỉ lệ lỗi nhánh mới / nhánh cũ",
      flag: "Tỉ lệ lỗi bản thử / nhóm đối chứng",
    },
    latency: "Độ trễ p99 của bản thử",
    ms: "ms",
    progress: "Lưu lượng đã chuyển",
    cadence: (step: ReactNode, every: string, analysis: string) => (
      <>
        Bậc {step} mỗi {every}, đo lại mỗi {analysis}
      </>
    ),
    promql: "Truy vấn PromQL đã chạy",
    zScore: (value: string) => `z-score: ${value}`,
    log: "Nhật ký",
    inProgressBy: (action: string, by: string) =>
      `Đang thực hiện: ${action} (yêu cầu bởi ${by})`,
    aMember: "một thành viên",
    waitingFirst: "Đang chờ lần đo đầu tiên.",
    breach: (streak: number, max: number, last: boolean) =>
      `Vượt ngưỡng ${String(streak)}/${String(max)}${last ? ", sẽ tự lùi lại nếu lần đo tới vẫn vượt" : ""}`,
    nextAnalysis: (after: string) => `Đo lại sau ${after}. `,
    nextAnalysisNow: "Sắp đo lại. ",
    dwellLeft: (after: string) => `Đủ thời gian giữ bậc sau ${after}.`,
    /** [Plan #58 UX-6] Hết thời gian giữ bậc: nói việc tiếp theo, không nói "sau 0 giây" */
    dwellDone: "Có thể lên bậc tiếp.",
    dwellDoneHeld:
      "Đã đủ thời gian giữ bậc, nhưng chưa lên vì số đo đang vượt ngưỡng.",
    working: "Đang thực hiện…",
    requestSent: (action: string) => `Đã gửi yêu cầu: ${action}`,
    confirmRollback: "Rollback rollout này?",
    confirmMakeDefault: "Đổi variant mặc định?",
    confirmPromote: "Đưa lên 100%?",
    serviceRollback: (oldVersion: string | undefined) =>
      `Công cụ giao hàng đưa toàn bộ traffic về phiên bản ${oldVersion ?? "cũ"}.`,
    servicePromote: (newVersion: string | undefined) =>
      `Phiên bản ${newVersion ?? "mới"} nhận 100% traffic.`,
    flagRollback: (baseline: string | null) =>
      `Lưu lượng của variant mới trở về ${baseline ?? "mức ban đầu"}.`,
    splitPromote:
      "Mọi người dùng của environment, không riêng nhóm khớp, sẽ nhận variant mới làm mặc định. Rollout kết thúc.",
    flagPromote: "Mọi người dùng khớp rule sẽ nhận variant mới.",
    event: {
      PROMOTE: "Lên bậc",
      ROLLBACK: "Rollback",
      PAUSE: "Tạm dừng",
      RESUME: "Tiếp tục",
      COMPLETE: "Hoàn tất",
      EXPIRE: "Hết hạn",
      DEPENDENCY_DOWN: "Phụ thuộc không phản hồi",
    } satisfies Record<RolloutEventWire["action"], string>,
    noEvents: "Chưa có sự kiện.",
    requestPrefix: "Yêu cầu: ",
    errorRate: "Tỉ lệ lỗi",
    noMeasurements: "Chưa có lần đo nào có số liệu.",
    canary: "bản thử (canary)",
    control: "nhóm đối chứng (baseline)",
    threshold: (value: string) => `ngưỡng ${value}`,
  },
};

export const rolloutMessages = defineMessages({
  vi,
  en: {
    status: {
      PENDING: "Pending",
      IN_PROGRESS: "Running",
      PAUSED: "Paused",
      DONE: "Completed",
      FAILED: "Rolled back",
    },
    watcher: {
      finished: (name: string) => `Rollout ${name} has finished.`,
      view: "View result",
    },
    list: {
      title: "Rollouts",
      create: "Create rollout",
      lead: (env: string) =>
        `Ramp up a variant gradually and roll back automatically when metrics cross a threshold. Viewing ${env}.`,
      empty: (env: string) => `No rollouts in ${env} yet`,
      emptyWhy:
        "A rollout delivers a flag variant, or a new version of a service, to users a percentage at a time, and rolls back automatically when metrics look bad.",
      emptyNeed:
        "First you need an active flag with a percentage split rule (or a deployed workload), and that workload must export HTTP metrics.",
      emptyRole: (role: string) =>
        `Only the ${role} role or higher can create rollouts.`,
      createFirst: "Create the first rollout",
      label: "Rollout list",
      strategy: {
        CANARY: "Canary",
        ATTRIBUTE_SPLIT: "Attribute split",
        BLUE_GREEN: "Blue-Green",
      },
      scope: {
        FLAG_LEVEL: "by flag",
        SERVICE_LEVEL: "by version",
      },
    },
    form: {
      title: (env: string) => `Create rollout in ${env}`,
      cancel: "Cancel",
      creating: "Creating…",
      create: "Create rollout",
      scope: "Scope",
      scopeOption: {
        FLAG_LEVEL: "By flag",
        SERVICE_LEVEL: "By version",
      },
      strategy: "Strategy",
      workload: "Workload (service name in the cluster)",
      workloadPlaceholder: "checkout-api…",
      workloadKnown: (n: number, env: string) =>
        `${count(n, "workload", "workloads")} deployed in ${env}: pick one from the list or type a name.`,
      workloadInvalid:
        "Use only lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit.",
      checking: "Checking…",
      checkMetrics: "Check metrics",
      cadence: "Step cadence",
      stepPercent: "Step size (%)",
      dwell: "Hold each step (seconds)",
      dwellHint: "The next step starts only after this much time.",
      analysis: "Measure every (seconds)",
      warmUp: "Minimum requests before evaluating",
      thresholds: "Automatic rollback thresholds",
      errorRate: "Maximum error rate (%)",
      latency: "Maximum p99 latency (ms)",
      latencyHint: "99% of requests must be faster than this.",
      minErrors: "Minimum errors to count a breach",
      breaches: "Consecutive breaches before automatic rollback",
      fixFields: "The rollout was not created: fix the marked fields.",
      metricsGuide: {
        title: (workload: string) =>
          `Workload ${workload} does not export HTTP metrics yet`,
        body: "A rollout compares the error rate of two branches (flag or version). Add the middleware below to the application, redeploy, then check again.",
        recheck: "Check again",
      },
    },
    flag: {
      missingConfig: "The flag has no configuration in this environment",
      descriptionSplit:
        "Attribute split: the group matching an attribute or segment rule gets the new variant; you decide whether to promote or roll back.",
      descriptionCanary:
        "Flag canary: gradually raise one variant's share in a distribution rule, on the same code version.",
      strategy: {
        CANARY: "Canary",
        ATTRIBUTE_SPLIT: "By attribute",
      },
      flag: "Flag (active)",
      search: "Search active flags",
      searchPlaceholder: "Search by key…",
      chooseFlag: "Choose a flag",
      flagOff: (env: string) =>
        `The flag is off in ${env}: turn it on before rolling out.`,
      ruleSplit: "Attribute rule",
      ruleRamp: "Rule to ramp",
      chooseRule: "Choose a rule",
      ruleOption: (n: number, description: string | null, single: boolean) =>
        `Rule ${String(n)}${description === null ? "" : `: ${description}`}${single ? " (single variant)" : ""}`,
      variantSplit: "New variant for the matching group",
      variantRamp: "Variant to ramp",
      chooseVariant: "Choose a variant",
      variantOption: (key: string, percent: number) =>
        `${key} (currently ${String(percent)}%)`,
      cannotRamp: (reason: string) => `Cannot ramp: ${reason}`,
      rampReason: (code: CanaryInvalidCode, branches: number): string => {
        switch (code) {
          case "not-distribution":
            return "the rule serves a single variant; only a split rule can be ramped";
          case "not-two-branches":
            return `the rule has ${String(branches)} variants; flag canary supports exactly two`;
          case "target-missing":
            return "the target variant is not part of the rule's split";
          case "already-full":
            return "the target variant already serves 100%; there is nothing left to ramp";
        }
      },
      singleVariantRule:
        "This rule serves a single variant directly; only a split rule can be ramped.",
      hasMetrics: (scrape: string, window: string) =>
        `Metrics found. They are read every ${scrape}; each evaluation needs at least ${window} of data.`,
      metricsUnreachable:
        "Cannot reach the project's metrics source. A rollout needs a running Prometheus.",
      analysisHint:
        "Measurement continues while waiting for the next step: crossing a threshold rolls back immediately.",
    },
    service: {
      strategy: {
        CANARY: "Canary",
        BLUE_GREEN: "Blue/Green",
        ATTRIBUTE_SPLIT: "By header",
      },
      issue: (i: ServiceLevelIssue): string => {
        switch (i.code) {
          case "no-executor":
            return `${i.toolId} cannot run version rollouts yet: UDP supports Argo Rollouts and Flagger.`;
          case "blue-green-needs-argo":
            return "Version Blue/Green is an Argo Rollouts blueGreen Rollout; this environment uses Flagger.";
          case "ab-needs-flagger":
            return "Tool-driven by header is Flagger's A/B; with Argo Rollouts choose UDP-driven.";
          case "split-needs-istio":
            return `UDP-driven by header routes through an Istio VirtualService; the environment's router is ${i.router}.`;
        }
      },
      description:
        "Version canary: the new version of a workload gradually receives traffic through the environment's delivery tool.",
      noTool:
        "The project has not enabled the Progressive Delivery domain (Argo Rollouts or Flagger): a version rollout needs a tool that controls the traffic path.",
      deliveryTool: (tool: ReactNode) => <>Delivery tool: {tool}</>,
      mode: "Mode",
      modeOption: {
        "tool-driven": "Tool decides",
        "udp-driven": "UDP decides",
      },
      modeHint: {
        "tool-driven":
          "The tool analyzes and promotes on its own; UDP shows the progress, and you can still promote or roll back manually.",
        "udp-driven":
          "UDP compares the new version's error rate with the old version's and moves the tool one step at a time.",
      },
      hasMetrics: (window: string) =>
        `Metrics found. Each evaluation needs at least ${window} of data.`,
      metricsUnreachable: "Cannot reach the project's metrics source.",
      tag: "New image tag",
      tagHint: "Same repository as the running image; only the tag changes.",
      tagInvalid: "Invalid image tag.",
      header: "Header that selects the group",
      headerPlaceholder: "X-Beta…",
      headerValue: "Value",
      stepPercentHint: "Whole number: the tool only accepts integer weights.",
    },
    detail: {
      back: "Back to rollouts",
      fallbackTitle: "rollout",
      action: {
        PAUSE: "Pause",
        RESUME: "Resume",
        PROMOTE: "Promote to 100%",
        ROLLBACK: "Roll back",
      },
      makeDefault: (variant: string | undefined) =>
        variant === undefined
          ? "Make the new variant the default"
          : `Make ${variant} the default`,
      mode: {
        "udp-driven": "UDP decides",
        "tool-driven": "tool decides",
      },
      rampVariant: (variant: ReactNode) => <>Ramping variant {variant}</>,
      versionChange: (from: ReactNode, to: ReactNode) => (
        <>
          Version {from} → {to}
        </>
      ),
      workload: (name: ReactNode) => <>workload {name}</>,
      autoRollback: "The system rolled back automatically",
      autoRollbackReason:
        "Metrics crossed the threshold several times in a row.",
      abortFailed: "Could not abort: the project's cluster is unreachable",
      abortFailedHint:
        "Check the workload's Rollout/Canary in the cluster right away.",
      rollbackFailed: "Could not roll back: Flag Service is not responding",
      rollbackFailedHint:
        "The safety mechanism failed: check the flag's state right away.",
      trafficMatch: (header: ReactNode) => (
        <>Group on the new version: requests with header {header}</>
      ),
      toolDriven: "The delivery tool analyzes and decides on its own",
      toolDrivenHint:
        "UDP mirrors its progress; you can still promote or roll back manually.",
      splitNote:
        "Attribute split: the system does not promote or roll back on its own",
      splitNoteHint:
        "The two groups differ by nature, so the gap below is a technical figure that cannot be attributed to the flag branch. You decide: make the new variant the default, or roll back.",
      traffic: {
        service: "New version traffic",
        split: "Matching group on the new variant",
        flag: "New variant traffic",
      },
      baseline: "Traffic after rollback",
      errorRates: {
        service: "Error rate, new / old version",
        split: "Error rate, new / old branch",
        flag: "Error rate, canary / baseline",
      },
      latency: "Canary p99 latency",
      ms: "ms",
      progress: "Traffic shifted",
      cadence: (step: ReactNode, every: string, analysis: string) => (
        <>
          Steps of {step} every {every}, measured every {analysis}
        </>
      ),
      promql: "PromQL queries run",
      zScore: (value: string) => `z-score: ${value}`,
      log: "Log",
      inProgressBy: (action: string, by: string) =>
        `In progress: ${action} (requested by ${by})`,
      aMember: "a member",
      waitingFirst: "Waiting for the first measurement.",
      breach: (streak: number, max: number, last: boolean) =>
        `Threshold crossed ${String(streak)}/${String(max)}${last ? ", will roll back automatically if the next measurement also crosses it" : ""}`,
      nextAnalysis: (after: string) => `Next measurement in ${after}. `,
      nextAnalysisNow: "Measuring again shortly. ",
      dwellLeft: (after: string) => `Step hold time ends in ${after}.`,
      dwellDone: "Ready for the next step.",
      dwellDoneHeld:
        "The hold time is over, but the rollout stays because metrics are above the threshold.",
      working: "In progress…",
      requestSent: (action: string) => `Request sent: ${action}`,
      confirmRollback: "Roll back this rollout?",
      confirmMakeDefault: "Change the default variant?",
      confirmPromote: "Promote to 100%?",
      serviceRollback: (oldVersion: string | undefined) =>
        oldVersion === undefined
          ? "The delivery tool moves all traffic back to the old version."
          : `The delivery tool moves all traffic back to version ${oldVersion}.`,
      servicePromote: (newVersion: string | undefined) =>
        newVersion === undefined
          ? "The new version receives 100% of traffic."
          : `Version ${newVersion} receives 100% of traffic.`,
      flagRollback: (baseline: string | null) =>
        baseline === null
          ? "New variant traffic returns to its starting level."
          : `New variant traffic returns to ${baseline}.`,
      splitPromote:
        "Every user in the environment, not just the matching group, gets the new variant as the default. The rollout ends.",
      flagPromote: "Every user matching the rule gets the new variant.",
      event: {
        PROMOTE: "Step up",
        ROLLBACK: "Rollback",
        PAUSE: "Pause",
        RESUME: "Resume",
        COMPLETE: "Complete",
        EXPIRE: "Expired",
        DEPENDENCY_DOWN: "Dependency not responding",
      },
      noEvents: "No events yet.",
      requestPrefix: "Request: ",
      errorRate: "Error rate",
      noMeasurements: "No measurements with data yet.",
      canary: "canary",
      control: "baseline",
      threshold: (value: string) => `threshold ${value}`,
    },
  },
});
