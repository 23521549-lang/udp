import type { RegistryPushKind, SignedImages } from "@udp/adapter-core";
import { REGISTRY_PULL_SECRET } from "../../cluster/bootstrap.js";

/**
 * [Plan #61 61d-3b] `ImageValidatingPolicy` của Kyverno 1.19.1 — chữ ký image kiểm ngay lúc tạo pod (AC-12).
 *
 * **Policy đi vào cụm bằng đường nào.** Không phải bằng một lời `write` của `udp-tooling`: ba lý do đo được.
 * (a) `udp-tooling` không có quyền nào trên nhóm `policies.kyverno.io` — `cluster/bootstrap.ts` chỉ cấp
 * `apiextensions.k8s.io/customresourcedefinitions` cho ClusterRole của nó, nên một lời ghi CR sẽ 403.
 * (b) Thêm quyền vào bootstrap thì cụm ĐANG CHẠY không nhận, vì bootstrap chỉ chạy lúc PROVISION và lúc THÊM
 * environment (`provision.job.ts`, `environment-apply.job.ts`) — một quyền mới chỉ tới cụm mới.
 * (c) D-P25 chốt cơ chế cài của UDP là `helm upgrade --install`; `HelmRelease` mà adapter ghi là một BẢN GHI.
 * Nên policy đi đúng đường mà mọi đối tượng khác của họ Helm đi: nó là **giá trị** của release `kyverno-policies`.
 * Chart 3.9.1 có khoá `customPolicies` cho đúng việc này (`templates/other/custom-policies.yaml` render từng phần tử;
 * `_helpers.tpl` → `tpl (.value | toYaml)`). Hệ quả: không RBAC mới, không cần bootstrap lại, và trôi/hạ về/teardown
 * dùng lại nguyên máy móc của lớp nền.
 *
 * **Vì sao `tpl` buộc phải có cổng chống tiêm.** Chart chạy `tpl` TRÊN nội dung policy, nên một chuỗi chứa `{{` trong
 * repository hay trong khoá công khai sẽ được Helm **thực thi** như template trong cụm của khách. `assertNoTemplate`
 * chặn tại chỗ sinh, không chờ Helm.
 *
 * Mọi trường dưới đây khớp CRD thật của Kyverno v1.19.1
 * (`config/crds/policies.kyverno.io/policies.kyverno.io_imagevalidatingpolicies.yaml`) và khuôn trong bộ conformance
 * của chính Kyverno (`test/conformance/chainsaw/image-validating-policies/`).
 */

/** Nhóm/phiên bản: `v1beta1` là version LƯU TRỮ của CRD; `v1alpha1` đã `deprecated: true`, `v1` chưa phải storage */
export const IVP_API_VERSION = "policies.kyverno.io/v1beta1";
export const IVP_NAME = "udp-require-signed-images";

/**
 * Nhãn mà `cluster/bootstrap.ts` đóng lên MỌI namespace environment (`udp.environment: <tên env>`) — và CHỈ lên
 * namespace đó. Chọn theo nhãn dương nghĩa là `udp-system`, `kube-system`, `udp-build` tự ở ngoài tầm policy, không
 * phải nhờ một danh sách miễn trừ mà ai đó phải nhớ cập nhật.
 */
const ENVIRONMENT_LABEL = "udp.environment";

/**
 * Trần thời gian của webhook, giây. CRD cho 1..30; mặc định của Kyverno là 10.
 *
 * Chọn 20 vì một lượt kiểm chữ ký là nhiều vòng tới registry (manifest, tag chữ ký, payload) — bộ conformance cosign
 * của chính Kyverno đặt 20..30. Đặt thấp hơn thì một registry chậm làm policy **hết giờ một cách hệ thống**, và với
 * `failurePolicy: Ignore` điều đó nghĩa là image coi như chưa kiểm mà không ai thấy — đúng loại hỏng im lặng mà
 * 61d-3a vừa đóng. Cái giá là pod ĐẦU TIÊN của một image mới có thể chờ tới 20 giây; Kyverno cache kết quả kiểm nên
 * các pod sau không trả giá đó.
 */
