import {
  registryPushOf,
  type BuildPlan,
  type BuildTest,
} from "@udp/adapter-core";
import { BUILD_PLATFORM, TEST_IMAGES } from "@udp/config";
import { ConflictError } from "@udp/http";

/**
 * [Plan #61 QĐ-3, QĐ-9] Dựng kế hoạch build của một project — chỗ DUY NHẤT Service 1 quyết định build thế nào; sáu
 * CI/CD adapter chỉ vẽ kết quả.
 */

export const BUILD_LANGUAGES = [
  "nodejs",
  "python",
  "go",
  "java-maven",
  "java-gradle",
  "dotnet",
  "ruby",
  "php",
  "static",
  "other",
] as const;
export type BuildLanguage = (typeof BUILD_LANGUAGES)[number];

/**
 * Lệnh test mặc định — CHỈ cho ngôn ngữ có một lệnh không mơ hồ. Ruby (RSpec hay Minitest), PHP (PHPUnit, Pest…), web
 * tĩnh và ngôn ngữ khác: người dùng khai lệnh hay tắt bước test một cách tường minh. Image ghim digest ở
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

/** `Project.languageRuntime` (Golden Path chỉ nodejs/python) ⇒ ngôn ngữ của bước build */
export const languageOfRuntime = (runtime: string): BuildLanguage =>
  (BUILD_LANGUAGES as readonly string[]).includes(runtime)
    ? (runtime as BuildLanguage)
    : "other";

export interface BuildPlanInput {
  languageRuntime: string;
  /** Binding `registry.oci` của project (thuộc tính `pushAuth` do adapter registry khai) */
  registry:
    | {
        endpoint?: string | null;
        attributes?: Record<string, string> | null;
      }
    | undefined;
}

/**
 * Kế hoạch mặc định: chiến lược `auto` ở gốc repo, test theo ngôn ngữ của project, chưa có danh tính build. Registry
 * chưa khai cách đẩy (binding dựng trước Plan #61) ⇒ 409: áp lại domain Container Registry để binding mới ghi đè.
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
  return {
    strategy: "auto",
    context: ".",
    dockerfile: "Dockerfile",
    platform: BUILD_PLATFORM,
    push,
    identity: null,
    test: defaultTestOf(languageOfRuntime(input.languageRuntime)),
  };
}
