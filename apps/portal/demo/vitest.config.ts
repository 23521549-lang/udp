import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Kiểm hợp đồng của bản xem thử (`demo/contract.check.ts`) — tách khỏi bộ test của Portal */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, ".."),
  test: {
    environment: "jsdom",
    include: ["demo/**/*.check.ts"],
    testTimeout: 60_000,
  },
});
