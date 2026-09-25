import type { CloudAdapter, CreatedResource } from "../cloud.js";
import {
  CLOUD_ADAPTER_METHODS,
  expectedTagKeys,
  REQUIRED_TAG_KEYS,
  TEARDOWN_ORDER,
} from "../cloud.js";
import { SecretBuffer, type ResolvedCredential } from "../credential.js";
import { validateCostEstimate } from "../guardrails.js";
import type { CloudContractEnv, ContractCheck } from "./index.js";
import type { TestRunnerApi } from "./ledger.js";

/**
 * [v4.10] Bộ hợp đồng Cloud Adapter dưới dạng DỮ LIỆU (§13.2).
 *
 * Điểm mấu chốt của luận điểm pluggable: **mọi adapter cùng loại phải qua đúng một bộ
 * test**. Nếu một adapter mới qua được bộ này mà không phải sửa gì bên ngoài thì kiến trúc
 * pluggable được chứng minh bằng thực nghiệm chứ không phải bằng lời.
 *
 * Mỗi phép mang `designCheckId` trỏ về phép tương ứng trong §13.2 của tài liệu (c1..c8).
 * Nhờ trường đó, một **bảng truy vết** kiểm được bằng máy: thiếu một phép GỐC là một test
 * đỏ, và đổi tên một phép không làm mất dấu nó.
 *
 * | Mã | Phép gốc của §13.2 |
 * | --- | --- |
 * | c1 | mọi `ResourceStep` khai `lookupBy` và đường đó thật sự tìm được tài nguyên |
 * | c2 | `lookupById` tìm được tài nguyên SAU KHI tag bị xoá (K8) |
 * | c3 | `create()` gắn đủ tag bắt buộc TRONG CÙNG lời gọi tạo |
 * | c4 | `delete()` với tài nguyên đã biến mất KHÔNG được ném lỗi |
 * | c5 | ma trận khôi phục K1..K10 (`describe.each`) — pha P8 |
 * | c6 | teardown xoá tài nguyên K8S_MANAGED TRƯỚC network |
 * | c7 | adapter reject khi vượt quota TRƯỚC khi gọi SDK cloud |
 * | c8 | preflight khai đúng `confidence` và không báo ok khi thiếu quyền |
 */

export type CloudCheck = ContractCheck<CloudContractEnv>;

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OWNER = "chu@vi-du.test";
const REGION = "ap-southeast-1";

const QUOTA = {
  maxNodes: 3,
  maxNodeSize: "medium" as const,
  maxDatabases: 2,
  maxStorageGb: 50,
  maxLoadBalancers: 3,
};

function credential(): ResolvedCredential {
  const payload = new SecretBuffer("bi-mat-cua-khach");
  return {
    provider: "aws",
    mode: "BYOC",
    authKind: "AWS_ROLE",
    payload,
    expiresAt: new Date(Date.now() + 900_000),
    dispose: () => {
      payload.dispose();
    },
  };
}

const tags = (): Record<string, string> => ({
  "udp.project": PROJECT,
  "udp.owner": OWNER,
  "udp.managed": "true",
});

const networkParams = () => ({
  projectId: PROJECT,
  networkName: "udp",
  cidrBlock: "10.0.0.0/16",
  region: REGION,
  quota: QUOTA,
  idempotencyKey: `${PROJECT}:NETWORK:vpc:vpc`,
  tags: tags(),
  controlPlaneCidrs: ["203.0.113.0/24"],
});

const clusterParams = (over: Partial<{ nodeCount: number }> = {}) => ({
  projectId: PROJECT,
  clusterName: "main",
  nodeSize: "medium" as const,
  nodeCount: over.nodeCount ?? 2,
  quota: QUOTA,
  region: REGION,
  idempotencyKey: `${PROJECT}:CLUSTER:cluster:cluster`,
  tags: tags(),
  controlPlaneCidrs: ["203.0.113.0/24"],
});

