import type { ReactNode } from "react";
import { count, defineMessages } from "../../../i18n";
import { formatNumber } from "../../../lib/format";
import type {
  EvidenceGroup,
  EvidenceStatus,
  ExperimentId,
} from "./experiments";

export interface ExperimentText {
  title: string;
  /** Phép đo chứng minh điều gì — một câu */
  proves: string;
  /** Với phép đo chưa có số: cần gì để đo */
  needs?: string;
}

/** [Plan #56] Chữ của trang "Bằng chứng thực nghiệm" (Bảng điều khiển nền tảng) */
export const evidenceMessages = defineMessages({
  vi: {
    title: "Bằng chứng thực nghiệm",
    lead: "Mọi phép đo của §14: đã có số, có số một phần, còn nợ, hay cần người thật. Biểu đồ đọc thẳng từ tệp kết quả trong repo, kèm nguồn để kiểm lại.",
    minis: {
      measured: (_n: number) => "phép đo §14 có số",
      contributions: (_n: number) => "đóng góp có từ 2 phép đo có số",
      debts: (_n: number) => "mục nợ kiểm chứng",
      latest: "lần đo mới nhất",
    },
    group: {
      C1: "C1 · Guarded rollout ở tầng flag, chung vòng điều khiển với canary",
      C2: "C2 · Ràng buộc capability giữa các domain",
      C3: "C3 · Ngữ nghĩa thất bại làm hợp đồng của adapter",
      base: "Số liệu nền của hệ thống",
      people: "Cần người dùng thật (§14.2)",
      extra: "Phép đo bổ sung",
    } satisfies Record<EvidenceGroup, string>,
    status: {
      measured: "Đã đo",
      partial: "Đo một phần",
      live: "Số sống",
      pending: "Chưa đo",
      people: "Cần người thật",
    } satisfies Record<EvidenceStatus, string>,
    supports: (codes: string) => `Bằng chứng cho ${codes}`,
    debts: (codes: string) => `Sổ nợ: ${codes}`,
    source: {
      file: "Tệp",
      measuredAt: (when: string) => `đo lúc ${when}`,
      commit: (sha: string) => `commit ${sha}`,
      dirty: (sha: string) =>
        `cây có thay đổi chưa commit (sha256 diff ${sha})`,
      clean: "cây sạch",
      machine: (cpu: string, cores: number, freeGiB: string) =>
        `${cpu}, ${formatNumber(cores)} luồng, RAM trống ${freeGiB} GiB`,
      earlier: (n: number) => `${formatNumber(n)} lần đo trước`,
      downloadRaw: "Tải tệp thô",
    },
    broken: (file: string) => `Tệp ${file} không đọc được theo schema`,
    noChart:
      "Đã có tệp thô, chưa có biểu đồ riêng cho phép đo này. Tải tệp để xem số.",
    loadFailed: "Không đọc được các tệp kết quả đo",
    experiment: {
      E1: {
        title: "Effort mở rộng adapter",
        proves:
          "Thêm tool hay domain mới không phải sửa gì ngoài thư mục adapter: đếm tệp ngoài adapter, lần phá interface, lần nới contract test.",
      },
      E2: {
        title: "Thời gian provisioning theo từng cloud",
        proves:
          "So sánh ba Cloud Adapter: trung vị và khoảng biến thiên của thời gian dựng mạng, cluster, domain.",
        needs:
          "Ba lần dựng thật trên mỗi cloud (AWS, GCP, Azure), trái yêu cầu chi phí 0 nên chưa đo.",
      },
      E3: {
        title: "Độ trễ đánh giá flag",
        proves:
          "Đánh giá cục bộ qua SDK OpenFeature thật dưới 1 ms hai bậc độ lớn, so với đánh giá từ xa (OFREP).",
      },
      E4: {
        title: "Độ trễ lan truyền thay đổi flag",
        proves:
          "Giá trị của change feed ba tầng: độ trễ và số byte mỗi thay đổi theo chế độ snapshot và delta, có và không có NOTIFY.",
      },
      E5: {
        title: "MTTD và MTTR của auto-rollback",
        proves:
          "Phép đo chính của C1: rollback ở mức flag so với mức service trên cùng kịch bản lỗi, đã đăng ký giả thuyết trước.",
        needs:
          "Prometheus, ba service và hai ứng dụng mẫu chạy thật, cộng kịch bản bơm lỗi của §13.4.",
      },
      E6: {
        title: "Tỉ lệ rollback nhầm",
        proves:
          "Cơ chế chống rollback nhầm: 20 lần gai lỗi thoáng qua với maxConsecutiveBreaches = 1 và = 2.",
        needs: "Cùng hạ tầng với E5.",
      },
      E7: {
        title: "Phân phối của consistent hashing",
        proves:
          "Chia nhóm người dùng đúng tỉ lệ: 1 000 000 userId qua đường đánh giá thật, kiểm định chi-square.",
      },
      E8: {
        title: "Capability validator đối chiếu oracle",
        proves:
          "Validator không bỏ sót tổ hợp sai: differential testing với oracle độc lập, rồi mutation testing.",
      },
      E9: {
        title: "Tài nguyên tiêu thụ của UDP",
        proves:
          "Tính khả thi vận hành: CPU và RAM của ba service khi rỗi và khi có 1 000 kết nối SDK.",
        needs:
          "Làn đêm của CI trên cụm kind ghi kết quả; tệp chính thức khi commit vào raw/.",
      },
      E10: {
        title: "DORA tính từ Event Store",
        proves:
          "Năm chỉ số DORA của luồng phát triển trên chính nền tảng, tính sống từ sự kiện deploy: có số kể cả khi chưa có người dùng ngoài.",
      },
      E11: {
        title: "Developer Experience (SUS)",
        proves:
          "Thang SUS 10 câu chuẩn hoá, 10 đến 15 sinh viên cùng một bộ nhiệm vụ.",
        needs: "Nhóm người dùng thật chịu thử.",
      },
      E12: {
        title: "Thời gian hoàn thành nhiệm vụ",
        proves: "Bấm giờ từng nhiệm vụ, so với tự dựng thủ công cùng stack.",
        needs: "Cùng nhóm người dùng của E11.",
      },
      E13: {
        title: "Tỉ lệ hoàn thành và lỗi thao tác",
        proves: "Quan sát trực tiếp, ghi lại điểm nghẽn.",
        needs: "Cùng nhóm người dùng của E11.",
      },
      E14: {
        title: "Chi phí cardinality của nhãn ff",
        proves:
          "Gắn nhãn theo nhánh flag chỉ CỘNG thêm series, không nhân chéo: số đo khớp công thức dự đoán.",
      },
      E15: {
        title: "Ma trận crash, đối chứng Terraform và Pulumi",
        proves:
          "Bằng chứng chính của C3: giết tiến trình ở từng điểm của lưới K1–K10, đếm tài nguyên trùng, mồ côi, can thiệp tay.",
        needs: "LocalStack và các ô EKS trên AWS thật.",
      },
      E16: {
        title: "Ma trận drift, đối chứng Helm và Argo CD",
        proves:
          "Phát hiện nhưng không tự sửa: năm loại sửa đổi ngoài luồng, độ trễ phát hiện, diff có chỉ đúng chỗ.",
        needs: "Cụm thật với Helm và Argo CD cùng bộ công cụ.",
      },
      I34: {
        title: "I34 · Mất database 5 phút giữa lúc có traffic",
        proves:
          "Service 2 mất kết nối database vẫn trả cấu hình cũ, không đánh giá sai, và hội tụ lại khi nối.",
      },
      "portal-pagination": {
        title: "Danh sách flag của Portal",
        proves:
          "Một trang danh sách (200 flag × 3 env) trả trong 500 ms. Số hiện tại CHƯA ĐẠT, ghi đúng như đo.",
      },
      "kyverno-crd": {
        title: "Policy admission hợp lệ theo CRD thật",
        proves:
          "Policy chữ ký image mà UDP sinh ra qua được bộ kiểm dựng từ chính CRD của Kyverno 1.19.1, kèm một phép kiểm ngược: một policy sai bị từ chối.",
      },
      "chart-values": {
        title: "Khoá values của adapter so với chart thật",
        proves:
          "Khoá mà adapter đặt vào values của chart có tồn tại trong chart đó không. Helm bỏ qua khoá lạ trong im lặng, nên lệch khoá là một cấu hình không có tác dụng.",
      },
    } satisfies Record<ExperimentId, ExperimentText>,
    charts: {
      e1: {
        batches: "Tệp thay đổi mỗi đợt thêm tool",
        inside: "Trong thư mục adapter",
        outside: "Ngoài thư mục adapter",
        breaks: "lần phá interface",
        relaxations: "lần nới contract test",
        tools: "tool thêm sau tag",
        perTool: "tệp ngoài adapter mỗi tool",
        batch: "Đợt",
      },
      e3: {
        title: "Độ trễ đánh giá theo ô lưới",
        sdkP50: "SDK p50",
        sdkP99: "SDK p99",
        coreP50: "Lõi p50",
        coreP99: "Lõi p99",
        cell: "Ô lưới",
        cellLabel: (flags: number, rules: number) =>
          `${formatNumber(flags)} flag · ${formatNumber(rules)} rule`,
        remote: (p50: string, p99: string) =>
          `Đối chứng từ xa (OFREP): p50 ${p50}, p99 ${p99}.`,
      },
      e4: {
        latency: "Độ trễ lan truyền p50",
        bytes: "Byte mỗi thay đổi (phía máy chủ)",
        flags: "Số flag",
        flagsLabel: (n: number) => `${formatNumber(n)} flag`,
        mode: (mode: string, notify: boolean) =>
          `${mode} · ${notify ? "NOTIFY" : "poll"}`,
      },
      e7: {
        title: "χ² so với giá trị tới hạn (α = 0,001)",
        chi2: "χ²",
        critical: "Tới hạn",
        scenario: "Kịch bản",
        shares: "Tỉ lệ quan sát so với mong muốn",
        observed: "Quan sát",
        expected: "Mong muốn",
        variant: "Variant",
      },
      e8: {
        title: "17 mutant của validator",
        byDifferential: "Bị giết bởi differential",
        bySuiteOnly: "Chỉ bị giết bởi bộ test",
        survived: "Sống sót",
        oracle: "Mã lỗi oracle sinh ra",
      },
      e10: {
        window: "Cửa sổ",
        days: (n: number) => `${formatNumber(n)} ngày`,
        daily: "Deploy vào production mỗi ngày",
        success: "Thành công",
        failure: "Thất bại",
        table: "DORA theo project (env production)",
        project: "Project",
        deployments: "Deploy",
        frequency: "Mỗi ngày",
        leadTime: "Lead time (trung vị)",
        failureRate: "Change failure rate",
        recovery: "Khôi phục (trung vị)",
        none: "Chưa project nào có deploy vào production trong cửa sổ này.",
        idle: (n: number) =>
          `${formatNumber(n)} project có env production nhưng chưa deploy trong cửa sổ.`,
      },
      e14: {
        title: "Số series theo (T, V)",
        predicted: "Dự đoán",
        complete: "Đo, đủ tổ hợp",
        realistic: "Đo, traffic thực tế",
        cell: "Ô lưới",
        formula: (f: string) => `Công thức: ${f}`,
      },
      i34: {
        title: "Hội tụ sau khi nối lại",
        converged: "Hội tụ sau",
        limit: "Giới hạn",
        phase: "Pha",
        wrong: (n: number, total: number) =>
          `${formatNumber(n)} lượt sai hay lỗi trên ${formatNumber(total)} lượt đánh giá trong lúc mất database`,
      },
      flagList: {
        title: "Thời gian trả lời theo đường gọi",
        page: "Một trang",
        count: "Chỉ đếm",
        full: "Cả danh sách",
        threshold: "Ngưỡng 500 ms",
        route: "Đường gọi",
      },
    },
    unit: {
      us: (v: string) => `${v} µs`,
      ms: (v: string) => `${v} ms`,
      s: (v: string) => `${v} s`,
      bytes: (v: string) => `${v} B`,
      perDay: (v: string) => `${v}/ngày`,
    },
    csvName: (id: string, chart: string) => `${id}-${chart}.csv`,
    rich: {
      ofTotal: (value: ReactNode, total: number) => (
        <>
          {value}/{formatNumber(total)}
        </>
      ),
    },
  },
  en: {
    title: "Experimental evidence",
    lead: "Every measurement of §14: measured, partly measured, still owed, or needing real users. Charts read straight from the result files in the repo, with their source so you can check them.",
    minis: {
      measured: (n: number) =>
        n === 1 ? "§14 measurement with data" : "§14 measurements with data",
      contributions: (n: number) =>
        n === 1
          ? "contribution backed by 2+ measurements"
          : "contributions backed by 2+ measurements",
      debts: (n: number) =>
        n === 1 ? "open verification item" : "open verification items",
      latest: "latest measurement",
    },
    group: {
      C1: "C1 · Guarded rollout at the flag layer, one control loop with canary",
      C2: "C2 · Capability constraints across domains",
      C3: "C3 · Failure semantics as the adapter contract",
      base: "System baseline figures",
      people: "Needs real users (§14.2)",
      extra: "Supplementary measurements",
    },
    status: {
      measured: "Measured",
      partial: "Partly measured",
      live: "Live",
      pending: "Not measured",
      people: "Needs real users",
    },
    supports: (codes: string) => `Evidence for ${codes}`,
    debts: (codes: string) => `Open items: ${codes}`,
    source: {
      file: "File",
      measuredAt: (when: string) => `measured ${when}`,
      commit: (sha: string) => `commit ${sha}`,
      dirty: (sha: string) =>
        `working tree had uncommitted changes (diff sha256 ${sha})`,
      clean: "clean working tree",
      machine: (cpu: string, cores: number, freeGiB: string) =>
        `${cpu}, ${formatNumber(cores)} threads, ${freeGiB} GiB free RAM`,
      earlier: (n: number) => count(n, "earlier run", "earlier runs"),
      downloadRaw: "Download raw file",
    },
    broken: (file: string) => `The file ${file} does not match its schema`,
    noChart:
      "A raw file exists, but this measurement has no chart yet. Download the file to read the figures.",
    loadFailed: "Could not read the measurement files",
    experiment: {
      E1: {
        title: "Adapter extension effort",
        proves:
          "Adding a tool or a domain needs no change outside the adapter folder: files outside adapters, interface breaks, contract test relaxations.",
      },
      E2: {
        title: "Provisioning time per cloud",
        proves:
          "Compares the three Cloud Adapters: median and spread of network, cluster and domain setup time.",
        needs:
          "Three real provisioning runs on each cloud (AWS, GCP, Azure), which the zero-cost rule rules out for now.",
      },
      E3: {
        title: "Flag evaluation latency",
        proves:
          "Local evaluation through the real OpenFeature SDK is two orders of magnitude below 1 ms, compared with remote evaluation (OFREP).",
      },
      E4: {
        title: "Flag change propagation delay",
        proves:
          "The value of the three-tier change feed: delay and bytes per change for snapshot and delta, with and without NOTIFY.",
      },
      E5: {
        title: "Auto-rollback MTTD and MTTR",
        proves:
          "The main C1 measurement: flag-level versus service-level rollback on the same fault scenario, hypotheses registered in advance.",
        needs:
          "Prometheus, the three services and two sample apps running for real, plus the fault injection scenario of §13.4.",
      },
      E6: {
        title: "False rollback rate",
        proves:
          "The anti false-rollback mechanism: 20 transient error spikes with maxConsecutiveBreaches = 1 and = 2.",
        needs: "The same infrastructure as E5.",
      },
      E7: {
        title: "Consistent hashing distribution",
        proves:
          "Users are split in the intended proportions: 1,000,000 user IDs through the real evaluation path, chi-square test.",
      },
      E8: {
        title: "Capability validator against an oracle",
        proves:
          "The validator misses no invalid combination: differential testing against an independent oracle, then mutation testing.",
      },
      E9: {
        title: "UDP resource usage",
        proves:
          "Operational feasibility: CPU and RAM of the three services when idle and with 1,000 SDK connections.",
        needs:
          "The nightly CI lane on a kind cluster records it; the file becomes official when committed to raw/.",
      },
      E10: {
        title: "DORA from the Event Store",
        proves:
          "The five DORA metrics of development on the platform itself, computed live from deployment events, available even without outside users.",
      },
      E11: {
        title: "Developer Experience (SUS)",
        proves:
          "The standard 10-item SUS scale, 10 to 15 students on the same set of tasks.",
        needs: "A group of real users willing to try it.",
      },
      E12: {
        title: "Time on task",
        proves:
          "Timing each task, compared with building the same stack by hand.",
        needs: "The same users as E11.",
      },
      E13: {
        title: "Completion rate and usage errors",
        proves: "Direct observation, noting where people get stuck.",
        needs: "The same users as E11.",
      },
      E14: {
        title: "Cardinality cost of the ff label",
        proves:
          "Labelling by flag branch only ADDS series, it does not multiply them: measured counts match the predicted formula.",
      },
      E15: {
        title: "Crash matrix against Terraform and Pulumi",
        proves:
          "The main C3 evidence: kill the process at every point of the K1–K10 grid, count duplicate and orphaned resources and manual fixes.",
        needs: "LocalStack, and the EKS cells on real AWS.",
      },
      E16: {
        title: "Drift matrix against Helm and Argo CD",
        proves:
          "Detect but never auto-fix: five kinds of out-of-band changes, detection delay, and whether the diff points at the exact change.",
        needs: "A real cluster with Helm and Argo CD on the same tools.",
      },
      I34: {
        title: "I34 · Five-minute database outage under traffic",
        proves:
          "Service 2 keeps serving the last configuration without wrong evaluations when the database is gone, and converges once it is back.",
      },
      "portal-pagination": {
        title: "Portal flag list",
        proves:
          "One list page (200 flags × 3 environments) answers within 500 ms. The current figure does NOT meet it, and is shown as measured.",
      },
      "kyverno-crd": {
        title: "Admission policy valid against the real CRD",
        proves:
          "The image-signature policy UDP generates passes a validator built from Kyverno 1.19.1's own CRD, plus a reverse check: a wrong policy is rejected.",
      },
      "chart-values": {
        title: "Adapter values keys against the real chart",
        proves:
          "Whether the keys an adapter sets in a chart's values exist in that chart. Helm ignores unknown keys silently, so a mismatched key is configuration with no effect.",
      },
    },
    charts: {
      e1: {
        batches: "Files changed per tool batch",
        inside: "Inside the adapter folder",
        outside: "Outside the adapter folder",
        breaks: "interface breaks",
        relaxations: "contract test relaxations",
        tools: "tools added after the tag",
        perTool: "files outside adapters per tool",
        batch: "Batch",
      },
      e3: {
        title: "Evaluation latency per grid cell",
        sdkP50: "SDK p50",
        sdkP99: "SDK p99",
        coreP50: "Core p50",
        coreP99: "Core p99",
        cell: "Grid cell",
        cellLabel: (flags: number, rules: number) =>
          `${count(flags, "flag", "flags")} · ${count(rules, "rule", "rules")}`,
        remote: (p50: string, p99: string) =>
          `Remote baseline (OFREP): p50 ${p50}, p99 ${p99}.`,
      },
      e4: {
        latency: "Propagation delay p50",
        bytes: "Bytes per change (server side)",
        flags: "Flags",
        flagsLabel: (n: number) => count(n, "flag", "flags"),
        mode: (mode: string, notify: boolean) =>
          `${mode} · ${notify ? "NOTIFY" : "poll"}`,
      },
      e7: {
        title: "χ² against the critical value (α = 0.001)",
        chi2: "χ²",
        critical: "Critical value",
        scenario: "Scenario",
        shares: "Observed versus intended share",
        observed: "Observed",
        expected: "Intended",
        variant: "Variant",
      },
      e8: {
        title: "The validator's 17 mutants",
        byDifferential: "Killed by differential testing",
        bySuiteOnly: "Killed by the test suite only",
        survived: "Survived",
        oracle: "Error codes produced by the oracle",
      },
      e10: {
        window: "Window",
        days: (n: number) => count(n, "day", "days"),
        daily: "Deployments to production per day",
        success: "Succeeded",
        failure: "Failed",
        table: "DORA per project (production environment)",
        project: "Project",
        deployments: "Deployments",
        frequency: "Per day",
        leadTime: "Lead time (median)",
        failureRate: "Change failure rate",
        recovery: "Recovery (median)",
        none: "No project deployed to production in this window.",
        idle: (n: number) =>
          `${count(n, "project has", "projects have")} a production environment but no deployment in the window.`,
      },
      e14: {
        title: "Series count per (T, V)",
        predicted: "Predicted",
        complete: "Measured, all combinations",
        realistic: "Measured, realistic traffic",
        cell: "Grid cell",
        formula: (f: string) => `Formula: ${f}`,
      },
      i34: {
        title: "Convergence after reconnecting",
        converged: "Converged after",
        limit: "Limit",
        phase: "Phase",
        wrong: (n: number, total: number) =>
          `${formatNumber(n)} wrong or failed evaluations out of ${formatNumber(total)} during the outage`,
      },
      flagList: {
        title: "Response time per call",
        page: "One page",
        count: "Count only",
        full: "Full list",
        threshold: "500 ms threshold",
        route: "Call",
      },
    },
    unit: {
      us: (v: string) => `${v} µs`,
      ms: (v: string) => `${v} ms`,
      s: (v: string) => `${v} s`,
      bytes: (v: string) => `${v} B`,
      perDay: (v: string) => `${v}/day`,
    },
    csvName: (id: string, chart: string) => `${id}-${chart}.csv`,
    rich: {
      ofTotal: (value: ReactNode, total: number) => (
        <>
          {value}/{formatNumber(total)}
        </>
      ),
    },
  },
});
