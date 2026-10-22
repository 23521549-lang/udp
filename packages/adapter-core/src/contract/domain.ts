import type { CapabilityId } from "@udp/shared-types";
import type { ResourceQuota } from "../cloud.js";
import type { KubernetesClient } from "../cluster.js";
import {
  DOMAIN_ADAPTER_METHODS,
  DOMAIN_ADAPTER_OPTIONAL_METHODS,
  DOMAIN_ADAPTER_PROPERTIES,
  readOnlyContext,
  type AdapterFixture,
  type DomainAdapter,
  type DomainAdapterContext,
} from "../domain.js";
import type { FakeClusterAccess } from "../testing/fake-cluster.js";
import type { TestRunnerApi } from "./ledger.js";

/**
 * [v4.10] Bộ hợp đồng Domain Adapter dưới dạng DỮ LIỆU (§13.2).
 *
 * Cùng một lý lẽ với bộ hợp đồng Cloud: **mọi adapter cùng loại phải qua đúng một bộ
 * test**, và nếu một adapter mới qua được mà không phải sửa gì bên ngoài thì luận điểm
 * pluggable được chứng minh bằng thực nghiệm. Nhưng bộ này có một đặc điểm riêng, và nó là
 * phần khó nhất của cả tệp:
 *
 * **"Khai rỗng ⇒ phép kiểm ĐẢO CHIỀU, không biến mất" là một LUẬT, không phải lời khuyên.**
 *
 * `AdapterFixture` khai bề mặt tác dụng của adapter: host nó được gọi ra ngoài, chiều quota
 * nó tiêu thụ, prefix nhãn nó bỏ qua khi so drift. Với mỗi danh sách đó, cách làm sai là
 * bỏ qua phép kiểm khi danh sách rỗng — vì lúc đó một adapter khai rỗng để "cho dễ" sẽ
 * **không bị kiểm gì cả**. Cách đúng: rỗng nghĩa là một khẳng định MẠNH HƠN.
 *
 * | Khai | Phép kiểm |
 * | --- | --- |
 * | `externalHosts` có phần tử | Chỉ những host đó được gọi; host khác ⇒ đỏ |
 * | `externalHosts` RỖNG | **MỌI** lời gọi egress ⇒ đỏ |
 * | `quotaDimensions` có phần tử | Vượt chiều đó ⇒ adapter phải từ chối |
 * | `quotaDimensions` RỖNG | Adapter phải chạy được với quota **toàn 0** |
 * | `ignoredLabelPrefixes` có phần tử | Nhãn khớp prefix không tính là drift |
 * | `ignoredLabelPrefixes` RỖNG | **MỌI** khác biệt nhãn đều là drift |
 *
 * Mỗi phép mang `designCheckId` trỏ về phép gốc của §13.2 (d1..d15). Nhờ trường đó, bảng
 * truy vết kiểm được bằng máy: thiếu một phép GỐC là một test đỏ, và đổi tên một phép
 * không làm mất dấu nó.
 *
 * | Mã | Phép gốc của §13.2 |
 * | --- | --- |
 * | d1 | deploy rồi healthcheck phải trả healthy |
 * | d2 | deploy hai lần với cùng config là idempotent |
 * | d3 | teardown sau deploy dọn sạch tài nguyên |
 * | d4 | teardown khi chưa deploy KHÔNG được ném lỗi |
 * | d5 | `configSchema` từ chối config không hợp lệ |
 * | d6 | khai báo capability nhất quán với binding trả về khi deploy |
 * | d7 | chỉ tạo tài nguyên trong namespace của environment |
 * | d8 | từ chối khi config vượt quota |
 * | d9 | không ghi credential hay secret ra log |
 * | d10 | upgrade rồi healthcheck phải trả healthy |
 * | d11 | upgrade thất bại KHÔNG được đổi `adapter_version` |
 * | d12 | `detectDrift` trả false ngay sau deploy |
 * | d13 | `detectDrift` trả true sau khi sửa tay tài nguyên trên cluster |
 * | d14 | `onDependencyChanged` cập nhật cấu hình theo binding mới |
 * | d15 | mọi HTTP ra ngoài đi qua `ctx.fetch`, không dùng `fetch` toàn cục |
 */

/** Mười lăm phép GỐC của §13.2 — bảng truy vết đối chiếu danh sách này */
export const DOMAIN_DESIGN_CHECK_IDS: readonly string[] = [
  "d1",
  "d2",
  "d3",
  "d4",
  "d5",
  "d6",
  "d7",
  "d8",
  "d9",
  "d10",
  "d11",
  "d12",
  "d13",
  "d14",
  "d15",
];

export interface DomainContractEnv {
  /** Cluster giả DUY NHẤT (QĐ-27) — tách verb đọc/ghi, và ghi nhật ký lời gọi */
  cluster: FakeClusterAccess;
  fixture: AdapterFixture;
  /** Bối cảnh mới cho mỗi phép; `progress` và `fetch` do bộ hợp đồng kiểm soát */
  context: (over?: Partial<DomainAdapterContext>) => DomainAdapterContext;
  /** Nhật ký `progress` của lượt gần nhất — phép d9 quét secret trong này */
  progressLog: string[];
  /** Lời gọi qua `ctx.fetch` của lượt gần nhất */
  fetchLog: string[];
}

