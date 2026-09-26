import { createHmac } from "node:crypto";
import { workloadSlugFor } from "@udp/config";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import {
  constantTimeEquals,
  parseDeployBody,
  verifyHmacHeader,
  verifyTokenHeader,
  WebhookPayloadError,
} from "../src/modules/adapter-base/cicd.js";
import { tagOf } from "../src/modules/cicd/cicd-webhook.service.js";
import {
  imagePatch,
  WORKLOAD_KINDS,
  type WorkloadState,
} from "../src/modules/cicd/workload.js";
import githubActions from "../src/modules/cicd-adapter/github-actions/index.js";

/**
 * Plan #36 — phần THUẦN của CI/CD: so chữ ký, thân webhook, lớp nền mô tả có `requires`, và patch
 * workload. Phép kiểm cấu trúc (AST, AC-2) ở `design-lint`; bộ phép dùng chung trên sáu adapter ở
 * `contract.test.ts` cạnh từng adapter.
 */

const SECRET = Buffer.from("s".repeat(64));
const sign = (body: Buffer) =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

const BODY = {
  environment: "dev",
  status: "success",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  imageRef: "ghcr.io/acme/web:0123456",
  workloadName: "web",
  pipelineId: "42-1",
  repo: "acme/web",
  ref: "refs/heads/dev",
  actor: "dev",
};

describe("so chữ ký", () => {
  it("constantTimeEquals: lệch độ dài ⇒ false, không ném", () => {
    expect(constantTimeEquals(Buffer.from("ab"), Buffer.from("abc"))).toBe(
      false,
    );
    expect(constantTimeEquals(Buffer.from("abc"), Buffer.from("abc"))).toBe(
      true,
    );
  });

  it("verifyHmacHeader: sai tiền tố, hex hỏng, header vắng ⇒ false", () => {
    const body = Buffer.from("{}");
    const good = sign(body);
    const check = (headers: Record<string, string>) =>
      verifyHmacHeader(headers, body, SECRET, "X-UDP-Signature", "sha256=");
    expect(check({ "x-udp-signature": good })).toBe(true);
    expect(check({ "x-udp-signature": good.replace("sha256=", "sha1=") })).toBe(
      false,
    );
    expect(check({ "x-udp-signature": `sha256=${"z".repeat(64)}` })).toBe(
      false,
    );
    expect(check({})).toBe(false);
  });

  it("verifyTokenHeader: token khác độ dài ⇒ false", () => {
    expect(
      verifyTokenHeader({ "x-gitlab-token": "ngan" }, SECRET, "X-Gitlab-Token"),
    ).toBe(false);
    expect(
      verifyTokenHeader(
        { "x-gitlab-token": SECRET.toString() },
        SECRET,
        "X-Gitlab-Token",
      ),
    ).toBe(true);
  });
});

describe("thân webhook", () => {
  const raw = (v: unknown) => Buffer.from(JSON.stringify(v));

  it("thân hợp lệ ⇒ WebhookDeployEvent, trường tuỳ chọn vắng thì vắng", () => {
    const event = parseDeployBody("github-actions", raw(BODY));
    expect(event).toMatchObject({
      provider: "github-actions",
      pipelineId: "42-1",
      workloadName: "web",
    });
    expect("commitTimestamp" in event).toBe(false);
  });

  it("khoá lạ, sha ngắn, workload không phải nhãn DNS, image thiếu tag ⇒ WebhookPayloadError", () => {
    for (const bad of [
      { ...BODY, extra: 1 },
      { ...BODY, commitSha: "abc" },
      { ...BODY, workloadName: "Web_App" },
      { ...BODY, imageRef: "ghcr.io/acme/web" },
    ]) {
      expect(() => parseDeployBody("x", raw(bad))).toThrow(WebhookPayloadError);
    }
  });

  it("tagOf: tag, digest, cổng registry không bị nhầm là tag", () => {
    expect(tagOf("ghcr.io/acme/web:v1")).toBe("v1");
    expect(tagOf(`ghcr.io/acme/web@sha256:${"a".repeat(64)}`)).toBe(
      `sha256:${"a".repeat(64)}`,
    );
    expect(tagOf("registry.acme.dev:5000/web:abc")).toBe("abc");
    expect(tagOf("registry.acme.dev:5000/web")).toBe("latest");
  });

  it("workloadSlugFor: bỏ dấu, nhãn DNS, rỗng ⇒ app", () => {
    expect(workloadSlugFor("Dự án Bán hàng")).toBe("du-an-ban-hang");
    expect(workloadSlugFor("***")).toBe("app");
  });
});

