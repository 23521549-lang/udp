/** Điều kiện có thể async: ca `reportStats` chờ hàng xuất hiện trong database */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("hết giờ chờ điều kiện");
    await new Promise((r) => setTimeout(r, 5));
  }
}
