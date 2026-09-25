import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw";
import { useAuthStore } from "../src/features/auth/auth-store";
import { useToasts } from "../src/components/Toast";
import { usePaletteStore } from "../src/features/project/CommandPalette";

/**
 * `onUnhandledRequest: "error"`: một request mà không handler nào khai là một request
 * test không biết tới — để nó trôi qua im lặng là để test xanh trên một đường không ai
 * kiểm.
 */
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  useAuthStore.setState({ user: null, isInitializing: false });
  useToasts.setState({ items: [] });
  usePaletteStore.setState({ open: false });
  document.cookie = "udp_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  localStorage.clear();
});
afterAll(() => server.close());