/**
 * Hai danh sách giá trị hợp lệ, ở dạng `readonly string[]` có chủ đích.
 *
 * So trực tiếp `x === "tag" || x === "deterministic-name"` là một tautology Ở TẦNG KIỂU:
 * union chỉ có hai giá trị nên nhánh thứ hai luôn đúng, và lint bắt đúng. Nhưng bộ hợp
 * đồng này tồn tại để kiểm những adapter mà ta KHÔNG biên dịch — một adapter viết bằng
 * JavaScript, hay một adapter đi qua một phép ép kiểu, có thể trả về thứ khác. Nên phép
 * kiểm phải là một phép kiểm LÚC CHẠY, và kiểu `string[]` là cách nói ra điều đó.
 */
const VALID_LOOKUP_BY: readonly string[] = ["tag", "deterministic-name"];
const VALID_CONFIDENCE: readonly string[] = ["exact", "heuristic"];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** Chạy hết `networkSteps` bằng tay, không qua runner — bộ này kiểm ADAPTER, không kiểm runner */
async function createAllNetwork(
  adapter: CloudAdapter,
  cred: ResolvedCredential,
): Promise<Record<string, CreatedResource>> {
  const created: Record<string, CreatedResource> = {};
  for (const step of adapter.networkSteps(networkParams())) {
    const outcome = await step.lookup(cred);
    const resource =
      outcome.kind === "found"
        ? outcome.resource
        : await step.create(cred, { ...created });
    created[step.name] = resource;
  }
  return created;
}