export interface DomainCheck {
  name: string;
  /** Mã phép gốc của §13.2, hoặc `null` nếu đây là phép v4.10 thêm vào */
  designCheckId: string | null;
  run(adapter: DomainAdapter, env: DomainContractEnv): Promise<void>;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Mọi `CapabilityRequirement` của adapter, phẳng hoá cả nhánh `anyOf` */
function flatRequires(
  adapter: DomainAdapter,
): { id: CapabilityId; constraint?: string }[] {
  return adapter.capabilities.requires.flatMap((r) =>
    "anyOf" in r ? r.anyOf : [r],
  );
}

async function expectThrowsOrFails(
  fn: () => Promise<{ status: string } | void>,
  message: string,
): Promise<void> {
  let bad = false;
  try {
    const res = await fn();
    if (res !== undefined && res.status !== "SUCCESS") bad = true;
  } catch {
    bad = true;
  }
  assert(bad, message);
}

/** Hai giá trị hợp lệ của `scope`, dạng CHẠY ĐƯỢC — xem chú thích tại chỗ dùng */
const VALID_SCOPES: readonly string[] = ["cluster", "namespace"];

/**
 * [v4.10] Khoá KHÔNG khớp prefix nào - dùng cho nửa "phải là drift" của hai ô nhãn.
 *
 * Tên miền `udp.test/` là tên miền dành cho test, nên không adapter nào có lý do khai nó
 * vào `ignoredLabelPrefixes`; nếu ai khai thì chính hai ô đó đỏ, và đó là kết quả đúng.
 */
const STRAY_KEY = "udp.test/nhan-la";

/**
 * Sửa tay MỌI đối tượng mà adapter vừa ghi, bằng một lần `patch` trộn thêm khoá.
 *
 * Vì sao "mọi" chứ không phải "một": bộ hợp đồng không biết adapter đọc lại đối tượng NÀO
 * khi quét drift. Sửa đúng một đối tượng đoán bừa rồi khẳng định "phải phát hiện" là một ô
 * đỏ sai với adapter đọc đối tượng khác; còn sửa đối tượng adapter không đọc rồi khẳng
 * định "không được phát hiện" là một ô xanh sai. Danh sách lấy từ `writes` của lượt deploy
 * vừa rồi, nên nó chính là tập đối tượng adapter tự nhận quản lý.
 */
async function patchEveryManagedObject(
  env: DomainContractEnv,
  patch: Readonly<Record<string, unknown>>,
): Promise<void> {
  const seen = new Set<string>();
  const refs = env.cluster.writes
    .map((w) => w.ref)
    .filter((ref) => {
      const key = [ref.kind, ref.namespace ?? "-", ref.name ?? "-"].join("/");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  assert(
    refs.length > 0,
    "lượt deploy không ghi đối tượng nào, nên không có gì để sửa tay",
  );
  const client = await env.cluster.getClient("tooling");
  for (const ref of refs) {
    await client.write("patch", ref, patch);
  }
}

const ZERO_QUOTA: ResourceQuota = {
  maxNodes: 0,
  maxNodeSize: "small",
  maxDatabases: 0,
  maxStorageGb: 0,
  maxLoadBalancers: 0,
};

export const DOMAIN_CONTRACT_CHECKS: readonly DomainCheck[] = [
  // ---------------------------------------------------------------- d1..d4
  {
    name: "deploy rồi healthcheck phải trả healthy",
    designCheckId: "d1",
    async run(adapter, env) {
      env.cluster.reset();
      const res = await adapter.deploy(env.context(), env.fixture.validConfig);
      assert(
        res.status === "SUCCESS",
        `deploy phải SUCCESS, thấy ${res.status}`,
      );
      /**
       * `deploy` phải có TÁC DỤNG quan sát được trên cluster.
       *
       * Một adapter trả `SUCCESS` mà không ghi gì rồi `healthcheck` tự báo healthy đi qua
       * mọi phép kiểm dựa trên giá trị trả về — nó nói dối một cách nhất quán. Chốt
       * duy nhất không dụa vào lời của adapter là nhật ký lời gọi.
       */
      assert(
        env.cluster.writes.length > 0,
        "deploy không ghi gì lên cluster; SUCCESS mà không làm gì là một lời nói dối",
      );
      const health = await adapter.healthcheck(env.context());
      assert(health.status === "SUCCESS", "healthcheck phải SUCCESS");
      assert(health.data?.healthy === true, "healthcheck phải báo healthy");
    },
  },
  {
    name: "deploy hai lần với cùng config là idempotent",
    designCheckId: "d2",
    async run(adapter, env) {
      const first = await adapter.deploy(
        env.context(),
        env.fixture.validConfig,
      );
      const second = await adapter.deploy(
        env.context(),
        env.fixture.validConfig,
      );
      assert(first.status === "SUCCESS", "lần đầu phải SUCCESS");
      assert(second.status === "SUCCESS", "lần hai phải SUCCESS");
      /** Cùng tập binding, không phụ thuộc thứ tự */
      const ids = (r: typeof first): string[] =>
        (r.data ?? []).map((b) => b.id).sort();
      assert(
        JSON.stringify(ids(first)) === JSON.stringify(ids(second)),
        "hai lần deploy phải trả cùng tập capability",
      );
    },
  },
  {
    name: "teardown sau deploy dọn sạch tài nguyên",
    designCheckId: "d3",
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      env.cluster.reset();
      const res = await adapter.teardown(env.context(), "disable");
      assert(res.status === "SUCCESS", "teardown phải SUCCESS");
      /**
       * Có ÍT NHẤT một verb ghi kiểu xoá.
       *
       * Một `teardown` trả SUCCESS mà không gọi gì là hình dạng tệ nhất: nó báo đã dọn
       * trong khi tài nguyên còn nguyên, và người vận hành chỉ biết khi hoá đơn về.
       */
      const deletes = env.cluster.writes.filter(
        (c) => c.verb === "delete" || c.verb === "deletecollection",
      );
      assert(
        deletes.length > 0,
        "teardown phải gọi delete; SUCCESS mà không gọi gì là báo dọn mà không dọn",
      );
    },
  },
  {
    name: "teardown khi CHƯA deploy KHÔNG được ném lỗi",
    designCheckId: "d4",
    async run(adapter, env) {
      const res = await adapter.teardown(env.context(), "disable");
      assert(
        res.status === "SUCCESS",
        "teardown trên trạng thái rỗng phải SUCCESS (idempotent)",
      );
    },
  },

  // ---------------------------------------------------------------- d5
  {
    name: "configSchema từ chối MỌI config không hợp lệ của fixture",
    designCheckId: "d5",
    async run(adapter, env) {
      assert(
        env.fixture.invalidConfigs.length > 0,
        "fixture phải khai ít nhất một config không hợp lệ",
      );
      for (const bad of env.fixture.invalidConfigs) {
        const parsed = adapter.configSchema.safeParse(bad);
        assert(
          !parsed.success,
          `configSchema phải từ chối ${JSON.stringify(bad)}`,
        );
      }
      await Promise.resolve();
    },
  },
  {
    name: "configSchema NHẬN config hợp lệ của fixture",
    designCheckId: null,
    async run(adapter, env) {
      const parsed = adapter.configSchema.safeParse(env.fixture.validConfig);
      assert(parsed.success, "configSchema phải nhận validConfig");
      await Promise.resolve();
    },
  },

  // ---------------------------------------------------------------- d6
  {
    name: "binding trả về khi deploy khớp capability đã khai",
    designCheckId: "d6",
    async run(adapter, env) {
      const ctx = env.context();
      const res = await adapter.deploy(ctx, env.fixture.validConfig);
      const bindings = res.data ?? [];
      const got = [...new Set(bindings.map((b) => b.id))].sort();
      /**
       * [v4.11, D-P29] Một capability chỉ được LẶP khi đó là binding THEO environment (instance
       * database mỗi env): mỗi bản mang một `environmentId` khác nhau, và id đó là environment
       * của project. Lặp mà không có env là hai hàng `capability_bindings` tranh cùng một chỗ.
       */
      const projectEnvironments = new Set(ctx.environments.map((e) => e.id));
      for (const id of got) {
        const same = bindings.filter((b) => b.id === id);
        if (same.length === 1) continue;
        const envIds = same.map((b) => b.environmentId);
        assert(
          envIds.every((e) => e !== undefined && projectEnvironments.has(e)) &&
            new Set(envIds).size === same.length,
          `binding ${id} lặp ${String(same.length)} lần mà không mỗi bản một environment của project`,
        );
      }
      /**
       * `provides` là `{ id, version, exclusive? }[]`, KHÔNG phải `string[]`.
       *
       * Bản v4.9 của đoạn mã này so `string[]` với `object[]`, nên nó **không bao giờ
       * xanh được** (D-17) — một phép kiểm không thể xanh và một phép kiểm không tồn tại
       * che chắn như nhau.
       */
      const want = adapter.capabilities.provides.map((p) => p.id).sort();
      assert(
        JSON.stringify(got) === JSON.stringify(want),
        `binding ${JSON.stringify(got)} phải khớp provides ${JSON.stringify(want)}`,
      );
      /**
       * Chiều ĐẢO: khai `provides` rỗng thì `deploy` phải trả danh sách RỖNG.
       *
       * Phép so trên tự thoả khi cả hai rỗng, nên nó một mình không chặn được một
       * adapter khai rỗng rồi trả về binding — một binding không ai khai là một hàng
       * `capability_bindings` mà resolver không biết tới.
       */
      if (adapter.capabilities.provides.length === 0) {
        assert(
          got.length === 0,
          `khai provides rỗng mà deploy trả ${String(got.length)} binding`,
        );
      }
    },
  },
  {
    name: "version của binding khớp version đã khai trong provides",
    designCheckId: null,
    async run(adapter, env) {
      const res = await adapter.deploy(env.context(), env.fixture.validConfig);
      for (const b of res.data ?? []) {
        const declared = adapter.capabilities.provides.find(
          (p) => p.id === b.id,
        );
        assert(
          declared !== undefined,
          `binding ${b.id} không có trong provides`,
        );
        assert(
          b.version === declared.version,
          `binding ${b.id} version ${b.version} khác khai ${declared.version}`,
        );
      }
    },
  },
  {
    name: "providedBy của binding là `<domainType>:<toolId>` viết thường",
    designCheckId: null,
    async run(adapter, env) {
      const res = await adapter.deploy(env.context(), env.fixture.validConfig);
      const want = `${adapter.domainType.toLowerCase()}:${adapter.toolId.toLowerCase()}`;
      for (const b of res.data ?? []) {
        assert(
          b.providedBy === want,
          `providedBy "${b.providedBy}" phải là "${want}"`,
        );
      }
    },
  },

  // ---------------------------------------------------------------- d7
  {
    name: "chỉ chạm namespace của environment (hoặc systemNamespace nếu cluster-scoped)",
    designCheckId: "d7",
    async run(adapter, env) {
      env.cluster.reset();
      const ctx = env.context();
      await adapter.deploy(ctx, env.fixture.validConfig);

      const allowed = new Set(
        [ctx.environment?.k8sNamespace, ctx.systemNamespace].filter(
          (n): n is string => n !== undefined,
        ),
      );
      const outside = env.cluster.calls
        .filter((c) => c.ref.namespace !== undefined)
        .filter((c) => !allowed.has(c.ref.namespace as string));
      assert(
        outside.length === 0,
        `chạm namespace ngoài phạm vi: ${outside
          .map((c) => String(c.ref.namespace))
          .join(",")}`,
      );
    },
  },
  {
    name: "adapter scope = cluster KHÔNG đòi environment trong ctx",
    designCheckId: null,
    async run(adapter, env) {
      if (adapter.scope !== "cluster") {
        await Promise.resolve();
        return;
      }
      const ctx = env.context();
      /**
       * Bỏ HẲN `environment` khỏi ctx, không đặt `undefined`.
       *
       * `exactOptionalPropertyTypes` phân biệt hai thứ đó, và một adapter đọc
       * `ctx.environment!.k8sNamespace` sẽ vỡ ở đây — đúng điều cần bắt: §5.2 nói
       * adapter cluster-scoped cài MỘT lần vào `udp-system`, nên nó không được phụ thuộc
       * environment.
       */
      const { environment: _drop, ...withoutEnv } = ctx;
      void _drop;
      const res = await adapter.deploy(withoutEnv, env.fixture.validConfig);
      assert(
        res.status === "SUCCESS",
        "adapter cluster-scoped phải deploy được khi ctx không có environment",
      );
    },
  },

  // ---------------------------------------------------------------- d8 + quota
  {
    name: "vượt chiều quota đã khai ⇒ adapter TỪ CHỐI",
    designCheckId: "d8",
    async run(adapter, env) {
      if (env.fixture.quotaDimensions.length === 0) {
        await Promise.resolve();
        return;
      }
      for (const dim of env.fixture.quotaDimensions) {
        const quota: ResourceQuota = { ...ZERO_QUOTA };
        void dim;
        await expectThrowsOrFails(
          () => adapter.deploy(env.context({ quota }), env.fixture.validConfig),
          `quota ${String(dim)} bằng 0 mà adapter vẫn deploy`,
        );
      }
    },
  },
  {
    /**
     * Chiều ĐẢO của luật "khai rỗng ⇒ phép kiểm mạnh hơn".
     *
     * `quotaDimensions` rỗng nghĩa là adapter tuyên bố nó không tiêu thụ chiều quota nào.
     * Tuyên bố đó phải trả giá: nó PHẢI chạy được với quota toàn 0. Bỏ qua phép kiểm khi
     * danh sách rỗng là cho adapter một cách khai rỗng để không bị kiểm gì.
     */
    name: "khai quotaDimensions RỖNG ⇒ phải deploy được với quota toàn 0",
    designCheckId: null,
    async run(adapter, env) {
      if (env.fixture.quotaDimensions.length > 0) {
        await Promise.resolve();
        return;
      }
      const res = await adapter.deploy(
        env.context({ quota: ZERO_QUOTA }),
        env.fixture.validConfig,
      );
      assert(
        res.status === "SUCCESS",
        "khai không tiêu thụ quota thì phải chạy được với quota toàn 0",
      );
    },
  },

  // ---------------------------------------------------------------- d9
  {
    name: "không ghi secret ra progress log",
    designCheckId: "d9",
    async run(adapter, env) {
      const sentinel = "CANH-BI-MAT-d9-3f9a2b";
      env.progressLog.length = 0;
      await adapter.deploy(
        env.context({
          tags: { "udp.secret-canh": sentinel },
          resolved: {
            "metrics.query": {
              id: "metrics.query",
              version: "2.0.0",
              providedBy: "monitoring:x",
              attributes: { token: sentinel },
            },
          },
        }),
        { ...env.fixture.validConfig, apiKey: sentinel },
      );
      const leaked = env.progressLog.filter((l) => l.includes(sentinel));
      assert(
        leaked.length === 0,
        `secret rò ra progress: ${leaked.slice(0, 2).join(" | ")}`,
      );
    },
  },
  {
    name: "không ghi secret ra thông điệp lỗi khi deploy thất bại",
    designCheckId: null,
    async run(adapter, env) {
      const sentinel = "CANH-BI-MAT-loi-7c1d";
      let text = "";
      try {
        const res = await adapter.deploy(env.context(), {
          ...env.fixture.validConfig,
          __forceFailWith: sentinel,
        });
        text = JSON.stringify(res);
      } catch (err) {
        text =
          err instanceof Error ? `${err.name} ${err.message}` : String(err);
      }
      assert(!text.includes(sentinel), "secret rò ra thông điệp lỗi");
    },
  },

  // ---------------------------------------------------------------- d10, d11
  {
    name: "upgrade rồi healthcheck phải trả healthy",
    designCheckId: "d10",
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      const up = await adapter.upgrade(
        env.context(),
        env.fixture.validConfig,
        adapter.version,
      );
      assert(
        up.status === "SUCCESS",
        `upgrade phải SUCCESS, thấy ${up.status}`,
      );
      const health = await adapter.healthcheck(env.context());
      assert(health.data?.healthy === true, "sau upgrade phải healthy");
    },
  },
  {
    /**
     * `adapter_version` chỉ được đổi khi upgrade THÀNH CÔNG.
     *
     * §8.6 nói `detectDrift()` so với cột đó, nên cập nhật nó sau một lần upgrade thất bại
     * làm **mọi lần quét sau báo trôi giả** — và người vận hành đi tìm một drift không có.
     */
    name: "upgrade thất bại KHÔNG đổi version adapter báo về",
    designCheckId: "d11",
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      const before = adapter.version;
      await expectThrowsOrFails(
        () =>
          adapter.upgrade(
            env.context(),
            env.fixture.validConfig,
            "0.0.0-khong-ton-tai",
          ),
        "upgrade tới version không tồn tại phải thất bại",
      );
      assert(
        adapter.version === before,
        `version đổi từ ${before} thành ${adapter.version} sau một lần upgrade thất bại`,
      );
    },
  },

