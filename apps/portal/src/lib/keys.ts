/**
 * Nhãn phím tắt theo hệ điều hành: "⌘ K" trên máy Apple, "Ctrl K" ở nơi khác — cùng một tổ hợp
 * mà mã nghe (`metaKey || ctrlKey`). Khoảng trắng là khoảng trắng không ngắt: nhãn không bao giờ
 * gãy đôi giữa phím bổ trợ và phím chính.
 */
export function isApplePlatform(): boolean {
  try {
    return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  } catch {
    return false;
  }
}

export function shortcut(key: string): string {
  return `${isApplePlatform() ? "⌘" : "Ctrl"} ${key}`;
}
