import type {
  DomainAdapter,
  DomainToolConfig,
  PipelineStep,
  PipelineTemplateParams,
} from "@udp/adapter-core";
import type { CapabilityId } from "@udp/shared-types";
import type { ZodType } from "zod";
import { createDescriptorAdapter } from "./descriptor.js";

/**
 * Bước pipeline góp từ domain khác (Plan #37 QĐ-1..QĐ-3, D-P28) — hai nửa:
 *
 *  1. **Lớp nền** cho tool chạy TRONG CI (Terraform, Pulumi, Ansible, Checkov, Grype, ZAP): không
 *     cài gì vào cluster (lớp nền mô tả, ConfigMap là đích drift), `requires: pipeline.trigger` —
 *     không có CI thì bước không có chỗ chạy, validator chặn lúc lưu. Module xuất `pipelineSteps`
 *     cạnh export mặc định; registry kiểm lúc nạp (`pipelineStepsOf`).
 *  2. **Hàm dựng** mà sáu CI/CD adapter dùng để đặt bước vào template theo cú pháp của mình.
 *
 * Luật chung cho sáu CI: thứ tự tất định (pha, rồi `tool`, rồi `name`); bước chạy trong image của
 * nó (không cài công cụ lên máy chạy); biến bí mật chỉ đi bằng TÊN.
 */

/** Export có tên của module adapter — `project.slug` để khoá state theo project */
export type PipelineStepsDeclaration = (
  config: DomainToolConfig,
  project: { slug: string },
) => PipelineStep[];

export interface PipelineStepAdapterSpec {
  domainType: DomainAdapter["domainType"];
  toolId: string;
  version: string;
  provides: Extract<CapabilityId, "infra.provision" | "security.scan">;
  /** Thuộc tính của binding — `mode: "pipeline"` được thêm sẵn */
  attributes: Record<string, string>;
  configSchema: ZodType;
  /** Mô tả trong ConfigMap — đích drift; KHÔNG mang bí mật (registry cấm trường bí mật ở họ này) */
  describe: (config: DomainToolConfig) => Record<string, string>;
  steps: (
    config: DomainToolConfig,
    project: { slug: string },
  ) => Omit<PipelineStep, "tool">[];
}

export function createPipelineStepAdapter(spec: PipelineStepAdapterSpec): {
  adapter: DomainAdapter;
  pipelineSteps: PipelineStepsDeclaration;
} {
  const adapter = createDescriptorAdapter({
    domainType: spec.domainType,
    toolId: spec.toolId,
    version: spec.version,
    capabilities: {
      provides: [{ id: spec.provides, version: "1.0.0" }],
      requires: [{ id: "pipeline.trigger" }],
      hint: {
        "pipeline.trigger": `${spec.toolId} chạy như một bước của pipeline: bật một tool ở domain CI/CD`,
      },
    },
    configSchema: spec.configSchema,
    descriptorName: `udp-steps-${spec.toolId}`,
    ignoredKeyPrefixes: ["kubectl.kubernetes.io/"],
    // CI đang chở bước — đọc từ binding, không đoán (§5.2); đổi CI ⇒ `onDependencyChanged` ghi lại
    describe: (config, ctx) => ({
      ...spec.describe(config),
      ci: ciProviderOf(ctx.resolved),
    }),
    bindings: () => [
      {
        id: spec.provides,
        version: "1.0.0",
        providedBy: `${spec.domainType.toLowerCase()}:${spec.toolId}`,
        attributes: { ...spec.attributes, mode: "pipeline" },
      },
    ],
  });
  return {
    adapter,
    pipelineSteps: (config, project) =>
      spec.steps(config, project).map((s) => {
        assertSafe(s, spec.toolId);
        return { ...s, tool: spec.toolId };
      }),
  };
}

