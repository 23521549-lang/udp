import { describe, expect, it } from "vitest";
import {
  DOMAIN_CONTRACT_CHECKS,
  DOMAIN_DESIGN_CHECK_IDS,
  runDomainAdapterContract,
  type DomainContractEnv,
} from "../src/contract/index.js";
import type { DomainAdapter, DomainAdapterContext } from "../src/domain.js";
import {
  countingRandom,
  createFakeClusterAccess,
  createFakeDomainAdapter,
  fakeAdapterFixture,
} from "../src/testing/index.js";

/**
 * [v4.10] Cổng P18 — bộ hợp đồng Domain Adapter.
 *
 * Ba câu hỏi, và câu thứ ba là câu quan trọng nhất:
 *
 *  1. Bộ hợp đồng có **thoả được** không? (adapter giả đi qua trọn bộ)
 *  2. Bảng truy vết 15 phép gốc của §13.2 có đủ không?
 *  3. Bộ hợp đồng có **răng** không? (một adapter "dễ tính" làm ĐỎ bao nhiêu phép)
 *
 * Câu 3 là câu mà một bộ test không tự trả lời được về chính mình, nên nó phải có một
 * phép riêng: một bộ 42 phép mà chỉ 3 phép đỏ trước một adapter hỏng là một bộ 3 phép.
 */

function envFor(): DomainContractEnv {
  const cluster = createFakeClusterAccess({ clusterId: "c-p18" });
  const progressLog: string[] = [];
  const fetchLog: string[] = [];

  const context = (over: Partial<DomainAdapterContext> = {}): DomainAdapterContext => ({
    k8s: cluster,
    systemNamespace: "udp-system",
    region: "ap-southeast-1",
    quota: {
      maxNodes: 3,
      maxNodeSize: "medium",
      maxDatabases: 2,
      maxStorageGb: 50,
      maxLoadBalancers: 3,
    },
    resolved: {
      "registry.oci": {
        id: "registry.oci",
        version: "1.0.0",
        providedBy: "container_registry:harbor",
        endpoint: "https://harbor.noi-bo:443",
      },
    },
    tags: { "udp.project": "p18" },
    progress: (m) => progressLog.push(m),
    /**
     * `ctx.fetch` ghi nhật ký rồi NÉM.
     *
     * Ném chứ không trả về một `Response` giả: adapter giả khai `externalHosts` rỗng, nên
     * mọi lời gọi ra ngoài là một vi phạm. Trả về thành công sẽ để adapter đi tiếp và phép
     * kiểm đỏ ở một chỗ xa hơn, khó đọc hơn.
     */
    fetch: (input) => {
      fetchLog.push(String(input));
      throw new Error("egress không được phép trong bộ hợp đồng");
    },
    ...over,
  });

  return {
    cluster,
    fixture: fakeAdapterFixture(),
    context,
    progressLog,
    fetchLog,
  };
}

/** Chạy trọn bộ hợp đồng cho adapter giả — mỗi phép nhận một env MỚI */
describe("adapter giả đi qua trọn bộ hợp đồng", () => {
  runDomainAdapterContract(createFakeDomainAdapter(), envFor(), {
    describe,
    it: (name, fn) => {
      it(name, async () => {
        /**
         * Env mới cho MỖI phép.
         *
         * Dùng chung một env làm các phép ảnh hưởng nhau qua kho đối tượng của cluster
         * giả: phép `teardown` xoá ConfigMap, và phép `detectDrift` chạy sau đó sẽ thấy
         * drift vì lý do của phép trước. Một bộ test mà thứ tự quyết định kết quả thì
         * không nói được gì.
         */
        void fn;
        const env = envFor();
        const adapter = createFakeDomainAdapter();
        const check = DOMAIN_CONTRACT_CHECKS.find((c) => c.name === name);
        if (check === undefined) {
          throw new Error(`không tìm thấy phép "${name}"`);
        }
        await check.run(adapter, env);
      });
    },
  });
});

