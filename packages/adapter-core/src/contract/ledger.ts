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
 *
 * **Hai giả định mà một phép kiểm ở đây KHÔNG được đặt**, cả hai do hiện thực Postgres
 * phơi ra ở P9:
 *
 *  1. *Hai sổ từ cùng một `makeLedger` là độc lập.* Không: một sổ bền chỉ "rỗng" lại được
 *     bằng cách xoá hàng, nên lần gọi thứ hai xoá mất hàng của lần thứ nhất. Mỗi phép
 *     dùng ĐÚNG MỘT sổ, và nhiều khoá nếu cần nhiều hàng.
 *  2. *Một `projectId` tự bịa dùng được.* Không: đó là khoá ngoại. Dùng `CONTRACT_PROJECT`
 *     và `CONTRACT_PROJECT_OTHER`, và môi trường dựng tiền đề cho cả hai.
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

/**
 * Hai `projectId` mà bộ hợp đồng dùng — CÔNG KHAI, vì môi trường phải dựng chúng.
 *
 * `InMemoryLedger` chỉ cần hai chuỗi khác nhau. Sổ Postgres thì `project_id` là khoá
 * ngoại, nên một `projectId` không có hàng project tương ứng làm `INSERT` vỡ vì
 * ràng buộc chứ không vì ngụ nghĩa của sổ — một phép đỏ vì lý do sai. Hai hằng số
 * này xuất ra ngoài để môi trường tạo đủ tiền đề, thay vì để phép kiểm tự yếu đi.
 */
export const CONTRACT_PROJECT = "11111111-1111-4111-8111-111111111111";
export const CONTRACT_PROJECT_OTHER = "22222222-2222-4222-8222-222222222222";

const PROJECT = CONTRACT_PROJECT;

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

/**
 * Một khẳng định tối giản, để `./contract` không phụ thuộc thư viện assert nào.
 *
 * `asserts condition` chứ không phải `void`: nhờ vậy `assert(row !== null, ...)` THU HẸP
 * kiểu, và phép kiểm phía sau đọc `row.status` mà không cần một `as` nào. Một `as` ở chỗ
 * đó là cách một `null` đi lọt tới `.status` và báo "Cannot read properties of null" —
 * tức phép kiểm đỏ với một thông điệp không nói gì về tính chất nó đang kiểm.
 */
