import { assertBuildPlanSafe, type BuildPlan } from "@udp/adapter-core";
import { BUILD_TOOLCHAIN } from "@udp/config";
import {
  AUTH_DIR,
  digestFromReport,
  dockerHostLoginLines,
  inClusterLoginContainers,
  packDownloadLines,
  strategyLines,
  WORK_DIR,
  type BuildContainer,
  type DockerHostCi,
  type InClusterCi,
} from "./build-script.js";

/**
 * [Plan #61 QĐ-13] Rebase theo lịch: thay lớp hệ điều hành (run image của Buildpacks) dưới image của commit đầu `main`
 * mà không build lại — bản vá của image nền tới production trong một ngày, không phải chờ lần push sau.
 *
 * Cùng luật ký tự với `build-script.ts`. Chỉ image Buildpacks rebase được: lượt theo lịch chọn chiến lược ĐÚNG như lượt
 * build của commit đó; ra Dockerfile thì dừng xanh kèm lời nhắn. Rebase tại chỗ: tag `<commit>` dời sang digest mới,
 * digest cũ vẫn kéo được (deploy cũ và rollback không gãy). Hỏng ⇒ job đỏ và KHÔNG báo UDP — không phải một lần deploy
 * hỏng. Thành công ⇒ CI báo UDP với `UDP_KIND=rebase`; UDP quyết có deploy không (chỉ khi production đang chạy đúng
 * commit này với digest khác).
 */

const SKIP_MESSAGE =
  'echo "Image dung bang Dockerfile: rebase chi ap cho image Buildpacks. Cap nhat FROM roi build lai de lay ban va cua image nen"';

/** Dòng chặn đứng ĐẦU mọi container sau bước chuẩn bị: lượt này không phải Buildpacks ⇒ không làm gì */
const ONLY_BUILDPACKS = `[ "$(cat ${WORK_DIR}/strategy)" = buildpacks ] || exit 0`;

/** Máy có Docker: đặt `UDP_IMAGE_REF="<image>:<commit>@<digest mới>"`; không phải Buildpacks ⇒ `exit 0` trước khi báo */
export function dockerHostRebaseLines(
  plan: BuildPlan,
  ci: DockerHostCi,
  vars: { image: string; commit: string; tmp: string },
): string[] {
  assertBuildPlanSafe(plan);
  const tag = `${vars.image}:${vars.commit}`;
  return [
    "set -eu",
    `UDP_TMP="${vars.tmp}"`,
    'mkdir -p "$UDP_TMP"',
    ...strategyLines(plan),
    `if [ "$UDP_STRATEGY" != buildpacks ]; then ${SKIP_MESSAGE}; exit 0; fi`,
    ...dockerHostLoginLines(plan, ci),
    ...packDownloadLines(),
    // `--publish`: đọc và ghi thẳng registry, không cần Docker daemon; run image lấy theo metadata của image
    `"$UDP_TMP/pack" rebase "${tag}" --publish --report-output-dir "$UDP_TMP/report"`,
    `UDP_DIGEST=$(${digestFromReport('"$UDP_TMP/report/report.toml"')})`,
    '[ -n "$UDP_DIGEST" ] || { echo "Khong doc duoc digest cua image vua rebase"; exit 1; }',
    `UDP_IMAGE_REF="${tag}@$UDP_DIGEST"`,
    'echo "UDP rebase: $UDP_IMAGE_REF"',
  ];
}

/**
 * Trong cluster: chuẩn bị → (xin token → đăng nhập) → rebase → digest. Container sau bước chuẩn bị tự dừng xanh khi
 * lượt này không phải Buildpacks; bước digest ghi `/udp/out/image-ref` CHỈ khi đã rebase — bước báo UDP thấy thiếu tệp
 * thì không báo. Container rebase cùng image và biến với container build Buildpacks: Jenkins chạy nó ngay trong
 * container đó, pod không thêm container nào.
 */
export function inClusterRebaseContainers(
  plan: BuildPlan,
  ci: InClusterCi,
  vars: { image: string; commit: string },
): BuildContainer[] {
  assertBuildPlanSafe(plan);
  const images = BUILD_TOOLCHAIN.images;
  const user = BUILD_TOOLCHAIN.builderUser;
  const tag = `${vars.image}:${vars.commit}`;
  const base = { runAsUser: null, unconfined: false, env: {}, secretEnv: [] };

  const prepare: BuildContainer = {
    ...base,
    name: "udp-prepare",
    image: images.alpine,
    runAsUser: 0,
    script: [
      "set -eu",
      `mkdir -p ${WORK_DIR}/out`,
      `chmod 0777 ${WORK_DIR}/out`,
      ...strategyLines(plan),
      `echo "$UDP_STRATEGY" > ${WORK_DIR}/strategy`,
      `[ "$UDP_STRATEGY" = buildpacks ] || ${SKIP_MESSAGE}`,
    ],
  };

  // Dòng chặn đứng ĐẦU kịch bản đăng nhập: lượt không phải Buildpacks thì không đăng nhập (kể cả khi thiếu danh tính)
  const guarded = (c: BuildContainer): BuildContainer => ({
    ...c,
    script: [ONLY_BUILDPACKS, ...c.script],
  });

  const rebase: BuildContainer = {
    ...base,
    name: "udp-rebase",
    image: images.builder,
    env: {
      CNB_PLATFORM_API: BUILD_TOOLCHAIN.cnbPlatformApi,
      DOCKER_CONFIG: AUTH_DIR,
    },
    script: [
      ONLY_BUILDPACKS,
      "set -eu",
      // Như `creator`: đọc thông tin đăng nhập bằng root rồi tự hạ quyền xuống UID của builder
      [
        "/cnb/lifecycle/rebaser",
        `-uid=${String(user.uid)}`,
        `-gid=${String(user.gid)}`,
        `-report=${WORK_DIR}/out/report.toml`,
        `"${tag}"`,
      ].join(" "),
    ],
  };

  const digest: BuildContainer = {
    ...base,
    name: "udp-digest",
    image: images.alpine,
    script: [
      ONLY_BUILDPACKS,
      "set -eu",
      `UDP_DIGEST=$(${digestFromReport(`${WORK_DIR}/out/report.toml`)})`,
      '[ -n "$UDP_DIGEST" ] || { echo "Khong doc duoc digest cua image vua rebase"; exit 1; }',
      `echo "${tag}@$UDP_DIGEST" > ${WORK_DIR}/out/image-ref`,
      `echo "UDP rebase: $(cat ${WORK_DIR}/out/image-ref)"`,
    ],
  };

  return [
    prepare,
    ...inClusterLoginContainers(plan, ci).map(guarded),
    rebase,
    digest,
  ];
}