describe("lớp nền mô tả có requires (GitHub Actions)", () => {
  const config = { repository: "acme/web" };
  const registry = (endpoint: string) => ({
    id: "registry.oci",
    version: "1.0.0",
    providedBy: "container_registry:ghcr",
    endpoint,
  });
  const fixture = {
    validConfig: config,
    invalidConfigs: [],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: [],
    driftMutations: [],
  };

  it("thiếu binding registry.oci ⇒ FAILED, không ghi gì (không đoán registry)", async () => {
    const env = domainContractEnv(fixture);
    const result = await githubActions.deploy(env.context(), config);
    expect(result.status).toBe("FAILED");
    expect(env.cluster.writes).toEqual([]);
  });

  it("registry đổi ⇒ mô tả ghi lại với endpoint MỚI; capability khác ⇒ không ghi", async () => {
    const env = domainContractEnv(fixture, {
      resolved: { "registry.oci": registry("ghcr.io/acme") },
    });
    expect((await githubActions.deploy(env.context(), config)).status).toBe(
      "SUCCESS",
    );
    const ref = env.cluster.writes[0]!.ref;
    const writes = env.cluster.writes.length;

    await githubActions.onDependencyChanged(
      env.context(),
      config,
      registry("registry.acme.dev/web") as never,
    );
    const client = await env.cluster.getClient("tooling");
    expect(JSON.stringify(await client.read("get", ref))).toContain(
      "registry.acme.dev/web",
    );

    const after = env.cluster.writes.length;
    expect(after).toBe(writes + 1);
    await githubActions.onDependencyChanged(env.context(), config, {
      id: "metrics.query",
      version: "2.0.0",
      providedBy: "monitoring:prometheus-grafana",
      endpoint: "http://prom",
    } as never);
    expect(env.cluster.writes.length).toBe(after);
  });
});

describe("patch workload (QĐ-4)", () => {
  const state: WorkloadState = {
    metadata: { generation: 3, resourceVersion: "812" },
    spec: {
      replicas: 2,
      template: {
        spec: {
          containers: [
            {
              name: "web",
              image: "ghcr.io/acme/web:old",
              ports: [{ containerPort: 8080 }],
              env: [{ name: "A", value: "1" }],
            },
            { name: "sidecar", image: "envoy:1.30" },
          ],
          imagePullSecrets: [{ name: "khac" }],
        },
      },
    },
  };

  it("mang NGUYÊN mảng containers, chỉ đổi image của đúng container; resourceVersion làm điều kiện", () => {
    const patch = imagePatch(state, "web", "ghcr.io/acme/web:new") as {
      metadata: unknown;
      spec: { template: { spec: Record<string, unknown> } };
    };
    expect(patch.metadata).toEqual({ resourceVersion: "812" });
    expect(patch.spec.template.spec.containers).toEqual([
      {
        name: "web",
        image: "ghcr.io/acme/web:new",
        ports: [{ containerPort: 8080 }],
        env: [{ name: "A", value: "1" }],
      },
      { name: "sidecar", image: "envoy:1.30" },
    ]);
    expect(patch.spec.template.spec.imagePullSecrets).toEqual([
      { name: "khac" },
      { name: "udp-registry-pull" },
    ]);
    // I25: không chạm chiến lược hay số bản
    expect(JSON.stringify(patch)).not.toMatch(/strategy|replicas/);
  });

  it("udp-registry-pull đã có ⇒ không thêm lần hai; container vắng ⇒ null", () => {
    const withPull = imagePatch(
      imagePatch(state, "web", "x:1") as WorkloadState,
      "web",
      "x:2",
    ) as { spec: { template: { spec: { imagePullSecrets: unknown[] } } } };
    expect(withPull.spec.template.spec.imagePullSecrets).toHaveLength(2);
    expect(imagePatch(state, "api", "x:1")).toBeNull();
  });

  it("phán quyết Deployment: chưa quan sát generation mới ⇒ rolling; quá hạn ⇒ stuck", () => {
    const deployment = WORKLOAD_KINDS[0]!;
    const base = { metadata: { generation: 4 }, spec: { replicas: 2 } };
    expect(
      deployment.verdict({
        ...base,
        status: {
          observedGeneration: 3,
          replicas: 2,
          updatedReplicas: 2,
          availableReplicas: 2,
        },
      }),
    ).toBe("rolling");
    expect(
      deployment.verdict({
        ...base,
        status: {
          observedGeneration: 4,
          replicas: 2,
          updatedReplicas: 2,
          availableReplicas: 2,
        },
      }),
    ).toBe("done");
    expect(
      deployment.verdict({
        ...base,
        status: {
          observedGeneration: 4,
          replicas: 3,
          updatedReplicas: 2,
          availableReplicas: 2,
        },
      }),
    ).toBe("rolling");
    expect(
      deployment.verdict({
        ...base,
        status: {
          conditions: [
            {
              type: "Progressing",
              status: "False",
              reason: "ProgressDeadlineExceeded",
            },
          ],
        },
      }),
    ).toBe("stuck");
  });

  it("phán quyết Rollout: Healthy ⇒ done, Degraded ⇒ stuck, observedGeneration là chuỗi", () => {
    const rollout = WORKLOAD_KINDS[1]!;
    const meta = { metadata: { generation: 7 } };
    expect(
      rollout.verdict({
        ...meta,
        status: { observedGeneration: "7", phase: "Healthy" },
      }),
    ).toBe("done");
    expect(
      rollout.verdict({
        ...meta,
        status: { observedGeneration: "6", phase: "Healthy" },
      }),
    ).toBe("rolling");
    expect(rollout.verdict({ ...meta, status: { phase: "Degraded" } })).toBe(
      "stuck",
    );
  });
});
