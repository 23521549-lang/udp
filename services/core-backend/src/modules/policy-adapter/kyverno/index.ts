import { helmChart } from "@udp/config/helm-charts";
import { z } from "zod";
import type { DomainAdapter, ReadOnlyAdapterContext } from "@udp/adapter-core";
import { createHelmBasedAdapter } from "../../adapter-base/helm.js";
import { BUILD_NAMESPACE } from "../../adapter-base/packaging/build-script.js";
import { imageValidatingPolicy } from "./image-policy.js";

/**
 * Adapter Kyverno (§5.5 Policy & Governance, Plan #34) — họ Helm, hai release: `kyverno` (engine)
 * rồi `kyverno-policies` (bộ Pod Security Standards chính thức).
 *
 * Mức PSS (`baseline`/`restricted`) và chế độ (`Audit`/`Enforce`) là cấu hình; mặc định Audit —
 * bật Enforce trên một project đang chạy mà chưa audit là chặn deploy của khách không báo trước.
 * Webhook miễn trừ `udp-system` và `kube-system` (QĐ-1), và `udp-build` — nơi CI trong cluster build image (Plan #61).
 *
 * **[v4.12, Plan #61 61d-3a] Bản 2.0.0 — chart 3.9.1 (Kyverno 1.19.1), và một bẫy im lặng đã đóng.**
 * Chart `kyverno-policies` từ 3.9.x mặc định `policyType: ValidatingPolicy` (họ CEL mới, `policies.kyverno.io`),
 * và khoá `policyExclude` mà bản 1.0.0 truyền **chỉ áp dụng cho họ `ClusterPolicy` cũ**. Nâng chart mà không đổi
 * gì khác thì ba namespace nền tảng **mất quyền miễn trừ trong im lặng**: với `Audit` chỉ bẩn báo cáo, nhưng với
 * `Enforce` thì pod của chính nền tảng và pod build của BuildKit (cần seccomp `Unconfined`) bị chặn. Nên:
 *  - `policyType` ghim **tường minh**, không dựa vào mặc định của chart — một lần chart đổi mặc định không được
 *    đổi họ policy mà UDP cài;
 *  - miễn trừ đi bằng `vpolExclude.excludeNamespaces` (họ mới) thay cho `policyExclude` (họ cũ);
 *  - `upgradesFrom` mang **đủ định nghĩa của 1.0.0** (chart 3.2.7/3.2.6 cùng `policyExclude`), vì hạ về mà dùng
 *    giá trị của bản mới trên chart cũ là một lần hạ về sai: chart cũ bỏ qua `vpolExclude` trong im lặng.
 *
 * `provides` **giữ** `policy.admission@1.0.0`: bump version capability sẽ làm mọi consumer khai `^1` vỡ 422 ngay
 * trong `validateAndOrder`, trước khi chạm cụm — đổi chart không phải đổi hợp đồng capability.
 */

export const kyvernoConfigSchema = z
  .object({
    podSecurityStandard: z.enum(["baseline", "restricted"]).default("baseline"),
    validationFailureAction: z.enum(["Audit", "Enforce"]).default("Audit"),
    replicas: z.number().int().min(1).max(3).default(1),
  })
  .superRefine((cfg, ctx) => {
    /**
     * [61d-3a] `Enforce` ⇒ ít nhất hai bản sao admission controller.
     *
     * Từ chối ở đây — lúc LƯU cấu hình — chứ không lúc áp: một project bật Enforce với một bản sao duy nhất thì
     * mọi lần pod đó khởi động lại là một cửa sổ mà `failurePolicy: Fail` đóng mọi namespace environment của
     * project. Người dùng phải biết điều đó trước khi bấm lưu, không phải sau khi cụm đã tắc.
     */
    if (cfg.validationFailureAction === "Enforce" && cfg.replicas < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replicas"],
        message:
          "Enforce cần ít nhất 2 bản sao admission controller: một bản sao khởi động lại là một cửa sổ chặn mọi pod",
      });
    }
  });

const REPO = "https://kyverno.github.io/kyverno/";

/** Namespace mà KHÔNG policy nào được chạm — nền tảng và hệ thống của Kubernetes */
const exempt = (ctx: ReadOnlyAdapterContext): string[] => [
  ctx.systemNamespace,
  "kube-system",
  // [Plan #61 QĐ-12] Pod build của CI trong cluster: BuildKit không root cần seccomp `Unconfined`
  BUILD_NAMESPACE,
];

