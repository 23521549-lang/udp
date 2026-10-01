/**
 * Người đang xem bản xem thử và tình huống của nền tảng — chọn ở dải "Bản xem thử" góc màn hình, nhớ trong
 * `sessionStorage` của tab, đổi là tải lại trang với dữ liệu mẫu từ đầu. Tệp riêng, không phụ thuộc gì, để cổng
 * Playwright đặt được khoá trước khi trang chạy mà không nạp dữ liệu mẫu.
 */

/**
 * Quản trị viên nền tảng (mặc định), developer thường ở vài project, người mới chưa có project hay nhóm nào, và
 * [Plan #59] khách chưa đăng nhập: thấy trang giới thiệu, đăng ký xong thành người mới.
 */
export const PERSONAS = ["admin", "developer", "newcomer", "visitor"] as const;
export type PersonaId = (typeof PERSONAS)[number];

/** Cụm chạy UDP khoẻ, hay đang có rủi ro (máy rảnh dễ bị thu hồi, sao lưu hỏng, chứng chỉ sắp hết hạn) */
export const PLATFORM_SCENARIOS = ["healthy", "at-risk"] as const;
export type PlatformScenario = (typeof PLATFORM_SCENARIOS)[number];

export const PERSONA_KEY = "udp_demo_persona";
export const PLATFORM_KEY = "udp_demo_platform";

export interface DemoSetup {
  persona: PersonaId;
  platform: PlatformScenario;
}

export const DEFAULT_SETUP: DemoSetup = {
  persona: "admin",
  platform: "healthy",
};

function stored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    // storage bị chặn: dùng mặc định
    return null;
  }
}

/** Lựa chọn đã nhớ của tab này; giá trị lạ hay thiếu là mặc định */
export function storedSetup(): DemoSetup {
  const persona = stored(PERSONA_KEY);
  const platform = stored(PLATFORM_KEY);
  return {
    persona: PERSONAS.find((p) => p === persona) ?? DEFAULT_SETUP.persona,
    platform:
      PLATFORM_SCENARIOS.find((s) => s === platform) ?? DEFAULT_SETUP.platform,
  };
}

export function storeSetup(setup: DemoSetup): void {
  try {
    sessionStorage.setItem(PERSONA_KEY, setup.persona);
    sessionStorage.setItem(PLATFORM_KEY, setup.platform);
  } catch {
    // storage bị chặn: lựa chọn chỉ sống tới lần tải lại
  }
}

/**
 * [Plan #59] Mở thẳng một vai bằng địa chỉ (`?as=visitor#/`): gửi link cho người xem là thấy ngay trang giới thiệu,
 * không phải tìm dải Bản xem thử. Nhớ vai như khi chọn ở dải, rồi bỏ tham số khỏi thanh địa chỉ.
 */
export function adoptSetupFromUrl(): void {
  const url = new URL(window.location.href);
  const persona = PERSONAS.find((p) => p === url.searchParams.get("as"));
  if (persona === undefined) return;
  storeSetup({ ...storedSetup(), persona });
  url.searchParams.delete("as");
  window.history.replaceState(null, "", url);
}