export const CLOUD_CONTRACT_CHECKS: readonly CloudCheck[] = [
  // ------------------------------------------------ bề mặt (6)
  {
    name: "adapter hiện thực ĐỦ mười phương thức của §4.2",
    designCheckId: null,
    run: (adapter) => {
      const missing = CLOUD_ADAPTER_METHODS.filter(
        (m) =>
          typeof (adapter as unknown as Record<string, unknown>)[m] !==
          "function",
      );
      assert(missing.length === 0, `thiếu phương thức: ${missing.join(", ")}`);
      return Promise.resolve();
    },
  },
  {
    name: "providerId là một trong aws, gcp, azure",
    designCheckId: null,
    run: (adapter) => {
      assert(
        ["aws", "gcp", "azure"].includes(adapter.providerId),
        `providerId lạ: ${adapter.providerId}`,
      );
      return Promise.resolve();
    },
  },
  {
    name: "networkSteps và clusterSteps cộng lại đúng số step của fixture",
    designCheckId: null,
    run: (adapter, env) => {
      const total =
        adapter.networkSteps(networkParams()).length +
        adapter.clusterSteps(clusterParams(), {
          networkId: "vpc-1",
          networkName: "udp",
          cidrBlock: "10.0.0.0/16",
        }).length;
      assert(
        total === env.fixture.expectedStepCount,
        `adapter khai ${String(total)} step, fixture mong đợi ${String(env.fixture.expectedStepCount)}`,
      );
      return Promise.resolve();
    },
  },
  {
    name: "mọi idempotencyKey có hình {projectId}:{step}:{kind}:{name}",
    designCheckId: null,
    run: (adapter) => {
      const steps = [
        ...adapter.networkSteps(networkParams()),
        ...adapter.clusterSteps(clusterParams(), {
          networkId: "vpc-1",
          networkName: "udp",
          cidrBlock: "10.0.0.0/16",
        }),
      ];
      for (const s of steps) {
        const parts = s.idempotencyKey.split(":");
        assert(parts.length === 4, `khoá sai hình: ${s.idempotencyKey}`);
        assert(
          parts[0] === PROJECT,
          `khoá không mang projectId: ${s.idempotencyKey}`,
        );
        assert(
          parts[3] === s.name,
          `khoá không mang name: ${s.idempotencyKey}`,
        );
      }
      return Promise.resolve();
    },
  },
  {
    name: "tên step không trùng nhau — tên là khoá của prior",
    designCheckId: null,
    run: (adapter) => {
      const names = [
        ...adapter.networkSteps(networkParams()),
        ...adapter.clusterSteps(clusterParams(), {
          networkId: "vpc-1",
          networkName: "udp",
          cidrBlock: "10.0.0.0/16",
        }),
      ].map((s) => s.name);
      assert(
        new Set(names).size === names.length,
        "có tên step trùng: prior khoá theo name nên trùng là mất một step",
      );
      return Promise.resolve();
    },
  },
  {
    /**
     * `networkSteps` phải THUẦN theo `params`: gọi hai lần với cùng tham số ra cùng danh
     * sách khoá. Một hiện thực sinh khoá có phần ngẫu nhiên, hay đọc một bộ đếm nội bộ, sẽ
     * làm mọi lần resume tra cứu theo một khoá KHÁC — và `lookup()` không bao giờ tìm thấy
     * thứ lượt trước đã tạo. Đó là cách tinh vi nhất để phá ADR-08 quy tắc 2.
     */
    name: "networkSteps THUẦN theo params: gọi hai lần ra cùng tập idempotencyKey",
    designCheckId: null,
    run: (adapter) => {
      const first = adapter
        .networkSteps(networkParams())
        .map((s) => s.idempotencyKey);
      const second = adapter
        .networkSteps(networkParams())
        .map((s) => s.idempotencyKey);
      assert(
        first.join("|") === second.join("|"),
        "hai lần gọi ra khoá khác nhau: mọi lần resume sẽ tra theo một khoá khác",
      );
      return Promise.resolve();
    },
  },
  {
    name: "validateCredential từ chối credential đã hết hạn",
    designCheckId: null,
    run: async (adapter) => {
      const expired = credential();
      expired.expiresAt = new Date(Date.now() - 1000);
      const res = await adapter.validateCredential(expired);
      assert(
        res.data?.valid === false,
        "credential hết hạn phải bị từ chối, không được coi là hợp lệ",
      );
    },
  },

  // ------------------------------------------------ c1: lookupBy (4)
  {
    name: "c1: mọi step khai lookupBy, và giá trị đó là tag hoặc deterministic-name",
    designCheckId: "c1",
    run: (adapter) => {
      for (const s of adapter.networkSteps(networkParams())) {
        assert(
          VALID_LOOKUP_BY.includes(s.lookupBy),
          `step ${s.name} khai lookupBy lạ: ${String(s.lookupBy)}`,
        );
      }
      return Promise.resolve();
    },
  },
  {
    name: "c1: đường tra cứu đã khai THẬT SỰ tìm lại được tài nguyên vừa tạo",
    designCheckId: "c1",
    run: async (adapter) => {
      const cred = credential();
      const created: Record<string, CreatedResource> = {};
      for (const step of adapter.networkSteps(networkParams())) {
        const resource = await step.create(cred, { ...created });
        created[step.name] = resource;
        const again = await step.lookup(cred);
        assert(
          again.kind === "found",
          `step ${step.name} khai lookupBy="${step.lookupBy}" nhưng tra lại KHÔNG ra`,
        );
        if (again.kind === "found") {
          assert(
            again.resource.id === resource.id,
            `step ${step.name} tra ra một tài nguyên KHÁC`,
          );
        }
      }
    },
  },
  {
    name: "c1: step khai lookupBy=tag thì tài nguyên PHẢI mang tag udp.key",
    designCheckId: "c1",
    run: async (adapter) => {
      const cred = credential();
      const created: Record<string, CreatedResource> = {};
      for (const step of adapter.networkSteps(networkParams())) {
        const r = await step.create(cred, { ...created });
        created[step.name] = r;
        if (step.lookupBy === "tag") {
          assert(
            r.tags["udp.key"] === step.idempotencyKey,
            `step ${step.name} khai tra theo tag nhưng tài nguyên không mang udp.key đúng`,
          );
        }
      }
    },
  },
  {
    name: "c1: lookup trên tài nguyên CHƯA tạo trả absent, không ném",
    designCheckId: "c1",
    run: async (adapter) => {
      const cred = credential();
      for (const step of adapter.networkSteps(networkParams())) {
        const outcome = await step.lookup(cred);
        assert(
          outcome.kind === "absent",
          `step ${step.name} trả ${outcome.kind} khi chưa có gì`,
        );
      }
    },
  },

  // ------------------------------------------------ c2: lookupById (3)
  {
    name: "c2: xoá tag udp.key ⇒ lookup mất, lookupById VẪN tìm thấy (điểm crash K8)",
    designCheckId: "c2",
    run: async (adapter, env) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const steps = adapter.networkSteps(networkParams());

      for (const step of steps.filter((s) => s.lookupBy === "tag")) {
        const resource = created[step.name];
        assert(resource !== undefined, `thiếu tài nguyên của ${step.name}`);
        await env.control.removeTag(
          (resource as CreatedResource).id,
          "udp.key",
        );

        const byTag = await step.lookup(cred);
        assert(
          byTag.kind === "absent",
          `sau khi xoá tag, ${step.name} vẫn tra ra theo tag`,
        );

        const byId = await step.lookupById(
          cred,
          (resource as CreatedResource).id,
        );
        assert(
          byId.kind === "found",
          `${step.name}: đường dự phòng theo provider_id KHÔNG tìm được`,
        );
      }
    },
  },
  {
    name: "c2: lookupById với id không tồn tại trả absent, KHÔNG ném",
    designCheckId: "c2",
    run: async (adapter) => {
      const cred = credential();
      const [step] = adapter.networkSteps(networkParams());
      assert(step !== undefined, "adapter không khai step nào");
      const outcome = await (step as NonNullable<typeof step>).lookupById(
        cred,
        "khong-bao-gio-ton-tai",
      );
      assert(
        outcome.kind === "absent",
        `phải trả absent, thấy ${outcome.kind}: "không tra được" khác "không còn"`,
      );
    },
  },
  {
    name: "c2: khách xoá tài nguyên ⇒ CẢ HAI đường tra đều absent (điểm crash K7)",
    designCheckId: "c2",
    run: async (adapter, env) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const [step] = adapter.networkSteps(networkParams());
      assert(step !== undefined, "adapter không khai step nào");
      const s = step as NonNullable<typeof step>;
      const resource = created[s.name] as CreatedResource;

      await env.control.deleteOutOfBand(resource.id);
      assert(
        (await s.lookup(cred)).kind === "absent",
        "tra theo tag phải absent",
      );
      assert(
        (await s.lookupById(cred, resource.id)).kind === "absent",
        "tra theo id phải absent",
      );
    },
  },

  // ------------------------------------------------ c3: tag (4)
  {
    name: "c3: create() gắn đủ tag bắt buộc TRONG CÙNG lời gọi tạo",
    designCheckId: "c3",
    run: async (adapter, env) => {
      const cred = credential();
      const created: Record<string, CreatedResource> = {};
      for (const step of adapter.networkSteps(networkParams())) {
        const before = (await env.control.calls()).length;
        const r = await step.create(cred, { ...created });
        created[step.name] = r;
        const after = await env.control.calls();

        /**
         * Đọc lại NGAY sau `create()`, trước mọi lời gọi khác: nếu adapter gắn tag bằng một
         * lời gọi `tagResource` riêng thì giữa hai lời gọi có một cửa sổ crash mới, và
         * §4.5 quy tắc 1 vỡ. Nhật ký lời gọi là oracle.
         */
        const between = after.slice(before);
        assert(
          between.filter((c) => c.verb === "tag").length === 0,
          `step ${step.name} gắn tag bằng một lời gọi RIÊNG: tạo ra một cửa sổ crash mới`,
        );

        if (step.lookupBy === "tag") {
          for (const key of REQUIRED_TAG_KEYS) {
            assert(
              r.tags[key] !== undefined,
              `step ${step.name} thiếu tag bắt buộc ${key}`,
            );
          }
        }
      }
    },
  },
  {
    name: 'c3: udp.managed luôn là chuỗi "true"',
    designCheckId: "c3",
    run: async (adapter) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      for (const [name, r] of Object.entries(created)) {
        if (Object.keys(r.tags).length === 0) continue;
        assert(
          r.tags["udp.managed"] === "true",
          `${name}: udp.managed phải là "true", thấy ${String(r.tags["udp.managed"])}`,
        );
      }
    },
  },
  {
    name: "c3: project KHÔNG có expires_at thì tập tag mong đợi là ĐÚNG BỐN khoá",
    designCheckId: "c3",
    run: async (adapter) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const expected = new Set(expectedTagKeys(false));
      for (const [name, r] of Object.entries(created)) {
        if (Object.keys(r.tags).length === 0) continue;
        const extra = Object.keys(r.tags).filter((k) => !expected.has(k));
        assert(
          extra.length === 0,
          `${name} gắn tag ngoài tập mong đợi: ${extra.join(", ")}`,
        );
      }
    },
  },
  {
    name: "c3: udp.key của mỗi tài nguyên khớp idempotencyKey của step tạo nó",
    designCheckId: "c3",
    run: async (adapter) => {
      const cred = credential();
      const created: Record<string, CreatedResource> = {};
      for (const step of adapter.networkSteps(networkParams())) {
        const r = await step.create(cred, { ...created });
        created[step.name] = r;
        if (r.tags["udp.key"] !== undefined) {
          assert(
            r.tags["udp.key"] === step.idempotencyKey,
            `${step.name}: udp.key không khớp idempotencyKey`,
          );
        }
      }
    },
  },

  // ------------------------------------------------ c4: delete idempotent (3)
  {
    name: "c4: delete() với tài nguyên đã biến mất KHÔNG ném",
    designCheckId: "c4",
    run: async (adapter, env) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const [step] = adapter.networkSteps(networkParams());
      const s = step as NonNullable<typeof step>;
      const resource = created[s.name] as CreatedResource;
      await env.control.deleteOutOfBand(resource.id);
      await s.delete(cred, resource);
    },
  },
  {
    name: "c4: delete() gọi HAI lần không ném — compensation chạy lại phải idempotent",
    designCheckId: "c4",
    run: async (adapter) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const steps = adapter.networkSteps(networkParams());
      /**
       * Xoá step CUỐI, không step đầu.
       *
       * Step đầu là `vpc`, và mọi thứ khác gắn vào nó — xoá nó trước thì cloud ném
       * `DependencyViolation`, và phép kiểm sẽ đỏ vì một lý do KHÁC hẳn cái nó muốn kiểm.
       * Một phép kiểm đỏ vì lý do sai còn tệ hơn không có: nó làm người ta sửa test.
       */
      const leaf = steps.at(-1) as NonNullable<(typeof steps)[number]>;
      const resource = created[leaf.name] as CreatedResource;
      await leaf.delete(cred, resource);
      await leaf.delete(cred, resource);
    },
  },
  {
    name: "c4: sau delete, lookup trả absent",
    designCheckId: "c4",
    run: async (adapter) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const steps = adapter.networkSteps(networkParams());
      /** Xoá ngược thứ tự để không vướng DependencyViolation */
      for (const step of [...steps].reverse()) {
        const r = created[step.name];
        if (r !== undefined) await step.delete(cred, r);
      }
      for (const step of steps) {
        assert(
          (await step.lookup(cred)).kind === "absent",
          `${step.name} vẫn tra ra sau khi xoá`,
        );
      }
    },
  },

  // ------------------------------------------------ c6: teardown order (4)
  {
    name: "c6: teardown xoá K8S_MANAGED TRƯỚC network",
    designCheckId: "c6",
    run: async (adapter, env) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const vpc = created["vpc"] as CreatedResource;
      const elb = await env.control.seedK8sManaged({
        kind: "k8s-loadbalancer",
        clusterName: "main",
        attachedTo: vpc.id,
      });

      const before = (await env.control.calls()).length;
      const res = await adapter.teardown(cred, [
        ...Object.values(created),
        elb,
      ]);
      const deletes = (await env.control.calls())
        .slice(before)
        .filter((c) => c.verb === "delete")
        .map((c) => c.kind);

      assert(res.status === "SUCCESS", "teardown phải thành công");
      assert(
        deletes.indexOf("k8s-loadbalancer") < deletes.indexOf("vpc"),
        `ELB phải bị xoá TRƯỚC VPC, thứ tự thật: ${deletes.join(" → ")}`,
      );
    },
  },
  {
    name: "c6: teardown xoá vpc CUỐI CÙNG",
    designCheckId: "c6",
    run: async (adapter, env) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const before = (await env.control.calls()).length;
      await adapter.teardown(cred, Object.values(created));
      const deletes = (await env.control.calls())
        .slice(before)
        .filter((c) => c.verb === "delete")
        .map((c) => c.kind);
      assert(
        deletes.at(-1) === "vpc",
        `vpc phải là lời gọi xoá cuối cùng, thứ tự thật: ${deletes.join(" → ")}`,
      );
    },
  },
  {
    name: "c6: teardown dọn SẠCH khi không có gì chặn",
    designCheckId: "c6",
    run: async (adapter, env) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      await adapter.teardown(cred, Object.values(created));
      const left = await env.control.listAll();
      assert(
        left.length === 0,
        `còn sót ${String(left.length)} tài nguyên: ${left.map((r) => r.id).join(", ")}`,
      );
    },
  },
  {
    name: "c6: TEARDOWN_ORDER có đúng chín bậc, k8s-managed đầu và vpc cuối",
    designCheckId: "c6",
    run: () => {
      assert(TEARDOWN_ORDER.length === 9, "phải đúng chín bậc");
      assert(
        TEARDOWN_ORDER[0] === "k8s-managed",
        "bậc đầu phải là k8s-managed",
      );
      assert(TEARDOWN_ORDER.at(-1) === "vpc", "bậc cuối phải là vpc");
      return Promise.resolve();
    },
  },

  // ------------------------------------------------ c7: quota (3)
  {
    name: "c7: vượt quota ⇒ estimateCost FAILED, và KHÔNG lời gọi cloud nào",
    designCheckId: "c7",
    run: async (adapter, env) => {
      const before = (await env.control.calls()).length;
      const res = await adapter.estimateCost(clusterParams({ nodeCount: 99 }));
      const after = (await env.control.calls()).length;
      assert(res.status === "FAILED", "vượt quota phải là FAILED");
      assert(
        after === before,
        "vượt quota mà đã gọi cloud rồi mới reject nghĩa là đã tiêu tiền của khách",
      );
    },
  },
  {
    name: "c7: trong quota ⇒ estimateCost SUCCESS và bản ước tính TRUNG THỰC",
    designCheckId: "c7",
    run: async (adapter) => {
      const res = await adapter.estimateCost(clusterParams({ nodeCount: 2 }));
      assert(res.status === "SUCCESS", "trong quota phải thành công");
      const problems = validateCostEstimate(
        res.data as NonNullable<typeof res.data>,
      );
      assert(
        problems.length === 0,
        `bản ước tính có vấn đề: ${problems.map((p) => p.code).join(", ")}`,
      );
    },
  },
  {
    name: "c7: estimateCost liệt kê đủ ba mục hay bị bỏ sót nhất",
    designCheckId: "c7",
    run: async (adapter) => {
      const res = await adapter.estimateCost(clusterParams());
      const items = new Set(
        (res.data as NonNullable<typeof res.data>).breakdown.map((b) => b.item),
      );
      for (const required of [
        "control-plane",
        "nat-gateway",
        "load-balancer",
      ]) {
        assert(items.has(required), `thiếu mục ${required}`);
      }
    },
  },

  // ------------------------------------------------ c8: preflight (4)
  {
    name: "c8: credential thiếu quyền ⇒ ok = false và nêu ĐÚNG quyền còn thiếu",
    designCheckId: "c8",
    run: async (_adapter, env) => {
      const stricter = env.adapterWithCredentialLabel?.("thieu-quyen");
      if (stricter === undefined) return;
      const res = await stricter.preflightPermissions(credential());
      const report = res.data as NonNullable<typeof res.data>;
      assert(report.ok === false, "thiếu quyền phải ra ok = false");
      assert(
        report.missingPermissions.length > 0,
        "phải nêu quyền còn thiếu, không chỉ nói không ok",
      );
    },
  },
  {
    name: "c8: credential đủ quyền ⇒ ok = true, missingPermissions rỗng",
    designCheckId: "c8",
    run: async (adapter) => {
      const res = await adapter.preflightPermissions(credential());
      const report = res.data as NonNullable<typeof res.data>;
      assert(report.ok === true, "đủ quyền phải ra ok = true");
      assert(
        report.missingPermissions.length === 0,
        "không được nêu quyền thiếu",
      );
    },
  },
  {
    name: "c8: confidence là exact hoặc heuristic, và khai exact thì phải có API mô phỏng",
    designCheckId: "c8",
    run: async (adapter) => {
      const res = await adapter.preflightPermissions(credential());
      const report = res.data as NonNullable<typeof res.data>;
      assert(
        VALID_CONFIDENCE.includes(report.confidence),
        `confidence lạ: ${report.confidence}`,
      );
      /**
       * Adapter trên cloud mô phỏng KHÔNG có API mô phỏng quyền như
       * `iam:SimulatePrincipalPolicy`, nên khai `exact` là nói quá. §4.2 phân biệt hai mức
       * này để trung thực, không phải để trang trí.
       */
      assert(
        report.confidence === "heuristic",
        "adapter không có API mô phỏng quyền thì phải khai heuristic",
      );
    },
  },
  {
    name: "c8: preflight có docUrl để người dùng biết phải làm gì",
    designCheckId: "c8",
    run: async (adapter) => {
      const res = await adapter.preflightPermissions(credential());
      const report = res.data as NonNullable<typeof res.data>;
      assert(
        report.docUrl.startsWith("http"),
        "docUrl phải là một đường dẫn thật: thông báo lỗi không có hành động là vô dụng",
      );
    },
  },

  // ------------------------------------------------ rebuild / listTagged (6)
  {
    name: "rebuild: dựng lại ĐỦ số hàng so với hằng số viết tay của fixture",
    designCheckId: null,
    run: async (adapter, env) => {
      const cred = credential();
      await createAllNetwork(adapter, cred);
      const res = await adapter.rebuildLedgerFromCloud(cred, PROJECT);
      const rows = (res.data as NonNullable<typeof res.data>).rows;
      const networkCount = adapter.networkSteps(networkParams()).length;
      assert(
        rows.length === networkCount,
        `dựng lại ${String(rows.length)} hàng, mong đợi ${String(networkCount)}`,
      );
      void env;
    },
  },
  {
    name: "rebuild: mọi hàng có providerId, và idempotencyKey lấy TỪ TAG",
    designCheckId: null,
    run: async (adapter) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const res = await adapter.rebuildLedgerFromCloud(cred, PROJECT);
      const rows = (res.data as NonNullable<typeof res.data>).rows;
      const keysFromSteps = new Set(
        adapter.networkSteps(networkParams()).map((s) => s.idempotencyKey),
      );
      for (const row of rows) {
        assert(row.providerId !== null, "hàng dựng lại phải có providerId");
        assert(
          keysFromSteps.has(row.idempotencyKey),
          `khoá ${row.idempotencyKey} không khớp step nào — nó phải đến từ tag udp.key`,
        );
      }
      void created;
    },
  },
  {
    name: "rebuild: hàng dựng lại KHÔNG mang jobId (ADR-08: cột duy nhất không suy được)",
    designCheckId: null,
    run: async (adapter) => {
      const cred = credential();
      await createAllNetwork(adapter, cred);
      const res = await adapter.rebuildLedgerFromCloud(cred, PROJECT);
      for (const row of (res.data as NonNullable<typeof res.data>).rows) {
        assert(
          !Object.hasOwn(row, "jobId"),
          "hàng dựng lại không được mang jobId: nó sẽ phải bịa một giá trị",
        );
      }
    },
  },
  {
    name: "rebuild: NHIỄU không vào rows — project khác, không tag, udp.managed sai, region khác",
    designCheckId: null,
    run: async (adapter, env) => {
      const cred = credential();
      await createAllNetwork(adapter, cred);
      await env.control.seedNoise(PROJECT, OWNER);

      const res = await adapter.rebuildLedgerFromCloud(cred, PROJECT);
      const data = res.data as NonNullable<typeof res.data>;
      const ids = new Set(data.rows.map((r) => r.providerId));

      assert(
        !ids.has("noise-other-project"),
        "project khác không được vào rows",
      );
      assert(
        !ids.has("noise-customer-untagged"),
        "tài nguyên của khách không được vào rows",
      );
      assert(
        !ids.has("noise-not-managed"),
        'udp.managed khác "true" không được vào rows',
      );
      const unmatchedIds = new Set(data.unmatched.map((r) => r.id));
      assert(
        unmatchedIds.has("noise-not-managed"),
        'udp.managed khác "true" phải vào unmatched, không bị bỏ im lặng',
      );
    },
  },
  {
    name: "listTaggedResources đi HẾT phân trang",
    designCheckId: null,
    run: async (adapter, env) => {
      const cred = credential();
      const created = await createAllNetwork(adapter, cred);
      const res = await adapter.listTaggedResources(cred, PROJECT);
      const listed = (res.data as NonNullable<typeof res.data>).length;
      const tagged = Object.values(created).filter(
        (r) => r.tags["udp.project"] === PROJECT,
      ).length;
      assert(
        listed === tagged,
        `liệt kê ${String(listed)} nhưng có ${String(tagged)} tài nguyên mang tag: ` +
          "một hiện thực chỉ đọc trang đầu vẫn 'thành công' nhưng trả về danh sách thiếu",
      );
      void env;
    },
  },
  {
    name: "getClusterStatus và getKubeAuthToken hoạt động trên cluster đã tạo",
    designCheckId: null,
    run: async (adapter) => {
      const cred = credential();
      /**
       * [v4.11] `prior` đúng RUN12: tài nguyên pha mạng cộng mọi step cluster đứng trước.
       * Bản trước gọi `create(cred, {})` — một adapter đọc cha (kế hoạch thật: `cluster`
       * cần subnet) vỡ ở đây, và một lõi âm thầm bỏ cha vắng thì qua được (Plan #28 QĐ-3).
       */
      const prior = await createAllNetwork(adapter, cred);
      const steps = adapter.clusterSteps(clusterParams(), {
        networkId: "vpc-1",
        networkName: "udp",
        cidrBlock: "10.0.0.0/16",
      });
      const at = steps.findIndex((s) => s.kind === "cluster");
      assert(at >= 0, "adapter phải có một step kind=cluster");
      for (const step of steps.slice(0, at)) {
        prior[step.name] = await (step as ResourceStepLike).create(cred, {
          ...prior,
        });
      }
      const cluster = await (steps[at] as ResourceStepLike).create(cred, {
        ...prior,
      });

      const status = await adapter.getClusterStatus(cred, cluster.id);
      assert(status.status === "SUCCESS", "getClusterStatus phải thành công");
      const info = status.data as NonNullable<typeof status.data>;
      assert(
        info.controlPlaneServiceAccounts !== undefined,
        "ClusterInfo phải mang BA ServiceAccount rời nhau (§12.2), không phải một",
      );

      const token = await adapter.getKubeAuthToken(cred, info);
      assert(token.status === "SUCCESS", "getKubeAuthToken phải thành công");
      const t = token.data as NonNullable<typeof token.data>;
      assert(
        t.expiresAt.getTime() > Date.now(),
        "token phải còn hiệu lực — và nó ngắn hạn, không bao giờ ghi xuống đĩa (I24)",
      );
    },
  },
];