/**
 * Adapter "dễ tính": trả `SUCCESS` cho mọi thứ và không làm gì cả.
 *
 * Đúng cách một hiện thục vọi vàng trông như thế, và cũng đúng cách một hiện thục
 * **nói dối nhất quán** trông như thế — hai thứ đó không phân biệt được từ bên ngoài
 * nếu chỉ đọc giá trị trả về.
 */
function permissiveAdapter(over: {
  provides: { id: string; version: string }[];
  requires: { id: string }[];
  bindings?: unknown[];
}): DomainAdapter {
  return {
    domainType: "MONITORING",
    toolId: "de-tinh",
    version: "1.0.0",
    scope: "cluster",
    capabilities: { provides: over.provides, requires: over.requires },
    configSchema: { safeParse: () => ({ success: true, data: {} }) },
    deploy: () =>
      Promise.resolve({ status: "SUCCESS", data: over.bindings ?? [] }),
    configure: () => Promise.resolve({ status: "SUCCESS", data: [] }),
    upgrade: () => Promise.resolve({ status: "SUCCESS", data: [] }),
    detectDrift: () =>
      Promise.resolve({ status: "SUCCESS", data: { drifted: false } }),
    onDependencyChanged: () => Promise.resolve({ status: "SUCCESS" }),
    healthcheck: () =>
      Promise.resolve({ status: "SUCCESS", data: { healthy: true } }),
    teardown: () => Promise.resolve({ status: "SUCCESS" }),
  } as unknown as DomainAdapter;
}

/** Chạy cả bộ trên một adapter, trả về số đỏ và tên những phép còn xanh */
async function runAll(
  adapter: DomainAdapter,
): Promise<{ failed: number; survivors: string[] }> {
  let failed = 0;
  const survivors: string[] = [];
  for (const check of DOMAIN_CONTRACT_CHECKS) {
    try {
      await check.run(adapter, envFor());
    } catch {
      failed += 1;
      continue;
    }
    survivors.push(check.name);
  }
  return { failed, survivors: survivors.sort() };
}

