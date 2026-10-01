import { expect, type Page } from "@playwright/test";

/**
 * Id của dữ liệu mẫu mà cổng chụp màn (`screens.pw.ts`) và script chụp ảnh trang giới thiệu (`landing-shots.pw.ts`,
 * Plan #59) cùng cần. Hỏi thẳng lớp giả lập trong trang: id tất định nhưng sinh ra, không viết tay.
 */
export interface Ids {
  checkout: string;
  marketing: string;
  rollout: string;
  /** Project nháp: các bước của wizard mở lại được từ URL (`?project=&step=`) */
  draft: string;
  /** [Plan #55] Nhóm mà người xem là chủ nhóm — đủ form mời, lời mời đang chờ, cài đặt nhóm */
  team: string;
  /** [Plan #58] Rollout vừa vượt ngưỡng lần 1/3 (dải cảnh báo cam) */
  rolloutBreach: string;
  /** [Plan #58] Project nháp mới có SDK key ở dev: thẻ "Bắt đầu" 1/5, env staging chưa có key */
  voucher: string;
  voucherStaging: string;
  /** [Plan #58] Project chạy mà chưa có rollout, flag, segment hay SDK key nào */
  shipping: string;
}

/** Mở trang chủ của vai đang xem rồi hỏi lớp giả lập id của các project, rollout và nhóm mẫu */
export async function discover(page: Page): Promise<Ids> {
  await page.goto("./#/app/home");
  await expect(page.locator("h1")).toHaveCount(1);
  return page.evaluate(async () => {
    const get = async <T>(path: string): Promise<T> =>
      (await (await fetch(`/api/v1${path}`)).json()) as T;
    const { projects } = await get<{
      projects: { id: string; name: string }[];
    }>("/projects?limit=50");
    const id = (name: string): string => {
      const found = projects.find((p) => p.name === name);
      if (found === undefined) throw new Error(`thiếu project ${name}`);
      return found.id;
    };
    const checkout = id("checkout-service");
    const { rollouts } = await get<{
      rollouts: { id: string; status: string; flagKey: string | null }[];
    }>(`/projects/${checkout}/rollouts`);
    const live = rollouts.find((r) => r.status === "IN_PROGRESS");
    if (live === undefined) throw new Error("thiếu rollout đang chạy");
    const breach = rollouts.find((r) => r.flagKey === "one-click-reorder");
    if (breach === undefined) throw new Error("thiếu rollout vượt ngưỡng");
    const { teams } = await get<{ teams: { id: string; name: string }[] }>(
      "/teams",
    );
    const team = teams.find((t) => t.name === "Nhóm thanh toán");
    if (team === undefined) throw new Error("thiếu nhóm Nhóm thanh toán");
    const voucher = id("voucher-service");
    const { environments } = await get<{
      environments: { id: string; name: string }[];
    }>(`/projects/${voucher}`);
    const staging = environments.find((e) => e.name === "staging");
    if (staging === undefined) throw new Error("thiếu staging");
    return {
      checkout,
      marketing: id("marketing-site"),
      rollout: live.id,
      draft: id("analytics-api"),
      team: team.id,
      rolloutBreach: breach.id,
      voucher,
      voucherStaging: staging.id,
      shipping: id("shipping-fee-api"),
    };
  });
}