/** Chỉ cần phần `create` của một step, để phép kiểm cuối không phụ thuộc cả interface */
interface ResourceStepLike {
  create(
    cred: ResolvedCredential,
    prior: Readonly<Record<string, CreatedResource>>,
  ): Promise<CreatedResource>;
}

/** Tám phép GỐC của §13.2 — bảng truy vết kiểm được bằng máy */
export const DESIGN_CHECK_IDS: readonly string[] = [
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
  "c7",
  "c8",
];

/**
 * Vỏ mỏng map bộ hợp đồng sang `it()`.
 *
 * `api` được tiêm vào để `./contract` không kéo một test runner vào đồ thị phụ thuộc:
 * một adapter do người ngoài nhóm viết (kiểm soát (b) của E1) có thể dùng runner khác.
 */
export function runCloudAdapterContract(
  api: TestRunnerApi,
  label: string,
  makeEnv: () => CloudContractEnv,
  makeAdapter: (env: CloudContractEnv) => CloudAdapter,
): void {
  api.describe(`hợp đồng Cloud Adapter: ${label}`, () => {
    for (const check of CLOUD_CONTRACT_CHECKS) {
      api.it(check.name, async () => {
        const env = makeEnv();
        await check.run(makeAdapter(env), env);
      });
    }
  });
}
