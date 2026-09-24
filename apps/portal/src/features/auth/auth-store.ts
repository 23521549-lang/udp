import type { PublicUserWire } from "@udp/shared-types/wire";
import { create } from "zustand";

/**
 * Trạng thái đăng nhập (§10.4). **Không** middleware persist: dữ liệu người dùng và token
 * không bao giờ nằm ở localStorage — nguồn sự thật là cookie httpOnly và `GET /auth/me`.
 */
interface AuthState {
  user: PublicUserWire | null;
  /** `true` cho tới khi `GET /auth/me` đầu tiên trả lời — guard không quyết gì trước đó */
  isInitializing: boolean;
  setUser: (user: PublicUserWire) => void;
  clearUser: () => void;
  setInitializing: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  isInitializing: true,
  setUser: (user) => set({ user }),
  clearUser: () => set({ user: null }),
  setInitializing: (value) => set({ isInitializing: value }),
}));