  // ---------------------------------------------------------------- d12, d13
  {
    name: "detectDrift trả false NGAY SAU deploy",
    designCheckId: "d12",
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      /**
       * [v4.10] Gọi qua `readOnlyContext` - ĐÚNG đường mà job `DRIFT_SCAN` dùng.
       *
       * Bản trước truyền bối cảnh đầy đủ, nên tầng chạy của I32 chiều (c) (client bị bóc
       * `write`) không được adapter nào đi qua: bốn adapter đều xanh mà chưa chắc chạy
       * được khi client thật sự không có `write`. Nay mọi ô drift đi đường sản phẩm, còn
       * ô đếm verb ghi ở dưới cố tình giữ bối cảnh ĐẦY ĐỦ - nó là ô bắt gian.
       */
      const res = await adapter.detectDrift(
        readOnlyContext(env.context()),
        env.fixture.validConfig,
      );
      assert(res.status === "SUCCESS", "detectDrift phải SUCCESS");
      assert(
        res.data?.drifted === false,
        "ngay sau deploy thì không được có drift",
      );
    },
  },
  {
    name: "detectDrift trả true sau MỖI driftMutation của fixture",
    designCheckId: "d13",
    async run(adapter, env) {
      assert(
        env.fixture.driftMutations.length > 0,
        "fixture phải khai ít nhất một driftMutation — chiều (a) của I32 cần đối tượng",
      );
      for (const m of env.fixture.driftMutations) {
        await adapter.deploy(env.context(), env.fixture.validConfig);
        const client = await env.cluster.getClient("tooling");
        await m.apply(client);
        const res = await adapter.detectDrift(
          readOnlyContext(env.context()),
          env.fixture.validConfig,
        );
        assert(
          res.data?.drifted === true,
          `driftMutation "${m.name}" không bị phát hiện`,
        );
      }
    },
  },
  {
    /**
     * I32 chiều (c): hệ thống **không bao giờ** tự sửa drift.
     *
     * Bảo đảm tầng một là KIỂU (`detectDrift` nhận `ReadOnlyKubernetesClient`), nhưng một
     * bảo đảm ở tầng kiểu mất hiệu lực ngay khi ai đó viết một `as`. Tầng hai là ĐẾM:
     * sau một lượt quét, `writes` phải rỗng.
     */
    name: "detectDrift KHÔNG gọi verb ghi nào (I32 chiều c)",
    designCheckId: null,
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      env.cluster.reset();
      /**
       * CỐ TÌNH truyền bối cảnh ĐẦY ĐỦ: đây là ô bắt gian.
       *
       * Phương thức trong TypeScript là song biến, nên một adapter khai
       * `detectDrift(ctx: DomainAdapterContext)` vẫn thoả interface và vẫn ghi được khi
       * ai đó gọi nó với bối cảnh đầy đủ - ví dụ một route `POST /domains/:type/drift`
       * viết vội. Ô này đưa cho adapter đúng cái quyền đó rồi đếm xem nó có dùng không.
       */
      const res = await adapter.detectDrift(
        env.context(),
        env.fixture.validConfig,
      );
      assert(
        res.status === "SUCCESS",
        "detectDrift phải SUCCESS cả khi được trao bối cảnh đầy đủ",
      );
      assert(
        env.cluster.writes.length === 0,
        `detectDrift gọi ${String(env.cluster.writes.length)} verb ghi: ` +
          env.cluster.writes.map((w) => w.verb).join(","),
      );
    },
  },
  {
    /**
     * [v4.10] Ô này từng chỉ đọc lời khai, giờ nó kiểm HÀNH VI.
     *
     * Bản trước khẳng định "mỗi prefix có lý do" rồi dừng - tức một adapter bỏ qua đúng
     * những prefix đã khai vẫn xanh, và một adapter bỏ qua MỌI khoá lạ cũng xanh. Đó là
     * ô xanh-nhưng-sai đã tìm ra ở P21: chính nó lẽ ra phải đỏ ở P20, khi hai lớp nền còn
     * so tập con.
     *
     * Hai nửa, và nửa thứ hai là nửa quan trọng:
     *
     *  1. Thêm một khoá mang prefix ĐÃ KHAI vào mọi đối tượng adapter ghi ⇒ KHÔNG drift.
     *  2. Thêm một khoá KHÔNG khớp prefix nào ⇒ PHẢI drift.
     *
     * Không có nửa (2) thì lời khai `ignoredLabelPrefixes` là một tờ giấy phép rỗng: một
     * adapter bỏ qua tất cả vẫn qua được nửa (1).
     */
    name: "nhãn khớp ignoredLabelPrefixes KHÔNG tính là drift",
    designCheckId: null,
    async run(adapter, env) {
      if (env.fixture.ignoredLabelPrefixes.length === 0) {
        await Promise.resolve();
        return;
      }
      for (const { prefix, reason } of env.fixture.ignoredLabelPrefixes) {
        assert(
          reason.trim().length > 0,
          `prefix ${prefix} phải kèm lý do, để danh sách không mọc rêu`,
        );
      }
      const first = env.fixture.ignoredLabelPrefixes[0];
      assert(first !== undefined, "không thể tới đây");

      await adapter.deploy(env.context(), env.fixture.validConfig);
      await patchEveryManagedObject(env, { [`${first.prefix}sua-tay`]: "1" });
      const ignored = await adapter.detectDrift(
        readOnlyContext(env.context()),
        env.fixture.validConfig,
      );
      assert(
        ignored.data?.drifted === false,
        `khoá mang prefix đã khai "${first.prefix}" bị tính là drift: ` +
          (ignored.data?.details ?? ignored.message ?? ""),
      );

      await patchEveryManagedObject(env, { [STRAY_KEY]: "1" });
      const stray = await adapter.detectDrift(
        readOnlyContext(env.context()),
        env.fixture.validConfig,
      );
      assert(
        stray.data?.drifted === true,
        `khoá lạ "${STRAY_KEY}" KHÔNG khớp prefix nào mà vẫn không bị tính là drift`,
      );
    },
  },
  {
    /**
     * Chiều đảo: khai rỗng ⇒ MỌI khác biệt đều là drift.
     *
     * [v4.10] Cũng từ một ô đọc lời khai (`length === 0` khẳng định `length === 0`) thành
     * một ô kiểm hành vi. Hai adapter tối thiểu của P20 khai rỗng, nên nhánh này có người
     * chạy; hai adapter thật khai không rỗng và chạy nhánh trên.
     */
    name: "khai ignoredLabelPrefixes RỖNG ⇒ mọi khác biệt nhãn đều là drift",
    designCheckId: null,
    async run(adapter, env) {
      if (env.fixture.ignoredLabelPrefixes.length > 0) {
        await Promise.resolve();
        return;
      }
      await adapter.deploy(env.context(), env.fixture.validConfig);
      await patchEveryManagedObject(env, { [STRAY_KEY]: "1" });
      const res = await adapter.detectDrift(
        readOnlyContext(env.context()),
        env.fixture.validConfig,
      );
      assert(
        res.data?.drifted === true,
        "khai rỗng mà một khoá lạ vẫn không bị tính là drift",
      );
    },
  },

  // ---------------------------------------------------------------- d14
  {
    name: "onDependencyChanged cập nhật theo binding MỚI",
    designCheckId: "d14",
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      env.cluster.reset();
      /**
       * Binding phải là của một capability adapter **THẬT SỰ requires**.
       *
       * Bản đầu của phép này truyền một capability cố định (`metrics.query`), và nó đỏ với
       * adapter giả vì adapter đó *provide* `metrics.query` chứ không *require* nó — tức
       * phép kiểm đỏ vì một lý do không liên quan tới tính chất nó kiểm. Lấy từ chính
       * `requires` của adapter là cách duy nhất để phép này đúng cho MỌI adapter.
       */
      const first = flatRequires(adapter)[0];
      if (first === undefined) {
        /**
         * Chiều ĐẢO: không `requires` gì thì `onDependencyChanged` phải là no-op
         * **thành công** với BẤT KỲ binding, và KHÔNG được ghi gì.
         *
         * Bỏ qua phép kiểm ở đây là cho một adapter khai `requires: []` một cách
         * không bị kiểm gì — đúng luật mà chú thích đầu tệp này đặt ra, áp cho
         * chính khai báo của adapter.
         */
        env.cluster.reset();
        const res = await adapter.onDependencyChanged(
          env.context(),
          env.fixture.validConfig,
          {
            id: "db.instance",
            version: "1.0.0",
            providedBy: "khong:lien-quan",
          },
        );
        assert(
          res.status === "SUCCESS",
          "không requires gì thì mọi binding phải là no-op thành công",
        );
        assert(
          env.cluster.writes.length === 0,
          "không requires gì mà vẫn ghi khi dependency đổi",
        );
        return;
      }
      /**
       * Binding MỚI cùng hình với binding đang dùng — chỉ đổi provider và endpoint (Plan #32).
       *
       * Một capability có hợp đồng dây (`logs.sink@1` mang `attributes.protocol`, traffic-split
       * mang `attributes.provider`) thì binding trống thuộc tính là binding SAI, và adapter từ
       * chối nó là ĐÚNG. Phép kiểm đưa một binding hợp lệ; nó vẫn đòi SUCCESS và có ghi.
       */
      const current = env.context().resolved[first.id];
      const res = await adapter.onDependencyChanged(
        env.context(),
        env.fixture.validConfig,
        {
          ...(current ?? { id: first.id, version: "9.9.9" }),
          providedBy: "khac:provider-moi",
          endpoint: "http://provider-moi:8080",
        },
      );
      assert(
        res.status === "SUCCESS",
        `onDependencyChanged phải SUCCESS, thấy ${res.status}`,
      );
      /**
       * Nó phải THẬT SỰ ghi gì đó.
       *
       * Một hiện thực trả SUCCESS mà không gọi gì là hình dạng "đã cập nhật" giả: binding
       * đổi, adapter báo xong, và nó vẫn trỏ tới endpoint cũ.
       */
      assert(
        env.cluster.writes.length > 0,
        "onDependencyChanged phải ghi gì đó; SUCCESS mà không ghi là báo xong mà không làm",
      );
    },
  },
  {
    name: "onDependencyChanged với binding KHÔNG liên quan là no-op thành công",
    designCheckId: null,
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      /** Một capability mà adapter KHÔNG requires — lấy cái đầu tiên ngoài danh sách */
      const needed = new Set(flatRequires(adapter).map((r) => r.id));
      const unrelated = (
        ["db.instance", "cost.query", "policy.admission"] as const
      ).find((c) => !needed.has(c));
      if (unrelated === undefined) {
        await Promise.resolve();
        return;
      }
      const res = await adapter.onDependencyChanged(
        env.context(),
        env.fixture.validConfig,
        {
          id: unrelated,
          version: "1.0.0",
          providedBy: "khong:lien-quan",
        },
      );
      assert(
        res.status === "SUCCESS",
        "binding không liên quan phải là no-op thành công, không phải lỗi",
      );
    },
  },

  // ---------------------------------------------------------------- d15 + egress
  {
    name: "chỉ gọi ra ngoài qua ctx.fetch, tới host đã khai",
    designCheckId: "d15",
    async run(adapter, env) {
      env.fetchLog.length = 0;
      await adapter.deploy(env.context(), env.fixture.validConfig);
      const allowed = new Set(env.fixture.externalHosts);
      const outside = env.fetchLog.filter((url) => {
        try {
          return !allowed.has(new URL(url).host);
        } catch {
          return true;
        }
      });
      assert(
        outside.length === 0,
        `gọi host chưa khai: ${outside.slice(0, 3).join(", ")}`,
      );
    },
  },
  {
    /**
     * Chiều ĐẢO: `externalHosts` rỗng nghĩa là MỌI egress là đỏ.
     *
     * Đây là chỗ mà "bỏ qua khi rỗng" nguy hiểm nhất: một adapter khai rỗng rồi gọi ra
     * Internet sẽ không bị phép kiểm nào chạm tới, trong khi chính §12 T11 tồn tại để
     * chặn SSRF.
     */
    name: "khai externalHosts RỖNG ⇒ MỌI lời gọi egress là đỏ",
    designCheckId: null,
    async run(adapter, env) {
      if (env.fixture.externalHosts.length > 0) {
        await Promise.resolve();
        return;
      }
      env.fetchLog.length = 0;
      await adapter.deploy(env.context(), env.fixture.validConfig);
      assert(
        env.fetchLog.length === 0,
        `khai không gọi ra ngoài mà vẫn gọi: ${env.fetchLog.join(", ")}`,
      );
    },
  },
  {
    name: "KHÔNG dùng fetch toàn cục (bị thay bằng hàm ném lỗi)",
    designCheckId: null,
    async run(adapter, env) {
      const original = globalThis.fetch;
      let usedGlobal = false;
      globalThis.fetch = () => {
        usedGlobal = true;
        throw new Error("fetch toàn cục bị cấm trong adapter (§12 T11)");
      };
      try {
        await adapter.deploy(env.context(), env.fixture.validConfig);
      } catch {
        /** Ném là hệ quả của việc dùng fetch toàn cục; `usedGlobal` mới là kết luận */
      } finally {
        globalThis.fetch = original;
      }
      assert(!usedGlobal, "adapter gọi fetch toàn cục thay vì ctx.fetch");
    },
  },

  // ---------------------------------------------------------------- bề mặt interface
  {
    /**
     * Adapter phải có CHỖ trong đồ thị capability.
     *
     * Khai cả `provides` và `requires` rỗng nghĩa là adapter không nối với ai: resolver
     * không có cạnh nào tới nó, `topoSort` đặt nó ở bậc đầu mà không ai chờ nó, và
     * đóng góp C2 (tổ hợp theo capability) không áp được cho nó.
     *
     * Quan trọng hơn: một khai báo rỗng làm PHẦN LỚN bộ hợp đồng này tự thoả, vì
     * nhiều phép duyệt trên chính những danh sách đó. Đó là lý do phép này tồn tại:
     * nó đóng đường "khai rỗng để không bị kiểm gì" ở mức cao nhất.
     */
    name: "khai ít nhất một trong provides / requires",
    designCheckId: null,
    async run(adapter) {
      const p = adapter.capabilities.provides.length;
      const r = adapter.capabilities.requires.length;
      assert(
        p + r > 0,
        "khai cả provides và requires rỗng ⇒ adapter không có chỗ trong đồ thị capability",
      );
      await Promise.resolve();
    },
  },
  {
    /**
     * [v4.12, Plan #61 61d-3a] "Đủ" nghĩa là đủ thành viên BẮT BUỘC.
     *
     * Bề mặt có một thành viên tuỳ chọn (`restoreTo?`, xem `DOMAIN_ADAPTER_OPTIONAL_METHODS`): adapter chưa bao giờ
     * đổi version không phải hiện thực nó, nên đòi nó ở đây sẽ làm mọi adapter đang có đỏ vì một thứ chúng không
     * cần. Cổng đóng băng bề mặt vẫn đếm nó — hai câu hỏi khác nhau, hai chỗ khác nhau.
     */
    name: "khai đủ phương thức BẮT BUỘC của DomainAdapter",
    designCheckId: null,
    async run(adapter) {
      const required = DOMAIN_ADAPTER_METHODS.filter(
        (m) => !DOMAIN_ADAPTER_OPTIONAL_METHODS.includes(m),
      );
      for (const m of required) {
        assert(
          typeof (adapter as unknown as Record<string, unknown>)[m] ===
            "function",
          `thiếu phương thức ${m}`,
        );
      }
      await Promise.resolve();
    },
  },
  {
    name: "khai đủ sáu thuộc tính của DomainAdapter",
    designCheckId: null,
    async run(adapter) {
      for (const p of DOMAIN_ADAPTER_PROPERTIES) {
        assert(
          p in (adapter as unknown as Record<string, unknown>),
          `thiếu thuộc tính ${p}`,
        );
      }
      await Promise.resolve();
    },
  },
  {
    name: "version là semver đầy đủ x.y.z",
    designCheckId: null,
    async run(adapter) {
      assert(
        /^\d+\.\d+\.\d+/.test(adapter.version),
        `version "${adapter.version}" phải là semver đầy đủ`,
      );
      await Promise.resolve();
    },
  },
  {
    name: "scope là 'cluster' hoặc 'namespace', không phải chuỗi khác",
    designCheckId: null,
    async run(adapter) {
      /**
       * So với một danh sách CHẠY ĐƯỢC, không viết hai phép so kiểu.
       *
       * `adapter.scope === "cluster" || adapter.scope === "namespace"` là một tautology ở
       * tầng kiểu (lint chỉ ra: `"namespace" === "namespace"` luôn đúng), nên nó không
       * kiểm gì. Nhưng tính chất CẦN kiểm là thật: bộ hợp đồng này chạy trên cả adapter
       * mà ta **không biên dịch** — một `.js` đã build, một adapter của bên thứ ba — và ở
       * đó `scope` có thể là bất kỳ chuỗi nào.
       */
      assert(
        VALID_SCOPES.includes(adapter.scope),
        `scope "${adapter.scope}" không hợp lệ`,
      );
      await Promise.resolve();
    },
  },
  {
    name: "provides khai version semver đầy đủ, không phải '2'",
    designCheckId: null,
    async run(adapter) {
      for (const p of adapter.capabilities.provides) {
        assert(
          /^\d+\.\d+\.\d+/.test(p.version),
          `provides ${p.id} khai version "${p.version}" thiếu thành phần`,
        );
      }
      await Promise.resolve();
    },
  },
  {
    name: "anyOf trong requires phải có từ HAI nhánh",
    designCheckId: null,
    async run(adapter) {
      for (const r of adapter.capabilities.requires) {
        if ("anyOf" in r) {
          assert(
            r.anyOf.length >= 2,
            `anyOf một nhánh là một requirement viết dài dòng (${r.anyOf.length} nhánh)`,
          );
        }
      }
      await Promise.resolve();
    },
  },
  {
    name: "hint chỉ trỏ tới capability CÓ trong requires",
    designCheckId: null,
    async run(adapter) {
      const needed = new Set(
        adapter.capabilities.requires.flatMap((r) =>
          "anyOf" in r ? r.anyOf.map((x) => x.id) : [r.id],
        ),
      );
      for (const key of Object.keys(adapter.capabilities.hint ?? {})) {
        assert(
          needed.has(key as never),
          `hint có "${key}" mà requires không cần — một gợi ý không bao giờ hiện ra`,
        );
      }
      await Promise.resolve();
    },
  },
  {
    name: "conflicts không trỏ tới CHÍNH NÓ",
    designCheckId: null,
    async run(adapter) {
      const self = `${adapter.domainType.toLowerCase()}:${adapter.toolId.toLowerCase()}`;
      assert(
        !(adapter.capabilities.conflicts ?? []).some(
          (c) => c.toLowerCase() === self,
        ),
        "conflicts trỏ tới chính nó ⇒ adapter không bao giờ bật được",
      );
      await Promise.resolve();
    },
  },

  // ---------------------------------------------------------------- identity của cluster
  {
    /**
     * Adapter dùng identity `tooling`, không phải `workload` hay `traffic` (§12.2).
     *
     * Ba ServiceAccount có ClusterRole rời nhau, và `udp-tooling` là cái dành cho domain
     * adapter. Dùng sai identity nghĩa là adapter chạy bằng quyền của Service 1 hoặc
     * Service 3 — bất biến I25 vỡ trong im lặng, vì API server không từ chối gì cả.
     */
    name: "chỉ xin client với identity 'tooling'",
    designCheckId: null,
    async run(adapter, env) {
      env.cluster.reset();
      await adapter.deploy(env.context(), env.fixture.validConfig);
      const wrong = env.cluster.calls.filter((c) => c.identity !== "tooling");
      assert(
        wrong.length === 0,
        `dùng identity khác tooling: ${[...new Set(wrong.map((c) => c.identity))].join(",")}`,
      );
    },
  },
  {
    name: "configure() chạy được độc lập với deploy()",
    designCheckId: null,
    async run(adapter, env) {
      const res = await adapter.configure(
        env.context(),
        env.fixture.validConfig,
      );
      assert(
        res.status === "SUCCESS",
        `configure phải SUCCESS, thấy ${res.status}`,
      );
    },
  },
  {
    name: "healthcheck TRƯỚC deploy KHÔNG được ném",
    designCheckId: null,
    async run(adapter, env) {
      /**
       * Trả `healthy: false` là câu trả lời đúng; ném là sai.
       *
       * `healthcheck` là thứ Portal gọi để hiện trạng thái, nên nó phải trả lời được cho
       * mọi trạng thái — kể cả "chưa cài gì".
       */
      const res = await adapter.healthcheck(env.context());
      assert(
        res.status === "SUCCESS" || res.status === "FAILED",
        "healthcheck phải trả kết quả, không được ném",
      );
    },
  },
  {
    name: "teardown hai lần liên tiếp đều SUCCESS",
    designCheckId: null,
    async run(adapter, env) {
      await adapter.deploy(env.context(), env.fixture.validConfig);
      const first = await adapter.teardown(env.context(), "disable");
      const second = await adapter.teardown(env.context(), "disable");
      assert(first.status === "SUCCESS", "teardown lần đầu phải SUCCESS");
      assert(
        second.status === "SUCCESS",
        "teardown lần hai phải SUCCESS — compensation chạy lại phải idempotent",
      );
    },
  },
  {
    name: "progress được gọi ít nhất một lần khi deploy",
    designCheckId: null,
    async run(adapter, env) {
      env.progressLog.length = 0;
      await adapter.deploy(env.context(), env.fixture.validConfig);
      assert(
        env.progressLog.length > 0,
        "deploy phải báo tiến trình; §8.1 stream nó về cho người dùng",
      );
    },
  },
  {
    name: "deploy đọc endpoint của dependency từ ctx.resolved, không tự đoán",
    designCheckId: null,
    async run(adapter, env) {
      const needs = adapter.capabilities.requires.length > 0;
      if (!needs) {
        await Promise.resolve();
        return;
      }
      /**
       * `resolved` RỖNG mà adapter vẫn deploy thành công là một dấu hiệu xấu: nó nghĩa là
       * adapter đang tự đoán endpoint (hardcode một service name) thay vì đọc binding —
       * và điều đó vỡ ngay khi người dùng đổi provider.
       */
      await expectThrowsOrFails(
        () =>
          adapter.deploy(
            env.context({ resolved: {} }),
            env.fixture.validConfig,
          ),
        "adapter có requires mà deploy được với resolved rỗng ⇒ nó tự đoán endpoint",
      );
    },
  },
];

