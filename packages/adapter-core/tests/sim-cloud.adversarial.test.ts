import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KINDS_WITH_IDEMPOTENCY_TOKEN,
  KINDS_WITHOUT_CREATE_TAGS,
  SIM_DEPENDENCY_VIOLATION,
  SIM_SEPARATE_TAGGING_REJECTED,
  SIM_THROTTLE,
  SimCloud,
  SimCloudError,
} from "../src/testing/sim-cloud.js";

/**
 * [v4.10] Bộ test ĐỐI THỦ cho chính cloud mô phỏng.
 *
 * Vì sao nó tồn tại và vì sao nó phải xanh TRƯỚC lưới K: lưới khôi phục là bằng chứng
 * của C3, và nó chạy trên lớp mô phỏng này. Một lớp mô phỏng dễ tính làm cả mười ô xanh
 * với một runner rỗng, và điều đó **không lộ ra** — lưới xanh, báo cáo đẹp, và adapter
 * AWS đầu tiên viết ở plan sau sẽ tạo hai VPC.
 *
 * Nên cloud mô phỏng không phải một stub mà là **một phần của bộ đo**, và độ ác của nó
 * phải được kiểm bằng một bộ test riêng. Mỗi phép dưới đây chốt một trong 14 tính chất
 * S-1..S-14 hoặc một trong ba ràng buộc oracle O-1..O-3.
 */

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OWNER = "chu@vi-du.test";
const SENTINEL = "SENT-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

let dir: string;
let statePath: string;

const cloudWith = (over: Record<string, unknown> = {}): SimCloud =>
  new SimCloud({ statePath, sentinel: SENTINEL, ...over });

const tagsFor = (name: string): Record<string, string> => ({
  "udp.project": PROJECT,
  "udp.key": `${PROJECT}:NETWORK:vpc:${name}`,
  "udp.owner": OWNER,
  "udp.managed": "true",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "simcloud-"));
  statePath = join(dir, "cloud.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("S-1 — state nằm NGOÀI tiến trình", () => {
  it("ghi ra file, và một thực thể MỚI đọc lại được", () => {
    const a = cloudWith();
    a.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: `${PROJECT}:NETWORK:vpc:vpc`,
    });
    expect(existsSync(statePath)).toBe(true);

    // Một thực thể khác, như thể tiến trình đã chết và chạy lại
    const b = cloudWith();
    expect(b.findByTag("udp.project", PROJECT)).toHaveLength(1);
  });

  /**
   * Đã đo (R24-6): `kill -9` đúng giữa `writeFileSync(tmp)` và `renameSync` để lại file
   * `.tmp` trong 20/20 lượt. Đọc nó là đọc một file nửa vời.
   */
  it("bỏ qua VÀ dọn file .tmp còn sót — không bao giờ đọc nó", () => {
    const a = cloudWith();
    a.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: "k",
    });
    writeFileSync(`${statePath}.tmp`, '{"rac":');
    const b = cloudWith();
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
    expect(b.findByTag("udp.project", PROJECT)).toHaveLength(1);
  });

  it("file luôn là JSON hợp lệ sau mỗi lần ghi", () => {
    const c = cloudWith();
    for (let i = 0; i < 5; i += 1) {
      c.createResource({
        kind: "subnet",
        name: `s${String(i)}`,
        tags: tagsFor(`s${String(i)}`),
        idempotencyKey: `k${String(i)}`,
      });
      expect(() => JSON.parse(readFileSync(statePath, "utf8"))).not.toThrow();
    }
  });
});

