import type { RepoScanWire } from "@udp/shared-types/wire";
import { count, defineMessages } from "../../i18n";

type Finding = RepoScanWire["findings"][number];

/** Chữ của trang Mã nguồn (Golden Path, quét repo) và thẻ "Sẵn sàng cho flag-level rollout" ở Tổng quan */
const vi = {
  title: "Mã nguồn",
  leadCreate:
    "Golden Path: dự án mẫu đã tích hợp sẵn provider, middleware đo và pipeline của UDP.",
  leadImport:
    "Quét repo có sẵn để biết còn thiếu gì trước khi dùng rollout mức flag.",
  needDeveloper: "Cần quyền Lập trình viên",
  needDeveloperHint:
    "Golden Path là mã để đưa vào repo, nên chỉ Lập trình viên trở lên xem được.",
  fileCount: (n: number) => `${String(n)} tệp`,
  downloadZip: "Tải .zip",
  files: "Tệp của Golden Path",
  contentOf: (path: string) => `Nội dung ${path}`,
  copyOf: (path: string) => `Sao chép ${path}`,
  status: {
    ok: "Đã có",
    missing: "Còn thiếu",
    unknown: "Chưa xác định",
  } satisfies Record<Finding["status"], string>,
  finding: {
    runtime: "Ngôn ngữ",
    dockerfile: "Dockerfile",
    "metrics-endpoint": "Endpoint /metrics",
    openfeature: "OpenFeature SDK",
    "udp-provider": "Provider của UDP",
    "udp-middleware": "Middleware đo của UDP",
    "service-version": "service.version trong manifest",
    pipeline: "Pipeline báo deploy về UDP",
  } satisfies Record<Finding["id"], string>,
  token: "Token đọc repo (tuỳ chọn, cho repo riêng tư)",
  tokenPlaceholder: "Token cho repo riêng tư (tuỳ chọn)…",
  scanning: "Đang quét…",
  scan: "Quét repo",
  neverScanned: "Chưa quét repo lần nào",
  neverScannedHint:
    "Bấm Quét repo: UDP đọc repo qua API công khai của GitHub/GitLab và chỉ đưa ra đề xuất.",
  askDeveloper: "Nhờ Lập trình viên của project quét repo.",
  detected: "Nhận diện",
  unknownRuntime: "Không rõ ngôn ngữ",
  scanMeta: (cicdTool: string | null, at: string) =>
    `CI/CD: ${cicdTool ?? "không thấy"} · quét lúc ${at}`,
  truncated:
    'Repo lớn hơn trần đọc của một lượt quét: mục "Chưa xác định" có thể đã có mà UDP không đọc tới.',
  results: "Kết quả quét",
  suggestion: (text: string) => `Đề xuất: ${text}`,
  toggleFile: (open: boolean, path: string) => `${open ? "Ẩn" : "Xem"} ${path}`,
  templateOf: (path: string) => `Mẫu ${path}`,
  readiness: "Sẵn sàng cho flag-level rollout",
  ready: "Sẵn sàng",
  notReady: "Chưa sẵn sàng",
  missing: (title: string) => `Thiếu: ${title}`,
  viewCodePage: "xem trang Mã nguồn",
  notScanned: "Chưa quét repo: chưa biết ứng dụng đã tích hợp UDP chưa.",
};

export const codeMessages = defineMessages({
  vi,
  en: {
    title: "Source code",
    leadCreate:
      "Golden Path: a starter project with UDP's provider, metrics middleware and pipeline built in.",
    leadImport:
      "Scan the existing repo to see what is missing before using flag-level rollouts.",
    needDeveloper: "Developer role required",
    needDeveloperHint:
      "Golden Path is code to put in the repo, so only Developers and above can view it.",
    fileCount: (n: number) => count(n, "file", "files"),
    downloadZip: "Download .zip",
    files: "Golden Path files",
    contentOf: (path: string) => `Contents of ${path}`,
    copyOf: (path: string) => `Copy ${path}`,
    status: {
      ok: "Present",
      missing: "Missing",
      unknown: "Unknown",
    },
    finding: {
      runtime: "Language",
      dockerfile: "Dockerfile",
      "metrics-endpoint": "/metrics endpoint",
      openfeature: "OpenFeature SDK",
      "udp-provider": "UDP provider",
      "udp-middleware": "UDP metrics middleware",
      "service-version": "service.version in the manifest",
      pipeline: "Pipeline reporting deployments to UDP",
    },
    token: "Repo read token (optional, for private repos)",
    tokenPlaceholder: "Token for a private repo (optional)…",
    scanning: "Scanning…",
    scan: "Scan repo",
    neverScanned: "The repo has not been scanned yet",
    neverScannedHint:
      "Click Scan repo: UDP reads the repo through the public GitHub/GitLab API and only makes suggestions.",
    askDeveloper: "Ask a Developer on the project to scan the repo.",
    detected: "Detected",
    unknownRuntime: "Unknown language",
    scanMeta: (cicdTool: string | null, at: string) =>
      `CI/CD: ${cicdTool ?? "not found"} · scanned ${at}`,
    truncated:
      'The repo is larger than one scan can read: items marked "Unknown" may exist beyond what UDP reached.',
    results: "Scan results",
    suggestion: (text: string) => `Suggestion: ${text}`,
    toggleFile: (open: boolean, path: string) =>
      `${open ? "Hide" : "View"} ${path}`,
    templateOf: (path: string) => `Template ${path}`,
    readiness: "Ready for flag-level rollout",
    ready: "Ready",
    notReady: "Not ready",
    missing: (title: string) => `Missing: ${title}`,
    viewCodePage: "view the Source code page",
    notScanned:
      "Repo not scanned yet: it is not known whether the app integrates UDP.",
  },
});
