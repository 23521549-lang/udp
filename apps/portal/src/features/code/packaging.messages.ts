import type { BuildLanguage } from "@udp/shared-types/build";
import type { BuildViewWire } from "@udp/shared-types/wire";
import { defineMessages } from "../../i18n";

type Cloud = "aws" | "gcp" | "azure";
type Push = NonNullable<BuildViewWire["registry"]>["push"];
type Reason = BuildViewWire["prediction"]["reason"];
type Strategy = BuildViewWire["settings"]["strategy"];
type Source = BuildViewWire["language"]["source"];
type SigningBlocked = NonNullable<BuildViewWire["signing"]["reason"]>;

/** Câu chỉ cách đặt lịch rebase của một CI: biểu thức cron và giờ `HH:MM` (UTC) */
export type RebaseHow = (cron: string, time: string) => string;

/** [Plan #61] Chữ của mục Đóng gói (trang Mã nguồn) — mọi quyết định của máy chủ đến bằng MÃ, câu viết ở đây */
const vi = {
  title: "Đóng gói container",
  lead: "UDP build image của ứng dụng ngay trong CI của bạn: repo có Dockerfile thì dùng Dockerfile, không thì Buildpacks tự nhận ngôn ngữ.",
  builtWith: "Build bằng",
  predicted: {
    dockerfile: "Dockerfile (BuildKit)",
    buildpacks: "Buildpacks (Paketo)",
    unknown: "Chưa biết",
  } satisfies Record<BuildViewWire["prediction"]["strategy"], string>,
  reason: {
    PINNED_DOCKERFILE: () => "Ghim trong cài đặt build.",
    PINNED_BUILDPACKS: () => "Ghim trong cài đặt build.",
    GOLDEN_PATH: () => "Mẫu dự án (Golden Path) có sẵn Dockerfile.",
    SCAN_DOCKERFILE: (path: string) => `Lần quét repo thấy ${path}.`,
    SCAN_BUILDPACKS: (language: string) =>
      `Repo không có Dockerfile; Buildpacks build được ${language}.`,
    SCAN_NEEDS_DOCKERFILE: (language: string) =>
      `Không có Dockerfile, và Buildpacks không build được ${language}.`,
    NOT_SCANNED: () =>
      "Chưa quét repo. Lúc chạy, pipeline dùng Dockerfile nếu có, không thì Buildpacks.",
  } satisfies Record<Reason, (detail: string) => string>,
  language: "Ngôn ngữ",
  languageName: {
    nodejs: "Node.js",
    python: "Python",
    go: "Go",
    "java-maven": "Java (Maven)",
    "java-gradle": "Java (Gradle)",
    dotnet: ".NET",
    ruby: "Ruby",
    php: "PHP",
    static: "Web tĩnh",
    rust: "Rust",
    other: "Khác",
  } satisfies Record<BuildLanguage, string>,
  languageSource: {
    settings: "theo cài đặt",
    scan: "theo lần quét repo",
    runtime: "theo runtime của project",
  } satisfies Record<Source, string>,
  pushTo: "Đẩy vào",
  noRegistry: "Chưa có registry",
  push: {
    basic: "tài khoản và mật khẩu (secret của CI)",
    "github-token": "GITHUB_TOKEN của chính lượt chạy",
    "aws-ecr": "danh tính build, không khoá",
    gcp: "danh tính build, không khoá",
    "azure-acr": "danh tính build, không khoá",
  } satisfies Record<Push, string>,
  platform: "Kiến trúc",
  test: "Bước test",
  testSkip: "Tắt trong cài đặt build",
  testMissing: (language: string) => `Chưa có lệnh test cho ${language}`,
  testImage: (image: string) => `trong ${image}`,
  // [Plan #61 QĐ-13] Vá image nền theo lịch
  rebase: "Vá image nền",
  rebaseWhen: (time: string) => `Mỗi ngày lúc ${time} UTC`,
  rebaseHow: {
    "github-actions": () => "Lịch có sẵn trong tệp workflow.",
    jenkins: () => "Lịch có sẵn trong Jenkinsfile, chỉ chạy ở nhánh main.",
    "gitlab-ci": (cron: string) =>
      `Tạo lịch ở Build, Pipeline schedules: nhánh main, cron "${cron}", múi giờ UTC.`,
    circleci: (_cron: string, time: string) =>
      `Tạo lịch ở Project Settings, Triggers: nhánh main, mỗi ngày lúc ${time} UTC.`,
    drone: (cron: string) =>
      `Tạo lịch: drone cron add <owner/repo> udp-rebase "0 ${cron}" --branch main`,
    tekton: () =>
      "Tekton chưa có lịch trong UDP: chạy Pipeline rebase (lệnh tkn ở đầu tệp pipeline) theo lịch của bạn.",
  } satisfies Record<string, RebaseHow>,
  rebaseOff:
    "Chiến lược ghim Dockerfile: lấy bản vá của image nền bằng cách cập nhật FROM rồi build lại.",
  todoTitle: "Việc cần làm để pipeline build và đẩy được image",
  allSet: "Không còn việc gì: pipeline build và đẩy được image.",
  todo: {
    ENABLE_CI: "Bật một công cụ ở domain CI/CD để UDP sinh pipeline.",
    ENABLE_REGISTRY: "Bật một Container Registry: pipeline cần nơi đẩy image.",
    REAPPLY_REGISTRY:
      "Registry được bật từ trước bản này: áp lại domain Container Registry để UDP biết cách đẩy image.",
    BUILD_IDENTITY: (cloud: string) =>
      `Chạy script danh tính build bên dưới trên ${cloud}, rồi dán dòng kết quả vào ô.`,
    SIGNING_KEY: (cloud: string) =>
      `Danh tính build có từ trước khi UDP ký image: chạy lại script bên dưới trên ${cloud} (bản mới tạo thêm khoá ký trong KMS), rồi dán dòng kết quả.`,
    CIRCLECI_IDS:
      "Điền Organization ID và Project ID của CircleCI trong cấu hình domain CI/CD: danh tính build chỉ tin đúng project này.",
    NO_CLUSTER:
      "CI chạy trong cluster: cần cluster dựng xong để biết issuer OIDC của nó.",
    CLUSTER_OTHER_CLOUD:
      "Registry và cluster ở hai cloud khác nhau, nên CI trong cluster không có danh tính ở cloud của registry. Dùng registry cùng cloud với cluster, hay registry dùng tài khoản và mật khẩu.",
    TEST_COMMAND: (language: string) =>
      `Chưa có lệnh test cho ${language}: khai lệnh trong Cài đặt build, hay tắt bước test.`,
    NEEDS_DOCKERFILE: (language: string) =>
      `Buildpacks không build được ${language}: thêm Dockerfile vào repo, hay khai đường của nó trong Cài đặt build.`,
    DRONE_TRUSTED:
      "Drone: đánh dấu repo là Trusted để bước build Dockerfile chạy được (Drone không đặt seccomp cho từng bước).",
    TEKTON_RUN:
      "Tekton chưa tự chạy khi push (chưa có Tekton Triggers): chạy pipeline bằng lệnh tkn ở đầu tệp pipeline.",
  },
  secrets: {
    "github-actions": (names: string) =>
      `Thêm secret ${names} ở Settings, Secrets and variables, Actions của repo.`,
    "gitlab-ci": (names: string) =>
      `Thêm biến CI/CD (masked) ${names} ở Settings, CI/CD, Variables.`,
    circleci: (names: string) =>
      `Thêm biến môi trường ${names} ở Project Settings, Environment Variables.`,
    jenkins: () =>
      "Thêm hai credential kiểu Secret text với id udp-registry-username và udp-registry-password.",
    tekton: (names: string) =>
      `Tạo Secret udp-ci-secrets ở namespace udp-build với khoá ${names}.`,
    drone: () =>
      "Thêm hai secret udp_registry_username và udp_registry_password cho repo trong Drone.",
  } as Record<string, (names: string) => string>,
  secretsFallback: (names: string) => `Thêm biến bí mật ${names} vào CI.`,
  cloud: {
    aws: "AWS CloudShell",
    gcp: "Google Cloud Shell",
    azure: "Azure Cloud Shell",
  } satisfies Record<Cloud, string>,
  identityTitle: "Danh tính build",
  identityWhy:
    "Không khoá dài hạn: CI xin token ngắn hạn bằng OIDC, chỉ đúng repo và nhánh của project dùng được, chỉ đẩy được vào đúng repository.",
  identityOk: "Đã có danh tính build.",
  identityMissing: "Chưa có danh tính build.",
  scriptLabel: (cloud: string) => `Script danh tính build cho ${cloud}`,
  scriptCopy: "Sao chép script",
  paste: "Dòng kết quả của script",
  pasteHint: "Dán nguyên dòng UDP_BUILD_IDENTITY=… mà script in ra ở cuối.",
  pasteInvalid:
    "Không đọc được: dán nguyên dòng UDP_BUILD_IDENTITY=… mà script in ra.",
  pasteWrongCloud: (cloud: string) =>
    `Đây là danh tính của cloud khác: registry của project cần danh tính ${cloud}.`,
  saveIdentity: "Lưu danh tính",
  // [Plan #61 QĐ-14, QĐ-16] Ký image và cổng deploy
  signingTitle: "Ký image",
  signingWhy:
    "Pipeline ký image bằng khoá trong KMS của cloud của project, ngay sau các bước quét. UDP chỉ giữ khoá công khai và chỉ deploy image có chữ ký đúng: secret webhook có lộ cũng không deploy được image lạ.",
  signingBlocked: {
    NO_CLOUD:
      "Project chưa kết nối cloud: khoá ký nằm trong KMS của cloud của project, nên cần kết nối cloud trước. Tới lúc đó image vẫn deploy như cũ, chưa ký.",
    CIRCLECI_AZURE:
      "CircleCI chưa ký được trên Azure: Azure không nhận token OIDC của CircleCI. UDP sẽ ký trong cụm ở bản sau; tới lúc đó image vẫn deploy như cũ, chưa ký.",
  } satisfies Record<SigningBlocked, string>,
  noKeys:
    "Chưa có khoá ký: script danh tính ở trên tạo khoá trong KMS, dán dòng kết quả của nó là xong.",
  signingCost:
    "Khoá nằm trong KMS của cloud của bạn và tính phí ở đó: AWS KMS 1 USD mỗi khoá mỗi tháng cộng 0,15 USD mỗi 10 000 lần ký; GCP và Azure theo bảng giá của họ. UDP không thu thêm.",
  keys: "Khoá ký",
  keyId: "Dấu vân tay",
  keyKms: "Khoá trong KMS",
  keyAdded: "Ngày thêm",
  keySigning: "Đang ký",
  keyAccepted: "Vẫn được chấp nhận",
  keyActions: "Thao tác",
  removeKey: (id: string) => `Gỡ khoá ${id}`,
  removeKeyTitle: "Gỡ khoá ký?",
  removeKeyBody: (id: string) =>
    `Image ký bằng khoá ${id} sẽ không deploy được nữa. Khoá vẫn còn trong KMS: xoá nó trong cloud nếu không dùng nữa.`,
  removeLastKeyBody:
    "Đây là khoá cuối cùng: gỡ nó thì UDP thôi kiểm chữ ký và tắt chế độ bắt buộc. Pipeline sinh lại sẽ không ký nữa.",
  removeKeyConfirm: "Gỡ khoá",
  compat: "Chữ ký tương thích",
  compatHint:
    "Thêm chữ ký dạng simple signing để podman, skopeo, CRI-O và bootc cũng kiểm được image.",
  enforced: "Bắt buộc: image không có chữ ký hợp lệ không được deploy.",
  waiting:
    "Chờ chữ ký hợp lệ đầu tiên: UDP tự bật bắt buộc khi nhận được nó. Sinh lại pipeline để bước ký có mặt.",
  enforceOff: "Tắt bắt buộc",
  enforceOn: "Bắt buộc ngay",
  enforceOffTitle: "Tắt bắt buộc chữ ký?",
  enforceOffBody:
    "Image không có chữ ký sẽ deploy được cho tới lần pipeline gửi chữ ký hợp lệ kế tiếp, lúc đó UDP tự bật lại. Chữ ký sai vẫn luôn bị từ chối. Việc này được ghi vào nhật ký.",
  enforceOnTitle: "Bắt buộc chữ ký ngay?",
  enforceOnBody:
    "Từ giờ image không có chữ ký hợp lệ sẽ không được deploy. Chỉ bật khi pipeline đang chạy đã có bước ký.",
  settingsTitle: "Cài đặt build",
  readOnly: "Chỉ Người bảo trì trở lên đổi được cài đặt build.",
  strategy: "Chiến lược",
  strategyName: {
    auto: "Tự động: Dockerfile nếu có, không thì Buildpacks",
    dockerfile: "Luôn dùng Dockerfile",
    buildpacks: "Luôn dùng Buildpacks",
  } satisfies Record<Strategy, string>,
  context: "Thư mục build",
  contextHint: "Tương đối với gốc repo, ví dụ services/web. Dấu chấm là gốc.",
  dockerfile: "Dockerfile",
  dockerfileHint: "Tương đối với thư mục build.",
  pathInvalid: "Đường dẫn tương đối, không có .. hay ký tự đặc biệt.",
  languageField: "Ngôn ngữ của bước test",
  languageAuto: (current: string) => `Tự nhận (${current})`,
  testMode: "Bước test",
  testModeName: {
    default: "Mặc định theo ngôn ngữ",
    custom: "Tự khai lệnh",
    none: "Tắt bước test",
  },
  command: "Lệnh test",
  commandHint: "Một dòng, không nháy, không backslash.",
  commandInvalid:
    "Lệnh có ký tự không dùng được: nháy, backslash, % hay xuống dòng.",
  image: "Image chạy test",
  imageHint: "Nên ghim digest, ví dụ ruby:3.4@sha256:…",
  imageInvalid: "Tên image không hợp lệ.",
  save: "Lưu cài đặt",
  saving: "Đang lưu…",
  saved: "Đã lưu cài đặt build.",
};