function assert(condition: boolean, message: string): asserts condition {
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
      assert(row.status === "CREATING", `phải ở CREATING, thấy ${row.status}`);
      assert(
        row.providerId === null,
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
    /**
     * Hàng K7: khách xoá tài nguyên, lượt sau tạo lại với id MỚI.
     *
     * Phép này khẳng định đủ ba điều, vì thiếu một điều là vô hại trên giấy mà
     * chính là lỗ rò: đi được từ `READY`, đi được từ `CREATED`, và `provider_id` cũ
     * bị XOÁ. Giữ lại id cũ thì đường tra dự phòng RUN7 của lượt sau đi tìm một
     * id đã chết, và teardown thì xoá nhầm ô trống.
     */
    name: "markRecreating đi được từ READY và từ CREATED, và XOÁ providerId (hàng K7)",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);

      const a = intentOf("a");
      await ledger.intend(a);
      await ledger.markCreated(a.idempotencyKey, "vpc-1");
      await ledger.markReady(a.idempotencyKey);
      await ledger.markRecreating(a.idempotencyKey, "khách xoá ngoài luồng");
      const afterReady = await ledger.byKey(a.idempotencyKey);
      assert(afterReady !== null, "hàng phải còn trong sổ");
      assert(
        afterReady.status === "CREATING",
        `từ READY phải về CREATING, thấy ${afterReady.status}`,
      );
      assert(
        afterReady.providerId === null,
        `provider_id cũ phải bị xoá, thấy ${String(afterReady.providerId)}`,
      );

      const b = intentOf("b");
      await ledger.intend(b);
      await ledger.markCreated(b.idempotencyKey, "subnet-1");
      await ledger.markRecreating(b.idempotencyKey, "khách xoá ngoài luồng");
      const afterCreated = await ledger.byKey(b.idempotencyKey);
      assert(
        afterCreated?.status === "CREATING",
        `từ CREATED phải về CREATING, thấy ${String(afterCreated?.status)}`,
      );

      /** Và lượt tạo lại ghi được id MỚI — điểm đến thực của cả đường này */
      await ledger.markCreated(a.idempotencyKey, "vpc-2");
      const recreated = await ledger.byKey(a.idempotencyKey);
      assert(
        recreated?.providerId === "vpc-2",
        `phải mang id mới, thấy ${String(recreated?.providerId)}`,
      );
    },
  },
  {
    /**
     * `markRecreating` là một cửa hẹp, không phải một lối tắt về `CREATING`.
     *
     * Nếu nó đi được từ `DELETED` hay `ORPHAN_SUSPECTED` thì hai trạng thái đó không
     * còn là cuối nữa, và bảo đảm "mọi hàng hội tụ" của I31 mất đáy.
     */
    name: "markRecreating KHÔNG đi được từ DELETED hay ORPHAN_SUSPECTED",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);

      const a = intentOf("a");
      await ledger.intend(a);
      await ledger.markCreated(a.idempotencyKey, "vpc-1");
      await ledger.markReady(a.idempotencyKey);
      await ledger.markDeleting(a.idempotencyKey);
      await ledger.markDeleted(a.idempotencyKey);
      await expectThrows(
        () => ledger.markRecreating(a.idempotencyKey, "không được"),
        "markRecreating từ DELETED phải ném",
      );

      const b = intentOf("b");
      await ledger.intend(b);
      await ledger.markOrphanSuspected(b.idempotencyKey, "mất dấu");
      await expectThrows(
        () => ledger.markRecreating(b.idempotencyKey, "không được"),
        "markRecreating từ ORPHAN_SUSPECTED phải ném",
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
      const only = rows[0];
      assert(only !== undefined, "hàng đầu phải có");
      assert(only.providerId === "vpc-42", "providerId phải được gắn");
      assert(only.status === "CREATED", `phải ở CREATED, thấy ${only.status}`);
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
    /**
     * MỘT sổ, hai khoá — không phải hai sổ.
     *
     * [v4.10] Bản trước của phép này gọi `makeLedger()` hai lần trong cùng một phép và
     * giả định hai sổ thu được ĐỘC LẬP. Giả định đó đúng với bản trong bộ nhớ và
     * **không thể đúng** với một sổ bền: hai sổ đều đọc ghi cùng một bảng, và cách
     * duy nhất để `makeLedger()` trả về một sổ RỖNG là xoá hàng — tức lần gọi thứ hai
     * xoá mất hàng của lần thứ nhất. Phép đó đỏ trên Postgres vì một điều không liên
     * quan đến điều nó định kiểm.
     *
     * Tính chất cần kiểm không hề cần hai sổ: hai khoá khác nhau trong cùng một sổ là
     * đủ, và đó cũng là hình thật của compensation — 13 hàng của cùng một lượt.
     */
    name: "compensation đi được từ CREATING và từ CREATED, không chỉ từ READY",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);

      /** Nhánh một: chưa biết id nào (`CREATING`) ⇒ vẫn compensation được */
      const i1 = intentOf("a");
      await ledger.intend(i1);
      await ledger.markDeleting(i1.idempotencyKey);
      await ledger.markDeleted(i1.idempotencyKey);

      /** Nhánh hai: đã có id nhưng chưa `READY` — ca thường nhất sau một lần vỡ */
      const i2 = intentOf("b");
      await ledger.intend(i2);
      await ledger.markCreated(i2.idempotencyKey, "vpc-2");
      await ledger.markDeleting(i2.idempotencyKey);
      await ledger.markDeleted(i2.idempotencyKey);

      for (const key of [i1.idempotencyKey, i2.idempotencyKey]) {
        const row = await ledger.byKey(key);
        assert(row !== null, `${key} phải còn trong sổ`);
        assert(
          row.status === "DELETED",
          `${key} phải DELETED, thấy ${String(row.status)}`,
        );
      }
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
    /**
     * Phiên bản trước của phép này chỉ khẳng định KHI hiện thục có `orphanReasonOf`,
     * tức nó xanh vô điều kiện trên mọi hiện thục không có phương thức đó — đúng
     * hình dạng "một `return` sớm theo kiểu hiện thục" mà §13.2 cấm. `reasonOf` giờ là
     * phương thức của cổng, nên phép này vô điều kiện.
     *
     * §4.5 yêu cầu `GET /admin/orphan-resources` hiển thị "**không im lặng bỏ qua**",
     * nên một hàng `ORPHAN_SUSPECTED` không đọc lại được lý do là một dòng bảo người
     * trực "có gì sai" mà không nói sai gì.
     */
    name: "lý do của ORPHAN_SUSPECTED không bị nuốt",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.markOrphanSuspected(
        intent.idempotencyKey,
        "delete thất bại 5 lần",
      );
      const reason = await ledger.reasonOf(intent.idempotencyKey);
      assert(
        reason === "delete thất bại 5 lần",
        `lý do phải đọc lại được, thấy ${String(reason)}`,
      );
    },
  },
  {
    /**
     * Lý do thuộc về MỘT trạng thái, không phải về hàng.
     *
     * Sổ bền ghi lý do vào một bảng append-only, nên không xoá được. Nếu `reasonOf`
     * trả lý do cũ sau khi hàng đã tiến lên thì một hàng `READY` lành lặn sẽ hiện kèm
     * "delete thất bại 5 lần" — sai lệch tệ hơn không có lý do, vì nó gửi người trực
     * đi điều tra một hàng không có vấn đề gì.
     *
     * Phép này đi qua hàng K7: `markRecreating` ghi lý do cho `CREATING`, rồi
     * `markCreated` đẩy hàng sang `CREATED` — và từ đó lý do không còn áp.
     */
    name: "lý do thuộc về TRẠNG THÁI đã ghi: hàng tiến lên thì reasonOf trả null",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const intent = intentOf("a");
      await ledger.intend(intent);
      await ledger.markCreated(intent.idempotencyKey, "vpc-1");
      await ledger.markReady(intent.idempotencyKey);

      /** Khách xoá ngoài luồng ⇒ tạo lại, kèm lý do */
      await ledger.markRecreating(
        intent.idempotencyKey,
        "khách xoá ngoài luồng",
      );
      const during = await ledger.reasonOf(intent.idempotencyKey);
      assert(
        during === "khách xoá ngoài luồng",
        `lý do của CREATING phải đọc được, thấy ${String(during)}`,
      );

      /** Tạo lại xong thì lý do đó không còn áp cho trạng thái mới */
      await ledger.markCreated(intent.idempotencyKey, "vpc-2");
      const after = await ledger.reasonOf(intent.idempotencyKey);
      assert(
        after === null,
        `hàng đã tiến lên thì reasonOf phải null, thấy ${String(after)}`,
      );
    },
  },
  {
    /** Khóa không có thì không có lý do — và KHÔNG được ném, giống `byKey` */
    name: "reasonOf trả null cho khóa không có, không ném",
    async run(makeLedger) {
      const ledger = await newLedger(makeLedger);
      const reason = await ledger.reasonOf("khong-ton-tai");
      assert(reason === null, "phải trả null");
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
      const other = CONTRACT_PROJECT_OTHER;
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