/**
 * Chạy bộ hợp đồng cho một adapter.
 *
 * `api` được TIÊM VÀO nên tệp này không import vitest — cùng lý lẽ với bộ hợp đồng Cloud
 * và Ledger: `./contract` là thứ adapter bên ngoài import được, và một dependency vào
 * test runner ở đó sẽ buộc mọi người dùng cài vitest.
 *
 * `makeEnv` là một HÀM: mỗi phép nhận môi trường MỚI (Plan #31 P2). Dùng chung một môi
 * trường làm các phép ảnh hưởng nhau qua kho đối tượng của cluster giả — phép `teardown`
 * xoá ConfigMap và phép `detectDrift` chạy sau thấy drift vì lý do của phép trước; một bộ
 * test mà thứ tự quyết định kết quả thì không nói được gì.
 */
export function runDomainAdapterContract(
  adapter: DomainAdapter,
  makeEnv: () => DomainContractEnv,
  api: TestRunnerApi,
): void {
  api.describe(
    `hợp đồng Domain Adapter: ${adapter.domainType}:${adapter.toolId}`,
    () => {
      for (const check of DOMAIN_CONTRACT_CHECKS) {
        api.it(check.name, async () => {
          await check.run(adapter, makeEnv());
        });
      }
    },
  );
}