describe("meta — số phép và bảng truy vết", () => {
  /**
   * Số phép là một hằng số của N5, chốt SAU khi viết.
   *
   * Plan ước lượng 37; hiện thực dừng ở 41. Chênh lệch đến từ luật "khai rỗng ⇒ phép kiểm
   * đảo chiều": mỗi danh sách của `AdapterFixture` sinh ra một ô thuận và một ô đảo, và
   * ước lượng ban đầu đếm thiếu mấy ô đảo. Ghi cả hai con số vì một hằng số không kèm lý
   * do là một hằng số người sau sẽ hạ xuống.
   */
  it("có đúng 42 phép, tên không trùng", () => {
    expect(DOMAIN_CONTRACT_CHECKS).toHaveLength(42);
    expect(new Set(DOMAIN_CONTRACT_CHECKS.map((c) => c.name)).size).toBe(42);
  });

  it("đủ 15 phép GỐC của §13.2, không thiếu mã nào", () => {
    const present = DOMAIN_CONTRACT_CHECKS.map((c) => c.designCheckId).filter(
      (x): x is string => x !== null,
    );
    expect([...present].sort()).toEqual([...DOMAIN_DESIGN_CHECK_IDS].sort());
  });

  it("không mã gốc nào bị gán cho hai phép", () => {
    const present = DOMAIN_CONTRACT_CHECKS.map((c) => c.designCheckId).filter(
      (x): x is string => x !== null,
    );
    expect(new Set(present).size).toBe(present.length);
  });

  /**
   * Phép quan trọng nhất của cả tệp: bộ hợp đồng có RĂNG không.
   *
   * Hai adapter "dễ tính", và hai con số khác nhau — việc đo hai lần là có chủ đích:
   *
   *  - **Khai RỖNG** (`provides: []`, `requires: []`): 8 phép đỏ. Phần lớn phép còn xanh
   *    là vì chúng duyệt trên chính những danh sách đó — tức khai rỗng là một đường
   *    "không bị kiểm gì". Đó là lý do có một phép chặn ở cổng vào
   *    ("khai ít nhất một trong provides / requires").
   *  - **Khai ĐỦ nhưng KHÔNG LÀM GÌ**: 9 phép đỏ. Đây là con số thật về răng của bộ
   *    hợp đồng, và nó nhỏ hơn 42 rất nhiều.
   *
   * **Nói thẳng điều con số thứ hai nghĩa là gì**, vì nó là giới hạn của cả kỹ thuật:
   * một adapter nói dối **nhất quán** (trả `SUCCESS`, tự báo healthy, tự báo không
   * drift) đi qua được mọi phép chỉ đọc **giá trị trả về**. Chỉ 9 phép bắt được nó, và
   * đúng 9 phép đó là những phép đòi một **tác dụng quan sát được** — ghi lên cluster
   * giả, gọi `progress`, từ chối một đầu vào. Những phép còn lại vẫn có giá trị (chúng
   * bắt adapter khai sai hình, và chúng là thứ hai adapter thật của P19/P20 phải thoả),
   * nhưng chúng không phát hiện được một hiện thục rỗng.
   *
   * Viết ra con số 9 thay vì nói "42 phép bảo vệ" là điểm khác nhau giữa một bộ test
   * biết giới hạn của mình và một bộ test cho cảm giác an toàn.
   */
  it("adapter khai RỖNG: 8 phép đỏ, và cổng vào là một trong số đó", async () => {
    const empty = permissiveAdapter({ provides: [], requires: [] });
    const { failed, survivors } = await runAll(empty);
    expect(failed).toBe(8);
    expect(
      survivors,
      "phép chặn cổng vào phải Đỏ trước một khai báo rỗng",
    ).not.toContain("khai ít nhất một trong provides / requires");
  }, 30_000);

  it("adapter khai ĐỦ nhưng KHÔNG LÀM GÌ: đúng 9 phép đỏ", async () => {
    const inert = permissiveAdapter({
      provides: [{ id: "metrics.query", version: "2.0.0" }],
      requires: [{ id: "registry.oci" }],
      bindings: [
        {
          id: "metrics.query",
          version: "2.0.0",
          providedBy: "monitoring:de-tinh",
        },
      ],
    });
    const { failed, survivors } = await runAll(inert);

    /**
     * Danh sách Đỏ được chốt TÊN, không chỉ số lượng.
     *
     * Một con số mình không nói được phép nào đang làm việc: đổi một phép mạnh thành
     * yếu và một phép yếu thành mạnh giữ nguyên tổng, và test vẫn xanh.
     */
    expect(failed).toBe(9);
    expect(
      DOMAIN_CONTRACT_CHECKS.map((c) => c.name).filter(
        (n) => !survivors.includes(n),
      ).sort(),
    ).toEqual([
      "configSchema từ chối MỌI config không hợp lệ của fixture",
      "deploy rồi healthcheck phải trả healthy",
      "deploy đọc endpoint của dependency từ ctx.resolved, không tự đoán",
      "detectDrift trả true sau MỖI driftMutation của fixture",
      "onDependencyChanged cập nhật theo binding MỚI",
      "progress được gọi ít nhất một lần khi deploy",
      "teardown sau deploy dọn sạch tài nguyên",
      "upgrade thất bại KHÔNG đổi version adapter báo về",
      "vượt chiều quota đã khai ⇒ adapter TỪ CHỐI",
    ]);
  }, 30_000);
});

describe("nguồn ngẫu nhiên là bộ ĐẾM LÊN, không phải Math.random", () => {
  /**
   * Vì sao điều này thuộc bộ hợp đồng: `deploy` hai lần là idempotent chỉ kiểm được khi
   * hai lượt sinh ra cùng một thứ. Một adapter dùng `randomUUID()` cho tên release sẽ làm
   * phép đó đỏ hoặc xanh tuỳ lần chạy — và một phép rung là một phép sẽ bị ai đó tắt.
   */
  it("hai bộ đếm cùng seed cho cùng một chuỗi", () => {
    const a = countingRandom(0);
    const b = countingRandom(0);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("chuỗi TĂNG, không lặp trong một lượt", () => {
    const next = countingRandom(0);
    const seen = [next(), next(), next(), next()];
    expect(new Set(seen).size).toBe(4);
    expect([...seen].sort()).toEqual(seen);
  });
});