describe("S-2 — tách commit và respond (đây là toàn bộ nội dung của K3)", () => {
  /**
   * Nếu cloud mô phỏng không tách hai mốc này thì K3 **biến thành K2**: cả hai ô đều là
   * "kill ở ranh giới lời gọi runner", cùng xanh vì cùng một lý do, và ô quyết định của
   * C3 không được kiểm.
   */
  it("commit-then-timeout: tài nguyên ĐÃ tồn tại trên cloud dù lời gọi ném", async () => {
    const c = cloudWith();
    await c.failNthCall("vpc", 1, "commit-then-timeout");
    expect(() =>
      c.createResource({
        kind: "vpc",
        name: "vpc",
        tags: tagsFor("vpc"),
        idempotencyKey: `${PROJECT}:NETWORK:vpc:vpc`,
      }),
    ).toThrow();

    // Client không biết id, nhưng cloud thì có — đây chính là cửa sổ K3
    const found = c.findByTag("udp.key", `${PROJECT}:NETWORK:vpc:vpc`);
    expect(found).toHaveLength(1);
  });

  it("lỗi tiêm chỉ dùng MỘT lần, lượt sau chạy bình thường", async () => {
    const c = cloudWith();
    await c.failNthCall("vpc", 1, "commit-then-timeout");
    expect(() =>
      c.createResource({
        kind: "vpc",
        name: "a",
        tags: tagsFor("a"),
        idempotencyKey: "a",
      }),
    ).toThrow();
    expect(() =>
      c.createResource({
        kind: "vpc",
        name: "b",
        tags: tagsFor("b"),
        idempotencyKey: "b",
      }),
    ).not.toThrow();
  });
});

describe("S-3 — KHÔNG idempotency token cho vpc/subnet", () => {
  /**
   * Đây là xanh giả nặng nhất của cả lưới: nếu cloud mô phỏng idempotent theo khoá thì
   * "không tạo trùng" trở thành tính chất của CLOUD, không của runner — và cả mười ô
   * xanh với một runner rỗng.
   */
  it("gọi create hai lần cùng idempotencyKey ⇒ HAI id khác nhau", () => {
    const c = cloudWith();
    const key = `${PROJECT}:NETWORK:vpc:vpc`;
    const first = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: key,
    });
    const second = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: key,
    });
    expect(second.id).not.toBe(first.id);
    expect(c.findByTag("udp.key", key)).toHaveLength(2);
  });

  it("cluster CÓ token, nên gọi hai lần trả về CÙNG một tài nguyên", () => {
    const c = cloudWith();
    const key = `${PROJECT}:CLUSTER:cluster:main`;
    const a = c.createResource({
      kind: "cluster",
      name: "main",
      tags: { ...tagsFor("main"), "udp.key": key },
      idempotencyKey: key,
    });
    const b = c.createResource({
      kind: "cluster",
      name: "main",
      tags: { ...tagsFor("main"), "udp.key": key },
      idempotencyKey: key,
    });
    expect(b.id).toBe(a.id);
  });

  it("hai họ kind đó rời nhau và không rỗng", () => {
    expect(KINDS_WITH_IDEMPOTENCY_TOKEN.length).toBeGreaterThan(0);
    expect(KINDS_WITHOUT_CREATE_TAGS.length).toBeGreaterThan(0);
    for (const k of KINDS_WITH_IDEMPOTENCY_TOKEN) {
      expect(KINDS_WITHOUT_CREATE_TAGS).not.toContain(k);
    }
  });
});