/** Giá trị của release engine — chung cho cả hai version, chỉ toạ độ chart đổi */
const engineValues = (
  config: unknown,
  ctx: ReadOnlyAdapterContext,
): Record<string, unknown> => {
  const parsed = kyvernoConfigSchema.parse(config);
  return {
    admissionController: { replicas: parsed.replicas },
    config: {
      webhooks: [
        {
          namespaceSelector: {
            matchExpressions: [
              {
                key: "kubernetes.io/metadata.name",
                operator: "NotIn",
                values: exempt(ctx),
              },
            ],
          },
        },
      ],
    },
  };
};

const POLICIES_RELEASE = "udp-kyverno-policies";

const adapter: DomainAdapter = createHelmBasedAdapter({
  domainType: "POLICY",
  toolId: "kyverno",
  version: "2.0.0",
  upgradesFrom: [
    {
      version: "1.0.0",
      chart: { name: "kyverno", version: "3.2.7", repo: REPO },
      values: engineValues,
      companions: [
        {
          releaseName: POLICIES_RELEASE,
          chart: { name: "kyverno-policies", version: "3.2.6", repo: REPO },
          /** Định nghĩa của bản 1.0.0: họ `ClusterPolicy`, nên miễn trừ đi bằng `policyExclude` */
          values: (config, ctx) => {
            const parsed = kyvernoConfigSchema.parse(config);
            return {
              podSecurityStandard: parsed.podSecurityStandard,
              validationFailureAction: parsed.validationFailureAction,
              policyExclude: {
                any: [{ resources: { namespaces: exempt(ctx) } }],
              },
            };
          },
        },
      ],
    },
  ],
  scope: "cluster",
  capabilities: {
    provides: [{ id: "policy.admission", version: "1.0.0" }],
    requires: [],
  },
  configSchema: kyvernoConfigSchema,
  chart: helmChart("kyverno"),
  releaseName: "udp-kyverno",
  quotaDimensions: [],
  ignoredKeyPrefixes: ["kubectl.kubernetes.io/", "helm.sh/"],

  values: engineValues,
  companions: [
    {
      releaseName: POLICIES_RELEASE,
      chart: helmChart("kyverno-policies"),
      values: (config, ctx) => {
        const parsed = kyvernoConfigSchema.parse(config);
        const policy = imageValidatingPolicy(ctx.signedImages);
        return {
          /** Ghim tường minh: mặc định của chart 3.9.x đã LÀ giá trị này, nhưng dựa vào mặc định là một bẫy */
          policyType: "ValidatingPolicy",
          /**
           * [61d-3b] Policy chữ ký image của project (AC-12) — danh sách RỖNG khi project chưa có khoá ký hay chưa
           * có binding `registry.oci`. `customPolicies` là đường mà chart 3.9.1 nhận policy tự viết
           * (`templates/other/custom-policies.yaml`); `image-policy.ts` nói vì sao policy đi đường này chứ không
           * bằng một lời ghi CR của `udp-tooling`.
           */
          customPolicies: policy === null ? [] : [policy],
          podSecurityStandard: parsed.podSecurityStandard,
          validationFailureAction: parsed.validationFailureAction,
          /**
           * `failurePolicy` theo chế độ: `Audit` thì webhook hỏng KHÔNG được chặn pod nào (một policy chỉ ghi báo
           * cáo mà làm đứng cụm là vô nghĩa); `Enforce` thì hỏng phải chặn, vì cho qua lúc hỏng là mở đúng cái
           * cổng mà chế độ đó dựng lên.
           */
          failurePolicy:
            parsed.validationFailureAction === "Enforce" ? "Fail" : "Ignore",
          /** Họ `ValidatingPolicy` miễn trừ bằng khoá NÀY — `policyExclude` của bản cũ không có tác dụng ở đây */
          vpolExclude: { excludeNamespaces: exempt(ctx) },
        };
      },
    },
  ],

  bindings: () => [
    {
      id: "policy.admission",
      version: "1.0.0",
      providedBy: "policy:kyverno",
      attributes: { engine: "kyverno", language: "yaml" },
    },
  ],
});

export default adapter;