const WEBHOOK_TIMEOUT_SECONDS = 20;

/** `registryKind` ⇒ nhà cung cấp thông tin đăng nhập của Kyverno (enum của CRD: default/amazon/azure/google/github) */
const CREDENTIAL_PROVIDERS: Readonly<
  Partial<Record<RegistryPushKind | "other", string>>
> = {
  "github-token": "github",
  "aws-ecr": "amazon",
  gcp: "google",
  "azure-acr": "azure",
};

export class ImagePolicyError extends Error {}

/**
 * Chặn chuỗi có thể bị Helm `tpl` thực thi.
 *
 * Giá trị vào đây đã qua schema (`BUILD_TEXT_RULES.PUBLIC_KEY_PEM` neo hai đầu PEM; `workloadSlugFor` chỉ sinh
 * chữ-số-gạch), nên hôm nay không đường nào mang `{{` tới. Cổng này giữ cho điều đó còn đúng NGÀY MAI: endpoint của
 * binding `registry.oci` do người dùng nhập, và một lần nới schema ở chỗ khác không được biến thành thực thi template
 * trong cụm của khách.
 */
export function assertNoTemplate(label: string, value: string): void {
  if (value.includes("{{") || value.includes("}}")) {
    throw new ImagePolicyError(
      `${label} chứa dấu template của Helm — chart kyverno-policies chạy tpl trên policy nên giá trị này sẽ bị thực thi`,
    );
  }
}

/**
 * Tên attestor phải là một định danh CEL: biểu thức kiểm tham chiếu nó bằng `attestors.<tên>` (khuôn của Kyverno:
 * `verifyImageSignatures(image, [attestors.notary])`), nên `udp-key-0` sẽ không biên dịch được.
 */
const attestorName = (index: number): string => `udpKey${String(index)}`;

/** Ba danh sách image mà Kyverno bơm sẵn cho `pods` — `pkg/cel/compiler/images.go`, không phải khai `spec.images` */
const IMAGE_LISTS = [
  "containers",
  "initContainers",
  "ephemeralContainers",
] as const;

/**
 * `ImageValidatingPolicy` cho MỘT project, hay `null` khi project chưa ký image.
 *
 * `enforce` để dành: đợt này **luôn** `[Audit]` (xem §8.3 và sổ nợ `kyverno-admission-real`). Tham số không nhận
 * `enforce` để không ai tưởng là bật được — bật `Deny` là một thay đổi có plan riêng.
 *
 * Kiểu trả về là `Record<string, unknown>` chứ không phải một interface chép lại CRD: một bản chép như vậy là lời
 * khai **thứ hai** về hình dạng policy và nó sẽ lệch khỏi CRD thật ở lần Kyverno đổi schema (TypeScript không biết
 * gì về `policies.kyverno.io`). Hai cổng giữ hình dạng đúng, và cả hai đối chiếu với nguồn THẬT: một phép
 * `toEqual` trên toàn bộ object (`image-policy.test.ts`) và phép đo `kyverno-crd` kiểm theo chính `openAPIV3Schema`
 * của CRD v1.19.1.
 */
