/**
 * `@udp/golden-path` (§11) — mẫu dự án chạy được, bộ sinh cây tệp của Create New Service và bộ quét
 * của Import Existing Repo. Thuần: I/O duy nhất là đọc cây template của chính gói; nguồn repo do nơi
 * gọi đưa vào (`RepoSource`).
 */
export {
  APP_TOKEN,
  GOLDEN_PATH_RUNTIMES,
  goldenPathFiles,
  isGoldenPathRuntime,
  PROVIDER_PUBLIC_NAME,
  PROVIDER_RELEASE,
  REGISTRY_TOKEN,
  type GoldenPathFile,
  type GoldenPathInput,
  type GoldenPathRuntime,
} from "./render.js";
export {
  SCAN_LIMITS,
  scanRepository,
  type FindingId,
  type FindingStatus,
  type RepoScan,
  type RepoSource,
  type ScanContext,
  type ScanFinding,
  type ScanSuggestion,
} from "./scan.js";
