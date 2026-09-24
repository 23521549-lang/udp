import type { CloudAdapter, CreatedResource } from "../cloud.js";
import { SecretBuffer, type ResolvedCredential } from "../credential.js";
import type { ProvisionedResourceRow } from "../ledger.js";
import {
  CloudAdapterRunner,
  SimulatedCrash,
  type Ledger,
  type RunnerObserver,
  type RunOutcome,
  type RunPlan,
} from "../runner/index.js";
import type { CloudContractEnv } from "./index.js";

/**
 * [v4.10] Lưới khôi phục K1..K10 — phép `c5` của §13.2, và bằng chứng của đóng góp C3.
 *
 * Vì sao lưới nằm TRONG bộ hợp đồng chứ không chỉ trong E15: E15 là một **phép đo một lần**
 * để viết vào luận văn; bộ hợp đồng là **cổng chặn hồi quy** chạy cho mọi adapter viết sau,
 * kể cả adapter viết sau khi đã đo. Nếu chỉ có E15 thì Cloud Adapter thứ ba có thể vi phạm
 * hợp đồng mà không ai biết, và câu "khung adapter cưỡng chế ngữ nghĩa thất bại" thành ra
 * chỉ đúng với hai adapter đầu (§13.2).
 *
 * **Hai tầng, và tiêu chí chia tầng là BẢN CHẤT Ô, không phải chi phí.**
 *
 * Bốn ô `child-only` (K3, K6, K9, K10) khẳng định những tính chất của **sổ bền** hoặc của
 * **một tiến trình thật đã chết**, nên chạy chúng in-process với sổ trong bộ nhớ là một ô
 * RỖNG NGHĨA — nó xanh, nhưng nó đang chứng minh một thứ khác. Chúng bị loại khỏi tầng 1
 * bằng dữ liệu (`tier`), không bằng một quy ước trong thân test, và một meta-test khẳng
 * định điều đó.
 *
 * Ba khẳng định của I31, và cả ba đều cần cho một ô có nghĩa:
 *
 *  (a) `listTaggedResources()` trả về **đúng** số tài nguyên so với một HẰNG SỐ VIẾT TAY —
 *      không suy từ `steps.length`, vì suy từ hiện thực là một tautology.
 *  (b) Không hàng nào kẹt ở `CREATING` hay `CREATED`.
 *  (c) Không tài nguyên nào mang `udp.project` mà thiếu hàng trong sổ.
 */

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

const clusterParams = () => ({
  projectId: PROJECT,
  clusterName: "main",
  nodeSize: "medium" as const,
  nodeCount: 2,
  quota: QUOTA,
  region: REGION,
  idempotencyKey: `${PROJECT}:CLUSTER:cluster:cluster`,
  tags: tags(),
  controlPlaneCidrs: ["203.0.113.0/24"],
});

/** Đúng tập step mà một lần provision đầy đủ chạy, theo hai bước của §2.2 */
export function plansOf(adapter: CloudAdapter): RunPlan[] {
  const cred = credential();
  const network = adapter.networkSteps(networkParams());
  const cluster = adapter.clusterSteps(clusterParams(), {
    networkId: "sinh-luc-chay",
    networkName: "udp",
    cidrBlock: "10.0.0.0/16",
  });
  return [
    {
      projectId: PROJECT,
      provider: "aws",
      region: REGION,
      step: "NETWORK",
      steps: network,
      credential: cred,
      quota: QUOTA,
    },
    {
      projectId: PROJECT,
      provider: "aws",
      region: REGION,
      step: "CLUSTER",
      steps: cluster,
      credential: cred,
      quota: QUOTA,
    },
  ];
}

/** Tên step theo đúng thứ tự chạy, phẳng qua cả hai bước */
export function flatStepNames(adapter: CloudAdapter): string[] {
  return plansOf(adapter).flatMap((p) => p.steps.map((s) => s.name));
}

/**
 * Chạy một lượt provision đầy đủ, với một observer tiêm vào.
 *
 * Mỗi lượt dựng một thực thể `CloudAdapterRunner` MỚI. Sổ và cloud thì sống qua các lượt —
 * đó là toàn bộ nội dung của ADR-08: cái chết là runner, cái sống là sổ (gợi ý thứ tự) và
 * tag (nguồn sự thật).
 */
export async function runFullProvision(args: {
  adapter: CloudAdapter;
  ledger: Ledger;
  observer: RunnerObserver;
}): Promise<RunOutcome[]> {
  const outcomes: RunOutcome[] = [];
  for (const plan of plansOf(args.adapter)) {
    const runner = new CloudAdapterRunner({
      ledger: args.ledger,
      fence: { assert: () => Promise.resolve() },
      observer: args.observer,
      sleep: () => Promise.resolve(),
    });
    const outcome = await runner.run(plan);
    outcomes.push(outcome);
    if (outcome.status !== "SUCCESS") break;
  }
  return outcomes;
}