export function imageValidatingPolicy(
  signed: SignedImages | null,
): Record<string, unknown> | null {
  if (signed === null) return null;
  if (signed.publicKeys.length === 0) return null;

  assertNoTemplate("repository của image", signed.repository);
  signed.publicKeys.forEach((key, i) => {
    assertNoTemplate(`khoá công khai thứ ${String(i + 1)}`, key);
  });
  /** Suy MỘT lần: nó chỉ phụ thuộc `repository`, và nó đi vào mọi attestor */
  const project = projectAnnotationOf(signed);

  /**
   * Mỗi khoá một attestor, và biểu thức kiểm đòi **ít nhất một** attestor xác minh được
   * (`verifyImageSignatures` trả về SỐ attestor hợp lệ, nên `> 0`). Đó đúng là nghĩa của xoay khoá: khoá cũ còn
   * trong danh sách thì image ký bằng nó vẫn nhận.
   */
  const attestors = signed.publicKeys.map((key, i) => ({
    name: attestorName(i),
    cosign: {
      key: { data: key },
      /**
       * [CT-1] Chữ ký của UDP KHÔNG có bản ghi minh bạch: `SIGNING_CONFIG_JSON` không khai Fulcio, Rekor hay TSA
       * (QĐ-14 — image riêng tư không lộ tên và digest ra sổ công khai). Thiếu hai cờ này, Kyverno đòi một entry
       * Rekor và một SCT không tồn tại, nên MỌI image của MỌI project đều "không xác minh được".
       */
      ctlog: { insecureIgnoreTlog: true, insecureIgnoreSCT: true },
      /**
       * Annotation ĐƯỢC KÝ mà `sign-script.ts` đóng vào payload (`-a dev.udp.project=…`). Đòi nó ở đây để lớp
       * admission không lỏng hơn cổng deploy của 61d-1: một chữ ký hợp lệ của project KHÁC trên cùng registry không
       * được coi là chữ ký của project này. (Cổng 61d-1 còn kiểm nhánh, độ mới và replay — admission KHÔNG thay nó.)
       */
      annotations: { "dev.udp.project": project },
    },
  }));

  const attestorRefs = `[${attestors.map((a) => `attestors.${a.name}`).join(", ")}]`;

  return {
    apiVersion: IVP_API_VERSION,
    kind: "ImageValidatingPolicy",
    metadata: {
      name: IVP_NAME,
      labels: { "app.kubernetes.io/managed-by": "udp" },
    },
    spec: {
      /**
       * `Audit` ⇒ `Ignore`: một policy chỉ ghi báo cáo mà làm đứng việc tạo pod khi webhook hỏng là vô nghĩa, và nó
       * đúng là "điểm chết" mà AC-12 cấm.
       */
      failurePolicy: "Ignore",
      validationActions: ["Audit"],
      webhookConfiguration: { timeoutSeconds: WEBHOOK_TIMEOUT_SECONDS },
      /**
       * Khai TƯỜNG MINH cả hai: kiểm lúc admission (AC-12 đòi "lúc tạo pod") và quét nền (báo cáo của pod đang chạy
       * còn tươi). Mặc định của Kyverno cũng là hai `true`, nhưng 61d-3a vừa trả giá cho một lần dựa vào mặc định
       * của nhà phát hành.
       */
      evaluation: {
        admission: { enabled: true },
        background: { enabled: true },
      },
      /**
       * Autogen TẮT. Để mặc định (bật) thì Kyverno sinh thêm policy cho Deployment/StatefulSet/DaemonSet/Job/
       * CronJob/ReplicaSet — **không** có `Rollout` của Argo lẫn `Canary` của Flagger, tức đúng những thứ UDP dùng
       * để triển khai. Quy tắc ở tầng `pods` thì phủ ĐỦ (mọi pod đều qua nó, bất kể ai tạo), nên autogen chỉ thêm
       * một lượt kiểm thứ hai cho cùng một image: gấp đôi lưu lượng tới registry và gấp đôi dòng trong báo cáo.
       */
      autogen: { podControllers: { controllers: [] } },
      matchConstraints: {
        resourceRules: [
          {
            apiGroups: [""],
            apiVersions: ["v1"],
            operations: ["CREATE", "UPDATE"],
            /**
             * `pods/ephemeralcontainers` phải khai RIÊNG: engine CEL dựng quy tắc webhook **đúng y** theo
             * `resourceRules` và không tự nới một match `pods` sang subresource đó (kyverno#16275, và bộ conformance
             * `subresources/block-ephemeral-containers` của chính Kyverno khai cả hai). Thiếu nó thì
             * `kubectl debug` là một đường đưa image chưa ký vào pod mà policy không thấy.
             */
            resources: ["pods", "pods/ephemeralcontainers"],
          },
        ],
        namespaceSelector: {
          matchExpressions: [{ key: ENVIRONMENT_LABEL, operator: "Exists" }],
        },
      },
      /**
       * Ba glob, không một glob `*`.
       *
       * Image KHÔNG khớp `matchImageReferences` bị **loại khỏi** `images.*` và policy cho qua (mô tả của CRD:
       * *"Any image that does not match a rule is skipped, even when they are passed as arguments to image
       * verification functions"*). Nên phải khớp đủ ba dạng tham chiếu của CÙNG repository: trần (`:latest` ngầm),
       * theo tag, theo digest. Dùng một glob `*` thì mọi image nền cũng bị đòi chữ ký và cụm tắc.
       *
       * Ba glob này không bắt oan repository khác: `<repo>:*` đòi dấu `:` ngay sau tên, nên
       * `ghcr.io/acme/web-extra:1.0` không khớp `ghcr.io/acme/web:*`.
       */
      matchImageReferences: [
        { glob: signed.repository },
        { glob: `${signed.repository}:*` },
        { glob: `${signed.repository}@*` },
      ],
      /**
       * `mutateDigest` mặc định của CRD là **true**: ở đúng chế độ Audit, Kyverno sẽ SỬA `image` của pod thành dạng
       * digest. Với Flux/Argo đang đối chiếu Git, đó là trôi vĩnh viễn. Khai `false` tường minh.
       * `required: true` + `verifyDigest: true`: image phải qua được một phép kiểm chữ ký và phải có digest.
       */
      validationConfigurations: {
        required: true,
        verifyDigest: true,
        mutateDigest: false,
      },
      credentials: credentialsOf(signed),
      attestors,
      /**
       * Một biểu thức cho MỖI danh sách image. Gộp ba danh sách vào một biểu thức thì một thông báo duy nhất không
       * nói được chữ ký của container nào thiếu; tách ba thì báo cáo chỉ đúng chỗ.
       */
      validations: IMAGE_LISTS.map((list) => ({
        expression: `images.${list}.map(image, verifyImageSignatures(image, ${attestorRefs})).all(e, e > 0)`,
        message: `${list}: image của project không có chữ ký hợp lệ của UDP`,
      })),
    },
  };
}