const en: typeof vi = {
  title: "Container packaging",
  lead: "UDP builds your app image in your own CI: a Dockerfile in the repo is used as is, otherwise Buildpacks detect the language.",
  builtWith: "Built with",
  predicted: {
    dockerfile: "Dockerfile (BuildKit)",
    buildpacks: "Buildpacks (Paketo)",
    unknown: "Not known yet",
  },
  reason: {
    PINNED_DOCKERFILE: () => "Pinned in the build settings.",
    PINNED_BUILDPACKS: () => "Pinned in the build settings.",
    GOLDEN_PATH: () => "The Golden Path template ships a Dockerfile.",
    SCAN_DOCKERFILE: (path: string) => `The last repo scan found ${path}.`,
    SCAN_BUILDPACKS: (language: string) =>
      `The repo has no Dockerfile; Buildpacks can build ${language}.`,
    SCAN_NEEDS_DOCKERFILE: (language: string) =>
      `There is no Dockerfile, and Buildpacks cannot build ${language}.`,
    NOT_SCANNED: () =>
      "The repo has not been scanned. At run time the pipeline uses a Dockerfile if there is one, otherwise Buildpacks.",
  },
  language: "Language",
  languageName: {
    nodejs: "Node.js",
    python: "Python",
    go: "Go",
    "java-maven": "Java (Maven)",
    "java-gradle": "Java (Gradle)",
    dotnet: ".NET",
    ruby: "Ruby",
    php: "PHP",
    static: "Static site",
    rust: "Rust",
    other: "Other",
  },
  languageSource: {
    settings: "from the settings",
    scan: "from the repo scan",
    runtime: "from the project runtime",
  },
  pushTo: "Pushes to",
  noRegistry: "No registry yet",
  push: {
    basic: "username and password (CI secrets)",
    "github-token": "the run's own GITHUB_TOKEN",
    "aws-ecr": "build identity, no keys",
    gcp: "build identity, no keys",
    "azure-acr": "build identity, no keys",
  },
  platform: "Architecture",
  test: "Test step",
  testSkip: "Turned off in the build settings",
  testMissing: (language: string) => `No test command for ${language} yet`,
  testImage: (image: string) => `in ${image}`,
  rebase: "Base image patch",
  rebaseWhen: (time: string) => `Every day at ${time} UTC`,
  rebaseHow: {
    "github-actions": () => "The schedule is already in the workflow file.",
    jenkins: () =>
      "The schedule is already in the Jenkinsfile and runs on the main branch only.",
    "gitlab-ci": (cron: string) =>
      `Create a schedule under Build, Pipeline schedules: branch main, cron "${cron}", time zone UTC.`,
    circleci: (_cron: string, time: string) =>
      `Create a schedule under Project Settings, Triggers: branch main, every day at ${time} UTC.`,
    drone: (cron: string) =>
      `Create the schedule: drone cron add <owner/repo> udp-rebase "0 ${cron}" --branch main`,
    tekton: () =>
      "Tekton has no schedule in UDP yet: run the rebase Pipeline (the tkn command at the top of the pipeline file) on your own schedule.",
  },
  rebaseOff:
    "The strategy is pinned to Dockerfile: get base image patches by updating FROM and rebuilding.",
  todoTitle: "To do before the pipeline can build and push",
  allSet: "Nothing left to do: the pipeline can build and push the image.",
  todo: {
    ENABLE_CI:
      "Enable a tool in the CI/CD domain so UDP can generate the pipeline.",
    ENABLE_REGISTRY:
      "Enable a Container Registry: the pipeline needs somewhere to push.",
    REAPPLY_REGISTRY:
      "The registry was enabled before this release: re-apply the Container Registry domain so UDP knows how to push.",
    BUILD_IDENTITY: (cloud: string) =>
      `Run the build identity script below in ${cloud}, then paste the line it prints.`,
    SIGNING_KEY: (cloud: string) =>
      `The build identity predates image signing: run the script below again in ${cloud} (the new one also creates a signing key in KMS), then paste the line it prints.`,
    CIRCLECI_IDS:
      "Fill in the CircleCI Organization ID and Project ID in the CI/CD domain settings: the build identity trusts only this project.",
    NO_CLUSTER:
      "CI runs inside the cluster: the cluster must be up first so UDP knows its OIDC issuer.",
    CLUSTER_OTHER_CLOUD:
      "The registry and the cluster are on different clouds, so in-cluster CI has no identity on the registry's cloud. Use a registry on the cluster's cloud, or one with a username and password.",
    TEST_COMMAND: (language: string) =>
      `No test command for ${language} yet: set one in the build settings, or turn the test step off.`,
    NEEDS_DOCKERFILE: (language: string) =>
      `Buildpacks cannot build ${language}: add a Dockerfile to the repo, or set its path in the build settings.`,
    DRONE_TRUSTED:
      "Drone: mark the repo as Trusted so the Dockerfile build step can run (Drone cannot set seccomp per step).",
    TEKTON_RUN:
      "Tekton does not run on push yet (no Tekton Triggers): start the pipeline with the tkn command at the top of the pipeline file.",
  },
  secrets: {
    "github-actions": (names: string) =>
      `Add the secrets ${names} under the repo's Settings, Secrets and variables, Actions.`,
    "gitlab-ci": (names: string) =>
      `Add the masked CI/CD variables ${names} under Settings, CI/CD, Variables.`,
    circleci: (names: string) =>
      `Add the environment variables ${names} under Project Settings, Environment Variables.`,
    jenkins: () =>
      "Add two Secret text credentials with the ids udp-registry-username and udp-registry-password.",
    tekton: (names: string) =>
      `Create the Secret udp-ci-secrets in the udp-build namespace with the keys ${names}.`,
    drone: () =>
      "Add the secrets udp_registry_username and udp_registry_password to the repo in Drone.",
  },
  secretsFallback: (names: string) => `Add the secrets ${names} to your CI.`,
  cloud: {
    aws: "AWS CloudShell",
    gcp: "Google Cloud Shell",
    azure: "Azure Cloud Shell",
  },
  identityTitle: "Build identity",
  identityWhy:
    "No long-lived keys: CI gets short-lived tokens through OIDC, only this project's repo and branches can use them, and they can only push to this repository.",
  identityOk: "The build identity is set.",
  identityMissing: "No build identity yet.",
  scriptLabel: (cloud: string) => `Build identity script for ${cloud}`,
  scriptCopy: "Copy script",
  paste: "The script's result line",
  pasteHint:
    "Paste the whole UDP_BUILD_IDENTITY=… line the script prints at the end.",
  pasteInvalid:
    "Could not read that: paste the whole UDP_BUILD_IDENTITY=… line the script printed.",
  pasteWrongCloud: (cloud: string) =>
    `That identity is for another cloud: the project's registry needs a ${cloud} identity.`,
  saveIdentity: "Save identity",
  signingTitle: "Image signing",
  signingWhy:
    "The pipeline signs the image with a key in your project cloud's KMS, right after the scan steps. UDP keeps only the public key and deploys only images with a valid signature: even a leaked webhook secret cannot deploy a foreign image.",
  signingBlocked: {
    NO_CLOUD:
      "The project has no cloud connected yet: the signing key lives in the KMS of the project's cloud, so connect a cloud first. Until then images deploy as before, unsigned.",
    CIRCLECI_AZURE:
      "CircleCI cannot sign on Azure yet: Azure does not accept CircleCI's OIDC tokens. UDP will sign inside the cluster in a later release; until then images deploy as before, unsigned.",
  },
  noKeys:
    "No signing key yet: the identity script above creates one in KMS; paste the line it prints and you are done.",
  signingCost:
    "The key lives in your cloud's KMS and is billed there: AWS KMS charges 1 USD per key per month plus 0.15 USD per 10,000 signatures; GCP and Azure follow their own price lists. UDP charges nothing extra.",
  keys: "Signing keys",
  keyId: "Fingerprint",
  keyKms: "Key in KMS",
  keyAdded: "Added",
  keySigning: "Signing",
  keyAccepted: "Still accepted",
  keyActions: "Actions",
  removeKey: (id: string) => `Remove key ${id}`,
  removeKeyTitle: "Remove the signing key?",
  removeKeyBody: (id: string) =>
    `Images signed with key ${id} can no longer be deployed. The key stays in KMS: delete it in your cloud if you no longer need it.`,
  removeLastKeyBody:
    "This is the last key: removing it stops UDP checking signatures and turns enforcement off. A regenerated pipeline will no longer sign.",
  removeKeyConfirm: "Remove key",
  compat: "Compatible signature",
  compatHint:
    "Also add a simple signing signature so podman, skopeo, CRI-O and bootc can verify the image.",
  enforced: "Enforced: images without a valid signature are not deployed.",
  waiting:
    "Waiting for the first valid signature: UDP turns enforcement on when it arrives. Regenerate the pipeline so it has the signing step.",
  enforceOff: "Stop enforcing",
  enforceOn: "Enforce now",
  enforceOffTitle: "Stop enforcing signatures?",
  enforceOffBody:
    "Unsigned images can be deployed until the pipeline next sends a valid signature, at which point UDP turns enforcement back on. Invalid signatures are always rejected. This is recorded in the audit log.",
  enforceOnTitle: "Enforce signatures now?",
  enforceOnBody:
    "From now on, images without a valid signature are not deployed. Only do this once the running pipeline has the signing step.",
  settingsTitle: "Build settings",
  readOnly: "Only Maintainers and above can change the build settings.",
  strategy: "Strategy",
  strategyName: {
    auto: "Automatic: a Dockerfile if there is one, otherwise Buildpacks",
    dockerfile: "Always use the Dockerfile",
    buildpacks: "Always use Buildpacks",
  },
  context: "Build directory",
  contextHint:
    "Relative to the repo root, for example services/web. A dot is the root.",
  dockerfile: "Dockerfile",
  dockerfileHint: "Relative to the build directory.",
  pathInvalid: "A relative path without .. or special characters.",
  languageField: "Test step language",
  languageAuto: (current: string) => `Detect (${current})`,
  testMode: "Test step",
  testModeName: {
    default: "Default for the language",
    custom: "My own command",
    none: "Turn the test step off",
  },
  command: "Test command",
  commandHint: "One line, no quotes, no backslashes.",
  commandInvalid:
    "The command has characters that cannot be used: quotes, backslashes, % or line breaks.",
  image: "Image to run the tests in",
  imageHint: "Pin a digest if you can, for example ruby:3.4@sha256:…",
  imageInvalid: "That is not a valid image name.",
  save: "Save settings",
  saving: "Saving…",
  saved: "Build settings saved.",
};

export const packagingMessages = defineMessages({ vi, en });