/** Observer ném `SimulatedCrash` đúng một lần, ở đúng pha của đúng step */
export function crashingObserver(target: {
  phase: string;
  stepName: string;
}): RunnerObserver {
  let fired = false;
  return {
    onPhase(phase, stepName) {
      if (fired) return;
      if (phase === target.phase && stepName === target.stepName) {
        fired = true;
        throw new SimulatedCrash(phase);
      }
    },
  };
}

const silent: RunnerObserver = {
  onPhase() {
    /* không làm gì */
  },
};

export interface GridAssertion {
  taggedCount: number;
  stuck: readonly ProvisionedResourceRow[];
  orphanOnCloud: readonly string[];
  /** Hang song co `provider_id` KHONG con tren cloud (chieu khong phu thuoc tag) */
  danglingRows: readonly string[];
  rows: readonly ProvisionedResourceRow[];
}

/**
 * Ba khẳng định của I31, đo trên trạng thái CUỐI.
 *
 * `taggedCount` đếm tài nguyên mang `udp.project` — nó là (a). `stuck` là (b). `orphanOnCloud`
 * là (c): tài nguyên trên cloud mà sổ không có hàng nào trỏ tới.
 */
export async function measureConvergence(args: {
  adapter: CloudAdapter;
  ledger: Ledger;
  env: CloudContractEnv;
}): Promise<GridAssertion> {
  const cred = credential();
  const listed = await args.adapter.listTaggedResources(cred, PROJECT);
  const tagged = listed.data ?? [];
  const rows = await args.ledger.rowsOf(PROJECT);

  const knownIds = new Set(
    rows.map((r) => r.providerId).filter((id): id is string => id !== null),
  );
  /**
   * Tài nguyên không gắn được tag lúc tạo (§4.5 quy tắc 2) không xuất hiện trong
   * `listTaggedResources`, nên (c) đếm trên `listAll` và bỏ qua nhiễu của O-2.
   */
  const all = await args.env.control.listAll();
  const ours = all.filter((r) => r.tags["udp.project"] === PROJECT);

  /**
   * Chiều ngược của `orphanOnCloud`, và là chiều KHÔNG phụ thuộc tag.
   *
   * `orphanOnCloud` đếm trên `udp.project`, nên nó MÙ với những kind không gắn được
   * tag lúc tạo: hợp đồng §13.2 cấm gắn tag bằng một lời gọi riêng (lời gọi đó tạo
   * thêm một cửa sổ crash), nên `route-table` không bao giờ CÓ tag — và đó là hành vi
   * đúng, không phải thiếu sót của bản mô phỏng.
   *
   * Hệ quả: nếu chỉ có `orphanOnCloud` thì mỗi ô của lưới có đúng MỘT kind nằm
   * ngoài tầm kiểm, và ô `K7@rtb-public` xanh vì không thấy gì chứ không vì không có gì
   * — loại xanh tệ nhất. `danglingRows` đếm theo `provider_id` của SỔ, nên nó thấy
   * mọi kind, và nó chính là tính chất mà teardown dựa vào: xoá theo `provider_id`
   * trong sổ thì mọi id trong sổ phải trỏ tới thứ còn sống.
   */
  const liveIds = new Set(all.map((r) => r.id));
  const dangling = rows.filter(
    (r) =>
      (r.status === "READY" || r.status === "CREATED") &&
      r.providerId !== null &&
      !liveIds.has(r.providerId),
  );

  return {
    taggedCount: tagged.length,
    stuck: rows.filter((r) => r.status === "CREATING" || r.status === "CREATED"),
    orphanOnCloud: ours.filter((r) => !knownIds.has(r.id)).map((r) => r.id),
    danglingRows: dangling.map((r) => `${r.kind}=${String(r.providerId)}`),
    rows,
  };
}

