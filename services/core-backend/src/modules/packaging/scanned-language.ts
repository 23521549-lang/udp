/** Ngôn ngữ mà lần quét repo gần nhất ghi (`projects.repo_scan.language`, Plan #61) — hàng cũ không có trường ⇒ `null` */
export function scannedLanguageOf(repoScan: unknown): unknown {
  return typeof repoScan === "object" && repoScan !== null
    ? ((repoScan as Record<string, unknown>).language ?? null)
    : null;
}