describe("S-4 và S-5 — tag lúc tạo, và API tag riêng", () => {
  it("route-table KHÔNG nhận tag lúc tạo ⇒ buộc tra theo tên tất định", () => {
    const c = cloudWith();
    const r = c.createResource({
      kind: "route-table",
      name: "rtb-public",
      tags: tagsFor("rtb"),
      idempotencyKey: "k",
    });
    expect(Object.keys(r.tags)).toHaveLength(0);
    expect(c.findByTag("udp.project", PROJECT)).toHaveLength(0);
    expect(c.findByName("route-table", "rtb-public")?.id).toBe(r.id);
  });

  it("vpc thì nhận đủ tag TRONG CÙNG lời gọi tạo", () => {
    const c = cloudWith();
    const r = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: "k",
    });
    expect(Object.keys(r.tags).sort()).toEqual([
      "udp.key",
      "udp.managed",
      "udp.owner",
      "udp.project",
    ]);
  });

  /**
   * API tag riêng PHẢI tồn tại, để phép kiểm "gắn đủ tag trong cùng lời gọi" có thứ bắt.
   * Một cloud mô phỏng không có nó thì phép kiểm đó không bắt được gì.
   */
  it("API tag riêng tồn tại, và cờ rejectSeparateTagging chặn được nó", () => {
    const c = cloudWith();
    const r = c.createResource({
      kind: "route-table",
      name: "rtb",
      tags: {},
      idempotencyKey: "k",
    });
    c.tagResource(r.id, { "udp.project": PROJECT });
    expect(c.describeById(r.id)?.tags["udp.project"]).toBe(PROJECT);

    const strict = cloudWith({ rejectSeparateTagging: true });
    let code: string | undefined;
    try {
      strict.tagResource(r.id, { x: "y" });
    } catch (e) {
      code = (e as SimCloudError).code;
    }
    expect(code).toBe(SIM_SEPARATE_TAGGING_REJECTED);
  });
});

describe("S-6 và S-7 — sửa từ ngoài luồng", () => {
  it("khách xoá tag udp.key: tra theo tag mất, tra theo id còn (điểm crash K8)", async () => {
    const c = cloudWith();
    const key = `${PROJECT}:NETWORK:vpc:vpc`;
    const r = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: key,
    });
    await c.removeTag(r.id, "udp.key");
    expect(c.findByTag("udp.key", key)).toHaveLength(0);
    expect(c.describeById(r.id)?.id).toBe(r.id);
  });

  it("khách xoá tài nguyên: cả hai đường tra đều mất (điểm crash K7)", async () => {
    const c = cloudWith();
    const r = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: "k",
    });
    await c.deleteOutOfBand(r.id);
    expect(c.describeById(r.id)).toBeNull();
    expect(c.findByTag("udp.project", PROJECT)).toHaveLength(0);
  });
});

describe("S-8 và S-9 — ngữ nghĩa xoá", () => {
  it("xoá thứ đã mất trả not-found, KHÔNG ném (NOT_FOUND là thành công)", () => {
    const c = cloudWith();
    expect(c.deleteResource("khong-co")).toBe("not-found");
  });

  /**
   * Không có tính chất này thì phép kiểm "teardown xoá K8S_MANAGED TRƯỚC network" xanh
   * dù adapter **không hề chờ** ELB/ENI biến mất — đúng lỗi "chỉ lộ ra khi hoá đơn về".
   */
  it("xoá VPC còn k8s-* tham chiếu ⇒ ném DependencyViolation", async () => {
    const c = cloudWith();
    const vpc = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: "k",
    });
    const elb = await c.seedK8sManaged({
      kind: "k8s-loadbalancer",
      clusterName: "main",
      attachedTo: vpc.id,
    });

    /** Khẳng định theo MÃ, không theo thông điệp: thông điệp là văn, mã là hợp đồng */
    let code: string | undefined;
    try {
      c.deleteResource(vpc.id);
    } catch (e) {
      code = (e as SimCloudError).code;
    }
    expect(code).toBe(SIM_DEPENDENCY_VIOLATION);
    expect(c.deleteResource(elb.id)).toBe("deleted");
    expect(c.deleteResource(vpc.id)).toBe("deleted");
  });
});

describe("S-10 — tài nguyên do Kubernetes sinh", () => {
  it("mang tag kubernetes.io/cluster/* và giữ tham chiếu VPC", async () => {
    const c = cloudWith();
    const vpc = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: "k",
    });
    const eni = await c.seedK8sManaged({
      kind: "k8s-eni",
      clusterName: "main",
      attachedTo: vpc.id,
    });
    expect(eni.tags["kubernetes.io/cluster/main"]).toBe("owned");
    expect(eni.managedByK8s).toBe(true);
    /** Không mang tag `udp.*`, nên `listTaggedResources` theo project KHÔNG thấy nó */
    expect(c.findByTag("udp.project", PROJECT).map((r) => r.id)).not.toContain(
      eni.id,
    );
  });
});