export interface GridCell {
  /** `K1@vpc`, `K2@subnet-a (delayed)` */
  name: string;
  crashId: string;
  stepName: string;
  variant: "instant" | "delayed";
  run(env: CloudContractEnv, adapter: CloudAdapter): Promise<void>;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Một ô của lưới.
 *
 * `kill`: chạy tới điểm chết, khẳng định nó THẬT SỰ chết (`SimulatedCrash` là chí tử nên
 * runner không bắt), rồi chạy lại bằng một runner mới và khẳng định hội tụ.
 *
 * `perturb`: chạy xong, để KHÁCH sửa ngoài luồng, rồi chạy lại và khẳng định hội tụ. Không
 * có tiến trình nào chết — điều cần khẳng định là hệ thống tự về trạng thái mong muốn.
 */
export function gridCell(args: {
  crashId: string;
  mode: "kill" | "perturb";
  phase: string;
  stepName: string;
  variant: "instant" | "delayed";
  tagPropagationDelayMs: number;
}): GridCell {
  const label =
    args.variant === "instant"
      ? `${args.crashId}@${args.stepName}`
      : `${args.crashId}@${args.stepName} (delayed)`;

  return {
    name: label,
    crashId: args.crashId,
    stepName: args.stepName,
    variant: args.variant,
    run: async (env, adapter) => {
      const ledger = env.ledger();

      if (args.mode === "kill") {
        let crashed = false;
        try {
          await runFullProvision({
            adapter,
            ledger,
            observer: crashingObserver({
              phase: args.phase,
              stepName: args.stepName,
            }),
          });
        } catch (err) {
          crashed = err instanceof SimulatedCrash;
          assert(
            crashed,
            `${label}: lỗi không phải SimulatedCrash — ${String(err)}`,
          );
        }
        assert(
          crashed,
          `${label}: pha "${args.phase}" của step "${args.stepName}" KHÔNG xảy ra, ` +
            "nên ô này chưa kiểm gì. Một ô không có chỗ để giết là một ô rỗng nghĩa",
        );
      } else {
        const first = await runFullProvision({ adapter, ledger, observer: silent });
        assert(
          first.every((o) => o.status === "SUCCESS"),
          `${label}: lượt đầu phải thành công, thấy ${first.map((o) => o.status).join(",")}`,
        );

        const rows = await ledger.rowsOf(PROJECT);
        const row = rows.find((r) => r.idempotencyKey.endsWith(`:${args.stepName}`));
        assert(row?.providerId != null, `${label}: không thấy hàng của step`);
        const id = row?.providerId as string;

        if (args.crashId === "K7") {
          /** Khách xoá tài nguyên ngoài luồng */
          await env.control.deleteOutOfBand(id);
        } else {
          /** K8: khách xoá tag `udp.key`; sổ vẫn còn `provider_id` */
          await env.control.removeTag(id, "udp.key");
        }
      }

      /** Cửa sổ lan truyền tag, nếu ô này chạy biến thể `delayed` */
      await env.control.setTagPropagationDelay(args.tagPropagationDelayMs);

      const again = await runFullProvision({ adapter, ledger, observer: silent });
      await env.control.setTagPropagationDelay(0);

      const last = again.at(-1);
      assert(
        last !== undefined &&
          (last.status === "SUCCESS" || last.status === "RETRYABLE"),
        `${label}: lượt sau phải SUCCESS hoặc RETRYABLE, thấy ${String(last?.status)}`,
      );

      /** Một lượt RETRYABLE (cửa sổ lan truyền tag) thì chạy thêm một lượt nữa */
      if (last?.status === "RETRYABLE") {
        const third = await runFullProvision({ adapter, ledger, observer: silent });
        assert(
          third.every((o) => o.status === "SUCCESS"),
          `${label}: lượt thứ ba phải hội tụ, thấy ${third.map((o) => o.status).join(",")}`,
        );
      }

      const m = await measureConvergence({ adapter, ledger, env });

      /** (a) đúng số tài nguyên — so với HẰNG SỐ VIẾT TAY, không suy từ hiện thực */
      assert(
        m.rows.length === env.fixture.expectedResourceCount,
        `${label}: sổ có ${String(m.rows.length)} hàng, hằng số fixture nói ` +
          `${String(env.fixture.expectedResourceCount)} — nhiều hơn nghĩa là TẠO TRÙNG`,
      );

      /** (b) không hàng nào kẹt */
      assert(
        m.stuck.length === 0,
        `${label}: còn ${String(m.stuck.length)} hàng kẹt ở ` +
          m.stuck.map((r) => `${r.kind}=${r.status}`).join(","),
      );

      /** (c) không tài nguyên nào trên cloud mà sổ không biết */
      assert(
        m.orphanOnCloud.length === 0,
        `${label}: cloud có ${String(m.orphanOnCloud.length)} tài nguyên mà sổ không biết: ` +
          m.orphanOnCloud.join(","),
      );

      /** (d) và chiều ngược, không phụ thuộc tag — xem `measureConvergence` */
      assert(
        m.danglingRows.length === 0,
        `${label}: sổ có ${String(m.danglingRows.length)} hàng trỏ tới id không còn ` +
          `trên cloud: ${m.danglingRows.join(",")}`,
      );
    },
  };
}
