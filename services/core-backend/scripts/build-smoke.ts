import type { BuildPlan } from "@udp/adapter-core";
import { BUILD_PLATFORM } from "@udp/config/build-toolchain";
import { dockerHostBuildLines } from "../src/modules/adapter-base/packaging/build-script.js";

/**
 * [Plan #61] Job CI `build-smoke`: in ra ĐÚNG đoạn shell build-và-đẩy mà pipeline GitHub Actions của UDP chạy (chiến
 * lược `auto`, đẩy GHCR bằng `GITHUB_TOKEN`), thêm một dòng ghi ảnh có digest ra `$RUNNER_TEMP/image-ref`.
 *
 *   tsx scripts/build-smoke.ts ghcr.io/<owner>/udp-build-smoke > "$RUNNER_TEMP/build.sh"
 */
const image = process.argv[2];
if (image === undefined || !/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+$/.test(image)) {
  throw new Error("cần đối số ghcr.io/<owner>/<tên> (chữ thường)");
}
const plan: BuildPlan = {
  strategy: "auto",
  context: ".",
  dockerfile: "Dockerfile",
  platform: BUILD_PLATFORM,
  push: { kind: "github-token", server: "ghcr.io" },
  identity: null,
  test: { kind: "skip" },
};
const lines = dockerHostBuildLines(plan, "github-actions", {
  image,
  commit: "$UDP_SMOKE_TAG",
  tmp: "$RUNNER_TEMP/udp-build",
});
process.stdout.write(
  [...lines, 'echo "$UDP_IMAGE_REF" > "$RUNNER_TEMP/image-ref"', ""].join("\n"),
);