/**
 * Ký tự mà bước KHÔNG được mang. Bước đi vào sáu cú pháp — YAML, chuỗi ba nháy đơn của Groovy
 * (xử lý backslash), `sh -ec` trong nháy đơn, chỗ trống `%TÊN%` của template. Cấm chúng thì không
 * cần thoát ký tự ở đâu cả, và một cấu hình lọt qua regex của adapter cũng không bẻ được template.
 */
const UNSAFE_STEP_TEXT = /['\\%\n\r]/;

/** Tên bước thành tên job/task/stage ở mọi CI — Tekton đòi nhãn DNS, nên mọi CI dùng cùng luật */
const STEP_NAME = /^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$/;

function assertSafe(step: Omit<PipelineStep, "tool">, toolId: string): void {
  if (!STEP_NAME.test(step.name)) {
    throw new Error(
      `tên bước của ${toolId} không phải nhãn kebab: ${step.name}`,
    );
  }
  const bad = [
    step.name,
    step.image,
    ...step.commands,
    ...Object.entries(step.env).flat(),
    ...step.secretEnv,
  ].find((text) => UNSAFE_STEP_TEXT.test(text));
  if (bad !== undefined) {
    throw new Error(
      `bước của ${toolId} mang ký tự không an toàn cho template: ${bad.slice(0, 40)}`,
    );
  }
}

/** Tool CI đang bật — thuộc tính `provider` của binding `pipeline.trigger` */
function ciProviderOf(
  resolved: Partial<Record<string, { attributes?: Record<string, string> }>>,
): string {
  const provider = resolved["pipeline.trigger"]?.attributes?.provider;
  if (provider === undefined) {
    throw new Error("thiếu binding pipeline.trigger trong ctx.resolved");
  }
  return provider;
}

// ------------------------------------------------------------------ dựng bước cho sáu CI

export type StepPhase = PipelineStep["phase"];

export function stepsOf(
  params: PipelineTemplateParams,
  phase: StepPhase,
): PipelineStep[] {
  return params.steps
    .filter((s) => s.phase === phase)
    .sort(
      (a, b) => a.tool.localeCompare(b.tool) || a.name.localeCompare(b.name),
    );
}

/** Trích một chuỗi cho `sh` — bước đã qua `assertSafe` nên bên trong không có nháy đơn */
const shellQuote = (value: string): string => `'${value}'`;

/** Tên job/task/stage của bước ở mọi CI */
export const stepId = (step: PipelineStep): string =>
  `udp-${step.tool}-${step.name}`;

/** Biến mà mọi bước nhận thêm từ template: environment đích và ảnh vừa dựng */
export const STEP_SHARED_ENV = ["UDP_ENVIRONMENT", "IMAGE_REF"] as const;

/** Biến công khai của bước, thứ tự tất định */
export const publicEnvOf = (step: PipelineStep): [string, string][] =>
  Object.entries(step.env).sort(([a], [b]) => a.localeCompare(b));

/**
 * MỘT dòng shell chạy bước trong image của nó — cho CI chạy trên máy có Docker (GitHub Actions,
 * CircleCI, Jenkins). Thư mục làm việc gắn vào CÙNG đường dẫn: tệp mà bước xác thực cloud của CI
 * để lại (`GOOGLE_APPLICATION_CREDENTIALS`) trỏ đúng chỗ trong container. Biến bí mật đi bằng
 * `-e TÊN` — Docker lấy giá trị từ môi trường của CI.
 */
export function dockerRunLine(step: PipelineStep): string {
  return [
    // Image của công cụ thường có entrypoint riêng (`terraform`, `checkov`) — lệnh đi qua `sh`
    "docker run --rm --entrypoint sh",
    '-v "$PWD:$PWD" -w "$PWD"',
    ...publicEnvOf(step).map(([k, v]) => `-e ${k}=${shellQuote(v)}`),
    ...[...step.secretEnv, ...STEP_SHARED_ENV].map((name) => `-e ${name}`),
    step.image,
    "-ec",
    // Một dòng: template đặt lệnh này trong khối YAML, xuống dòng là vỡ thụt lề
    shellQuote(step.commands.join(" && ")),
  ].join(" ");
}