describe("S-11 — waitReady cần N lần poll", () => {
  it("CREATED và READY là hai đỉnh khác nhau", () => {
    const c = cloudWith({ waitReadyPolls: 3 });
    const r = c.createResource({
      kind: "cluster",
      name: "main",
      tags: tagsFor("main"),
      idempotencyKey: "k",
    });
    expect(c.pollReady(r.id)).toBe(false);
    expect(c.pollReady(r.id)).toBe(false);
    expect(c.pollReady(r.id)).toBe(true);
  });
});

describe("S-12 — cửa sổ lan truyền tag (đối tượng của ô K2b)", () => {
  /**
   * Đây là nguồn lỗi "tạo trùng" thật trên AWS: `tag:GetResources` là nhất quán cuối, nên
   * một tag vừa gắn có thể chưa thấy trong vài giây. Runner đọc "không thấy" thành "không
   * có" sẽ `create()` lần hai.
   */
  it("trong cửa sổ, tra theo tag KHÔNG thấy tài nguyên vừa tạo", () => {
    const c = cloudWith({ tagPropagationDelayMs: 10_000 });
    const key = `${PROJECT}:NETWORK:vpc:vpc`;
    const r = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: key,
    });
    expect(c.findByTag("udp.key", key)).toHaveLength(0);
    /** Nhưng nó TỒN TẠI — tra theo id thấy ngay */
    expect(c.describeById(r.id)?.id).toBe(r.id);
  });

  it("đặt độ trễ về 0 thì thấy ngay", async () => {
    const c = cloudWith({ tagPropagationDelayMs: 10_000 });
    const key = `${PROJECT}:NETWORK:vpc:vpc`;
    c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: key,
    });
    await c.setTagPropagationDelay(0);
    expect(c.findByTag("udp.key", key)).toHaveLength(1);
  });
});

describe("S-13 — nhật ký lời gọi có thứ tự, và phân trang", () => {
  it("ghi đủ verb theo đúng thứ tự, kèm danh tính worker", async () => {
    const c = cloudWith({ workerId: "worker-A" });
    const r = c.createResource({
      kind: "vpc",
      name: "vpc",
      tags: tagsFor("vpc"),
      idempotencyKey: "k",
    });
    c.pollReady(r.id);
    c.deleteResource(r.id);
    const verbs = (await c.calls()).map((x) => x.verb);
    expect(verbs).toEqual(["create", "pollReady", "delete"]);
    expect((await c.calls()).every((x) => x.workerId === "worker-A")).toBe(
      true,
    );
  });

  /**
   * Trang cỡ 2 có chủ đích: một hiện thực chỉ đọc trang đầu sẽ thấy 2 tài nguyên và
   * `rebuildLedgerFromCloud` dựng lại một sổ THIẾU — nhưng vẫn "thành công".
   */
  it("phân trang cỡ 2: đọc một trang là thấy thiếu", () => {
    const c = cloudWith();
    for (const n of ["a", "b", "c", "d", "e"]) {
      c.createResource({
        kind: "subnet",
        name: n,
        tags: { ...tagsFor(n), "udp.project": PROJECT },
        idempotencyKey: n,
      });
    }
    const first = c.listTaggedPage(PROJECT);
    expect(first.items).toHaveLength(2);
    expect(first.next).toBeDefined();

    let cursor = first.next;
    let total = first.items.length;
    let guard = 0;
    while (cursor !== undefined && guard < 10) {
      const page = c.listTaggedPage(PROJECT, cursor);
      total += page.items.length;
      cursor = page.next;
      guard += 1;
    }
    expect(total).toBe(5);
  });
});

