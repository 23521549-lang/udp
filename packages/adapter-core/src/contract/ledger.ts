import type { ProvisionedResourceRow } from "../ledger.js";
import type { Ledger, LedgerIntent } from "../runner/index.js";

/**
 * [v4.10] Bộ hợp đồng cho chính cổng `Ledger` — chạy trên MỌI hiện thực.
 *
 * Vì sao bộ này tồn tại: lưới khôi phục có hai tầng, và tầng 1 (130 ô, in-process) dùng
 * `InMemoryLedger` còn tầng 2 dùng `PrismaLedger`. Nếu hai hiện thực lệch ngữ nghĩa thì
 * 129 trong 130 ô của tầng 1 mất giá trị chứng minh, và điều đó **không lộ ra** ở bất kỳ
 * ô nào của lưới — chúng đều xanh, chỉ là chúng đang chứng minh một thứ khác.
 *
 * Bộ này là **dữ liệu**, không phải một `describe()` cứng, vì cùng ba lý do của bộ hợp
 * đồng Cloud: đếm được số phép đã chạy, dùng lại y nguyên cho hiện thực thứ hai, và một
 * phép bị bỏ là một con số đổi chứ không phải một dòng biến mất trong diff.
 */

/** Cách một môi trường test cung cấp một sổ RỖNG mới cho mỗi phép kiểm */
export type LedgerFactory = () => Ledger | Promise<Ledger>;

export interface LedgerCheck {
  name: string;
  run(makeLedger: LedgerFactory): Promise<void>;
}

/** API tối thiểu của một test runner, TIÊM VÀO để `./contract` không import vitest */
export interface TestRunnerApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
}

const PROJECT = "11111111-1111-4111-8111-111111111111";

function intentOf(
  name: string,
  over: Partial<LedgerIntent> = {},
): LedgerIntent {
  return {
    projectId: PROJECT,
    step: "NETWORK",
    kind: "vpc",
    idempotencyKey: `${PROJECT}:NETWORK:vpc:${name}`,
    provider: "aws",
    region: "ap-southeast-1",
    ...over,
  };
}

