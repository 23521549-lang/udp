import {
  identityCloudOf,
  registryPushOf,
  type BuildPlan,
  type BuildTest,
} from "@udp/adapter-core";
import { BUILD_PLATFORM, TEST_IMAGES } from "@udp/config";
import { ConflictError } from "@udp/http";
import {
  BUILD_LANGUAGES,
  buildSettingsSchema,
  DEFAULT_BUILD_SETTINGS,
  type BuildLanguage,
  type BuildSettings,
} from "@udp/shared-types";

/**
 * [Plan #61 QĐ-3, QĐ-9] Dựng kế hoạch build của một project — chỗ DUY NHẤT Service 1 quyết định build thế nào; sáu
 * CI/CD adapter chỉ vẽ kết quả, Portal hiện lại đúng các quyết định này.
 */

/**
 * Lệnh test mặc định — CHỈ cho ngôn ngữ có một lệnh không mơ hồ. Ruby (RSpec hay Minitest), PHP (PHPUnit, Pest…), web
 * tĩnh, Rust và ngôn ngữ khác: người dùng khai lệnh hay tắt bước test một cách tường minh. Image ghim digest ở
 * `TEST_IMAGES` (QĐ-8).
 */
export const DEFAULT_TEST_COMMANDS: Readonly<
  Partial<Record<BuildLanguage, string>>
> = {
  nodejs: "npm ci && npm test",
  python: "pip install -r requirements-dev.txt && pytest -q",
  go: "go test ./...",
  "java-maven": "mvn -B test",
  "java-gradle": "gradle test --no-daemon",
  dotnet: "dotnet test",
};

const testImageOf = (language: BuildLanguage): string | undefined =>
  (TEST_IMAGES as Partial<Record<BuildLanguage, string>>)[language];

/** Bước test mặc định của một ngôn ngữ: chạy lệnh, hay thiếu lệnh ⇒ pipeline dừng với lời nhắn */
export function defaultTestOf(language: BuildLanguage): BuildTest {
  const command = DEFAULT_TEST_COMMANDS[language];
  const image = testImageOf(language);
  return command !== undefined && image !== undefined
    ? { kind: "run", command, image }
    : { kind: "missing", language };
}

const isBuildLanguage = (value: unknown): value is BuildLanguage =>
  typeof value === "string" &&
  (BUILD_LANGUAGES as readonly string[]).includes(value);

/** Cài đặt đã lưu ⇒ cài đặt đủ mặc định; hàng hỏng (sửa tay database) ⇒ mặc định, không vỡ pipeline */
export function settingsOf(stored: unknown): BuildSettings {
  if (stored === null || stored === undefined) return DEFAULT_BUILD_SETTINGS;
  const parsed = buildSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_BUILD_SETTINGS;
}

export type LanguageSource = "settings" | "scan" | "runtime";

/** Ngôn ngữ của bước test: cài đặt thắng, rồi lần quét repo, rồi runtime của project (Golden Path) */
export function languageOf(input: {
  settings: BuildSettings;
  scannedLanguage: unknown;
  languageRuntime: string;
}): { value: BuildLanguage; source: LanguageSource } {
  if (input.settings.language !== null) {
    return { value: input.settings.language, source: "settings" };
  }
  if (isBuildLanguage(input.scannedLanguage)) {
    return { value: input.scannedLanguage, source: "scan" };
  }
  return {
    value: isBuildLanguage(input.languageRuntime)
      ? input.languageRuntime
      : "other",
    source: "runtime",
  };
}

export interface BuildPlanInput {
  languageRuntime: string;
  /** Binding `registry.oci` của project (thuộc tính `pushAuth` do adapter registry khai) */
  registry:
    | {
        endpoint?: string | null;
        attributes?: Record<string, string> | null;
      }
    | undefined;
  /** `projects.build_settings` — NULL = mặc định */
  settings?: unknown;
  /** `projects.repo_scan.language` của lần quét gần nhất */
  scannedLanguage?: unknown;
}

/**
 * Kế hoạch build. Registry chưa khai cách đẩy (binding dựng trước Plan #61) ⇒ 409: áp lại domain Container Registry để
 * binding mới ghi đè. Danh tính đã lưu cho MỘT cloud khác cloud của registry hiện tại (đổi registry sau khi chạy script)
 * thì không dùng — bước đăng nhập báo thiếu danh tính thay vì đẩy nhầm chỗ.
 */
export function buildPlanOf(input: BuildPlanInput): BuildPlan {
  const push = registryPushOf(
    input.registry?.endpoint == null
      ? undefined
      : {
          endpoint: input.registry.endpoint,
          attributes: input.registry.attributes ?? {},
        },
  );
  if (push === null) {
    throw new ConflictError(
      "Registry chưa khai cách đẩy image — áp lại domain Container Registry để cập nhật",
    );
  }
  const settings = settingsOf(input.settings);
  const language = languageOf({
    settings,
    scannedLanguage: input.scannedLanguage,
    languageRuntime: input.languageRuntime,
  }).value;
  const wanted = identityCloudOf(push.kind);
  const identity =
    settings.identity !== null && settings.identity.cloud === wanted
      ? settings.identity
      : null;
  return {
    strategy: settings.strategy,
    context: settings.context,
    dockerfile: settings.dockerfile,
    platform: BUILD_PLATFORM,
    push,
    identity,
    test: buildTestOf(settings, language),
  };
}

/** Bước test theo cài đặt: mặc định của ngôn ngữ, lệnh tự khai, hay tắt tường minh */
export function buildTestOf(
  settings: BuildSettings,
  language: BuildLanguage,
): BuildTest {
  switch (settings.test.mode) {
    case "default":
      return defaultTestOf(language);
    case "custom":
      return {
        kind: "run",
        command: settings.test.command,
        image: settings.test.image,
      };
    case "none":
      return { kind: "skip" };
  }
}