describe("S-14 — mặt cho bốn phương thức còn lại của §4.2", () => {
  it("preflight có credential THIẾU QUYỀN có chủ đích", () => {
    const c = cloudWith();
    expect(c.missingPermissionsFor("thieu-quyen")).toEqual([
      "eks:CreateCluster",
      "ec2:CreateVpc",
    ]);
    expect(c.missingPermissionsFor("du-quyen")).toEqual([]);
  });

  it("getClusterStatus và getKubeAuthToken có mặt", () => {
    const c = cloudWith();
    const cluster = c.createResource({
      kind: "cluster",
      name: "main",
      tags: tagsFor("main"),
      idempotencyKey: "k",
    });
    expect(c.clusterStatusOf(cluster.id)).toBe("READY");
    expect(c.clusterStatusOf("khong-co")).toBe("ERROR");
    const token = c.kubeTokenFor(cluster.id);
    expect(token.token).toContain(cluster.id);
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("O-2 — nhiễu bắt buộc", () => {
  it("bốn loại nhiễu, và chỉ một loại có thể bị nhầm là của project", async () => {
    const c = cloudWith();
    await c.seedNoise(PROJECT, OWNER);
    const all = await c.listAll();
    expect(all).toHaveLength(4);

    /** Project khác: cùng đủ tag `udp.*` nhưng `udp.project` khác */
    expect(
      all.find((r) => r.id === "noise-other-project")?.tags["udp.project"],
    ).not.toBe(PROJECT);
    /** Của khách: không tag nào */
    expect(
      Object.keys(
        all.find((r) => r.id === "noise-customer-untagged")?.tags ?? {},
      ),
    ).toHaveLength(0);
    /** `udp.project` đúng nhưng `udp.managed` khác "true" ⇒ phải vào `unmatched` */
    expect(
      all.find((r) => r.id === "noise-not-managed")?.tags["udp.managed"],
    ).toBe("false");
    /** Region khác */
    expect(all.find((r) => r.id === "noise-other-region")?.region).toBe(
      "us-east-1",
    );
  });
});

describe("lỗi CHỦ ĐỘNG ÁC — mọi lỗi đều mang thứ trông như credential", () => {
  /**
   * Nếu cloud mô phỏng ném `new Error("boom")` trần thì phép quét "không log credential"
   * xanh **vô nghĩa**: nó quét một lỗi không có gì để rò. AWS SDK v3 để credential trong
   * `err.$metadata` và `err.config`, nên cloud mô phỏng phải làm y như vậy.
   */
  it("lỗi mang sentinel ở err.config, err.$metadata và err.cause lồng bốn cấp", async () => {
    const c = cloudWith();
    await c.failNthCall("vpc", 1, "throttle");
    let caught: unknown;
    try {
      c.createResource({
        kind: "vpc",
        name: "vpc",
        tags: tagsFor("vpc"),
        idempotencyKey: "k",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SimCloudError);
    expect((caught as SimCloudError).code).toBe(SIM_THROTTLE);

    const dumped = inspect(caught, { depth: null });
    expect(dumped).toContain(SENTINEL);
    const asRecord = caught as Record<string, unknown>;
    expect(JSON.stringify(asRecord["config"])).toContain(SENTINEL);
    expect(JSON.stringify(asRecord["$metadata"])).toContain(SENTINEL);
    expect(JSON.stringify((caught as Error).cause)).toContain(SENTINEL);
  });

  it("ba hạng lỗi phân biệt được bằng mã, không phải bằng chuỗi thông điệp", async () => {
    const codes: string[] = [];
    for (const fault of ["throttle", "transient5xx", "permanent4xx"] as const) {
      /** Mỗi hạng lỗi một file state riêng: `failNthCall` đếm theo LƯỢT của từng kind */
      const c = new SimCloud({
        statePath: join(dir, `cloud-${fault}.json`),
        sentinel: SENTINEL,
      });
      await c.failNthCall("subnet", 1, fault);
      try {
        c.createResource({
          kind: "subnet",
          name: "s",
          tags: tagsFor("s"),
          idempotencyKey: "k",
        });
      } catch (e) {
        codes.push((e as SimCloudError).code);
      }
    }
    expect(new Set(codes).size).toBe(3);
  });
});