/**
 * Giá trị annotation `dev.udp.project` mà pipeline ký.
 *
 * Đường đi của nó: `sign-script.ts` in `-a dev.udp.project=${vars.project}`; mọi adapter CI truyền
 * `project: "%PROJECT%"`; `pipeline-template.ts` điền `PROJECT: params.projectSlug` và
 * `IMAGE: ${registryRef}/${projectSlug}`. Nên annotation ĐÚNG BẰNG đoạn cuối của `repository`, và lấy lại từ đó là
 * cách để hai giá trị không lệch nhau được — thêm một trường nữa vào bối cảnh là thêm một nguồn thứ hai cho cùng
 * một dữ kiện.
 */
function projectAnnotationOf(signed: SignedImages): string {
  const slug = signed.repository.split("/").at(-1);
  if (slug === undefined || slug === "") {
    throw new ImagePolicyError(
      `repository ${signed.repository} không có phần slug — không suy được annotation dev.udp.project`,
    );
  }
  return slug;
}

/**
 * Thông tin đăng nhập registry của Kyverno.
 *
 * `secrets` khai KHÔNG điều kiện: `udp-registry-pull` ở namespace của Kyverno (`ctx.systemNamespace`, nơi hai release
 * Kyverno được cài) do `syncRegistryPullSystem` ghi. Thiếu Secret đó thì Kyverno ghi log "secret not found, skipping"
 * rồi đi tiếp (`regcreds.generateKeychainForPullSecrets` bỏ qua `IsNotFound`), nên khai sẵn không tạo chế độ hỏng mới
 * mà đóng được bốn registry dùng `pushAuth: basic` (Harbor, Nexus, Artifactory, Docker Hub).
 *
 * [CT-2] Secret PHẢI ở namespace của Kyverno: Kyverno đọc nó bằng SecretLister của chính nó với
 * `config.KyvernoNamespace()` làm mặc định. Một Secret ở namespace environment thì policy không thấy.
 */
function credentialsOf(signed: SignedImages): Record<string, unknown> {
  const provider = CREDENTIAL_PROVIDERS[signed.registryKind];
  return {
    secrets: [REGISTRY_PULL_SECRET],
    ...(provider === undefined ? {} : { providers: [provider] }),
  };
}
