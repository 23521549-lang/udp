export async function waitFor(
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("hết giờ chờ điều kiện");
    await new Promise((r) => setTimeout(r, 5));
  }
}