/** Một khẳng định tối giản, để `./contract` không phụ thuộc thư viện assert nào */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function expectThrows(
  fn: () => Promise<unknown>,
  message: string,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

async function newLedger(makeLedger: LedgerFactory): Promise<Ledger> {
  return await makeLedger();
}

export const LEDGER_CONTRACT_CHECKS: readonly LedgerCheck[] = [
  {
    name: "intend ghi một hàng CREATING với providerId null",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      const row = await ledger.byKey(intent.idempotencyKey);
      assert(row !== null, "phải có hàng sau intend");
      assert(
        (row as ProvisionedResourceRow).status === "CREATING",
        "phải ở CREATING",
      );
      assert(
        (row as ProvisionedResourceRow).providerId === null,
        "providerId phải null: đây chính là trạng thái của điểm crash K2/K3",
      );
    },
  },
  {
    /**
     * Sau crash ở K2 hay K3, hàng đã ở `CREATING` và runner gọi lại `intend` trên đúng
     * khoá đó. `intend` mà ném thì resume không chạy được, và hai ô đó đỏ vì lý do sai.
     */
    name: "intend lần hai trên hàng CREATING là idempotent (điều kiện để K2/K3 resume được)",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.intend(intent);
      const rows = await ledger.rowsOf(PROJECT);
      assert(
        rows.length === 1,
        `phải còn đúng một hàng, thấy ${String(rows.length)}`,
      );
    },
  },
  {
    name: "intend trên hàng đã READY thì NÉM — không ai được tạo lại thứ đã có",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.markCreated(intent.idempotencyKey, "vpc-1");
      await ledger.markReady(intent.idempotencyKey);
      await expectThrows(
        () => ledger.intend(intent),
        "intend trên hàng READY phải ném",
      );
    },
  },
  {
    name: "markCreated gắn providerId vào hàng ĐÃ CÓ, không tạo hàng mới (cách K3 được đóng)",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.markCreated(intent.idempotencyKey, "vpc-42");
      const rows = await ledger.rowsOf(PROJECT);
      assert(rows.length === 1, "vẫn phải là một hàng");
      assert(rows[0]?.providerId === "vpc-42", "providerId phải được gắn");
      assert(rows[0]?.status === "CREATED", "phải ở CREATED");
    },
  },
  {
    name: "chỉ READY là xong: markReady chỉ đi được từ CREATED",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await expectThrows(
        () => ledger.markReady(intent.idempotencyKey),
        "markReady từ CREATING phải ném",
      );
      await ledger.markCreated(intent.idempotencyKey, "vpc-1");
      await ledger.markReady(intent.idempotencyKey);
      const row = await ledger.byKey(intent.idempotencyKey);
      assert(
        (row as ProvisionedResourceRow).status === "READY",
        "phải ở READY",
      );
    },
  },
  {
    /**
     * Hai cạnh này là bổ sung của v4.10. Bản v4.9 không có chúng, nên compensation một
     * hàng chưa `READY` là bất hợp pháp — mà đó là ca thường xuyên nhất sau crash.
     */
    name: "compensation đi được từ CREATING và từ CREATED, không chỉ từ READY",
    async run(makeLedger) {
      const a = await newLedger(makeLedger);
      const i1 = intentOf("a");
      await a.intend(i1);
      await a.markDeleting(i1.idempotencyKey);
      await a.markDeleted(i1.idempotencyKey);

      const b = await newLedger(makeLedger);
      const i2 = intentOf("b");
      await b.intend(i2);
      await b.markCreated(i2.idempotencyKey, "vpc-2");
      await b.markDeleting(i2.idempotencyKey);
      await b.markDeleted(i2.idempotencyKey);

      const rowA = await a.byKey(i1.idempotencyKey);
      const rowB = await b.byKey(i2.idempotencyKey);
      assert(
        (rowA as ProvisionedResourceRow).status === "DELETED",
        "A phải DELETED",
      );
      assert(
        (rowB as ProvisionedResourceRow).status === "DELETED",
        "B phải DELETED",
      );
    },
  },
  {
    name: "markDeleted chỉ đi được từ DELETING",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.markCreated(intent.idempotencyKey, "vpc-1");
      await ledger.markReady(intent.idempotencyKey);
      await expectThrows(
        () => ledger.markDeleted(intent.idempotencyKey),
        "markDeleted từ READY phải ném",
      );
    },
  },
  {
    /**
     * `ORPHAN_SUSPECTED` chỉ nhận cạnh vào từ hai ca §4.5 thật sự nêu: `delete()` thất
     * bại quá số lần thử (từ `DELETING`), và `lookup()` thấy tài nguyên không khớp sổ
     * (từ `CREATING`). Một lỗi TẠM như `indeterminate` **không** được dẫn tới đây, vì
     * trạng thái đó không có cạnh ra.
     */
    name: "ORPHAN_SUSPECTED chỉ đi được từ CREATING và DELETING",
    async run(makeLedger) {
      const a = await newLedger(makeLedger);
      const i1 = intentOf("a");
      await a.intend(i1);
      await a.markOrphanSuspected(
        i1.idempotencyKey,
        "lookup thấy thứ không khớp sổ",
      );

      const b = await newLedger(makeLedger);
      const i2 = intentOf("b");
      await b.intend(i2);
      await b.markCreated(i2.idempotencyKey, "vpc-2");
      await b.markReady(i2.idempotencyKey);
      await expectThrows(
        () => b.markOrphanSuspected(i2.idempotencyKey, "không hợp lệ"),
        "ORPHAN_SUSPECTED từ READY phải ném",
      );
    },
  },
  {
    name: "ORPHAN_SUSPECTED là trạng thái cuối — không đi tiếp được đâu",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.markOrphanSuspected(intent.idempotencyKey, "vì sao");
      for (const step of [
        () => ledger.markCreated(intent.idempotencyKey, "x"),
        () => ledger.markReady(intent.idempotencyKey),
        () => ledger.markDeleting(intent.idempotencyKey),
        () => ledger.markDeleted(intent.idempotencyKey),
      ]) {
        await expectThrows(step, "không cạnh nào ra khỏi ORPHAN_SUSPECTED");
      }
    },
  },
  {
    name: "lý do của ORPHAN_SUSPECTED không bị nuốt",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.markOrphanSuspected(
        intent.idempotencyKey,
        "delete thất bại 5 lần",
      );
      const withReason = ledger as unknown as {
        orphanReasonOf?: (k: string) => string | undefined;
      };
      if (typeof withReason.orphanReasonOf === "function") {
        assert(
          withReason.orphanReasonOf(intent.idempotencyKey) ===
            "delete thất bại 5 lần",
          "lý do phải đọc lại được",
        );
      }
    },
  },
  {
    name: "byKey trả null cho khoá không có, không ném",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      assert((await ledger.byKey("khong-co")) === null, "phải trả null");
    },
  },
  {
    name: "mọi lời gọi mark* trên khoá không có đều NÉM",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      for (const step of [
        () => ledger.markCreated("khong-co", "x"),
        () => ledger.markReady("khong-co"),
        () => ledger.markDeleting("khong-co"),
        () => ledger.markDeleted("khong-co"),
        () => ledger.markOrphanSuspected("khong-co", "r"),
      ]) {
        await expectThrows(step, "mark* trên khoá lạ phải ném");
      }
    },
  },
  {
    /**
     * ADR-08: thứ tự compensation **không** nằm trong sổ dưới dạng một cột, nó suy từ
     * thứ tự đã ghi. Nên `rowsOf` phải giữ thứ tự chèn, và compensation chạy ngược nó.
     */
    name: "rowsOf giữ THỨ TỰ CHÈN — compensation chạy ngược danh sách này",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const names = ["vpc", "subnet-a", "igw", "nat"];
      for (const n of names) await ledger.intend(intentOf(n));
      const rows = await ledger.rowsOf(PROJECT);
      assert(
        rows.map((r) => r.idempotencyKey.split(":").at(-1)).join(",") ===
          names.join(","),
        `thứ tự phải là ${names.join(",")}`,
      );
    },
  },
  {
    name: "rowsOf cô lập theo project — sổ của project khác không lẫn vào",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const other = "22222222-2222-4222-8222-222222222222";
      await ledger.intend(intentOf("a"));
      await ledger.intend(
        intentOf("b", {
          projectId: other,
          idempotencyKey: `${other}:NETWORK:vpc:b`,
        }),
      );
      assert(
        (await ledger.rowsOf(PROJECT)).length === 1,
        "project A có một hàng",
      );
      assert(
        (await ledger.rowsOf(other)).length === 1,
        "project B có một hàng",
      );
    },
  },
  {
    /**
     * Trả bản sao, không trả tham chiếu.
     *
     * Nếu `byKey` trả chính đối tượng trong sổ thì một test (hay một đoạn mã) sửa nó sẽ
     * đổi trạng thái sổ mà không đi qua một cạnh nào — và toàn bộ máy trạng thái thành
     * trang trí. Bản Postgres không có cách nào rò tham chiếu, nên nếu bản trong bộ nhớ
     * làm được thì hai hiện thực lệch nhau ở đúng chỗ nguy hiểm.
     */
    name: "byKey và rowsOf trả BẢN SAO, sửa nó không đổi sổ",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      const row = (await ledger.byKey(
        intent.idempotencyKey,
      )) as ProvisionedResourceRow;
      row.status = "READY";
      row.providerId = "bi-sua";
      const again = (await ledger.byKey(
        intent.idempotencyKey,
      )) as ProvisionedResourceRow;
      assert(again.status === "CREATING", "sổ không được đổi theo bản sao");
      assert(
        again.providerId === null,
        "providerId không được đổi theo bản sao",
      );
    },
  },
  {
    name: "một project có thể có nhiều step khác nhau, mỗi khoá một hàng",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      await ledger.intend(intentOf("vpc"));
      await ledger.intend(
        intentOf("cluster", {
          step: "CLUSTER",
          kind: "cluster",
          idempotencyKey: `${PROJECT}:CLUSTER:cluster:cluster`,
        }),
      );
      await ledger.intend(
        intentOf("elb", {
          step: "K8S_MANAGED",
          kind: "k8s-loadbalancer",
          idempotencyKey: `${PROJECT}:K8S_MANAGED:k8s-loadbalancer:elb`,
        }),
      );
      const rows = await ledger.rowsOf(PROJECT);
      assert(rows.length === 3, "ba hàng");
      assert(
        rows.some((r) => r.step === "K8S_MANAGED"),
        "K8S_MANAGED là cách SỔ biểu diễn tài nguyên do Kubernetes sinh",
      );
    },
  },
];

/**
 * Vỏ mỏng map danh sách trên sang `it()`.
 *
 * `api` được **tiêm vào** thay vì `import { describe, it } from "vitest"`, để subpath
 * `./contract` không kéo một test runner vào đồ thị phụ thuộc của package. Một adapter
 * do người ngoài nhóm viết (kiểm soát (b) của E1) có thể dùng runner khác.
 */
export function runLedgerContract(
  api: TestRunnerApi,
  label: string,
  makeLedger: LedgerFactory,
): void {
  api.describe(`hợp đồng Ledger: ${label}`, () => {
    for (const check of LEDGER_CONTRACT_CHECKS) {
      api.it(check.name, async () => {
        await check.run(makeLedger);
      });
    }
  });
}
