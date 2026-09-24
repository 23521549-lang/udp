import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CloudAdapter } from "../src/cloud.js";
import {
  CLOUD_CONTRACT_CHECKS,
  DESIGN_CHECK_IDS,
  runCloudAdapterContract,
} from "../src/contract/cloud.js";
import type { CloudContractEnv } from "../src/contract/index.js";
import { InMemoryLedger } from "../src/testing/in-memory-ledger.js";
import { CLOUD_FIXTURE } from "../src/testing/fixture.js";
import { createSimAdapter } from "../src/testing/sim-adapter.js";
import { SimCloud } from "../src/testing/sim-cloud.js";

/**
 * [v4.10] Bộ hợp đồng Cloud Adapter, chạy trên HAI adapter.
 *
 * Hai chứ không một: một bộ hợp đồng chạy với một adapter duy nhất là test của adapter đó,
 * không phải một hợp đồng. Hai adapter khác nhau ở đúng chiều mà §4.5 quy tắc 2 nói tới —
 * một khai `lookupBy: "tag"`, một khai `"deterministic-name"` — nên đường tra cứu dự phòng
 * được CHẠY thật thay vì được hứa.
 *
 * Bộ này kiểm ADAPTER, không kiểm runner: nó gọi `lookup`/`create`/`delete` trực tiếp. Lưới
 * khôi phục K1..K10 (phép `c5` của §13.2) kiểm runner + adapter cùng nhau và nằm ở pha P8.
 */

function envFor(lookupBy: "tag" | "deterministic-name"): {
  env: CloudContractEnv;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "cloud-contract-"));
  const cloud = new SimCloud({ statePath: join(dir, "cloud.json") });

  const env: CloudContractEnv = {
    driver: "in-process",
    ledger: () => new InMemoryLedger(),
    control: cloud,
    fixture: CLOUD_FIXTURE,
    adapterWithCredentialLabel: (label) =>
      createSimAdapter({ cloud, lookupBy, credentialLabel: label }),
  };

  return { env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const lookupBy of ["tag", "deterministic-name"] as const) {
  const holders: (() => void)[] = [];
  runCloudAdapterContract(
    {
      describe: (name, fn) => {
        describe(name, () => {
          fn();
        });
      },
      it: (name, fn) => {
        it(name, async () => {
          const { env, cleanup } = envFor(lookupBy);
          holders.push(cleanup);
          try {
            await fn();
          } finally {
            cleanup();
          }
        });
      },
    },
    `sim (${lookupBy})`,
    () => envFor(lookupBy).env,
    (env) =>
      createSimAdapter({
        cloud: env.control as SimCloud,
        lookupBy,
      }) satisfies CloudAdapter,
  );
}

/**
 * Bảng truy vết: tám phép GỐC của §13.2 → phép nào trong bộ này.
 *
 * Cơ chế `designCheckId` mạnh hơn một con số `.length`: đổi tên một phép không làm mất dấu
 * nó, còn BỎ một phép gốc là một test đỏ nêu đúng mã còn thiếu.
 */
describe("bảng truy vết về §13.2", () => {
  const DESIGN = readFileSync(
    new URL("../../../docs/UDP_design.md", import.meta.url),
    "utf8",
  );

  it("có đúng 38 phép, tên không trùng", () => {
    expect(CLOUD_CONTRACT_CHECKS).toHaveLength(38);
    expect(new Set(CLOUD_CONTRACT_CHECKS.map((c) => c.name)).size).toBe(38);
  });

  /**
   * `c5` là lưới K1..K10 và nó nằm ở pha P8, nên ở pha này bảy mã còn lại phải có mặt và
   * `c5` phải là mã DUY NHẤT còn thiếu. Nói tường minh như vậy thay vì bỏ `c5` khỏi danh
   * sách: một mã biến mất khỏi danh sách là một phép gốc không còn ai theo dõi.
   */
  it("bảy mã gốc có mặt; c5 là mã duy nhất còn thiếu (lưới K nằm ở P8)", () => {
    const covered = new Set(
      CLOUD_CONTRACT_CHECKS.map((c) => c.designCheckId).filter(
        (id): id is string => id !== null,
      ),
    );
    const missing = DESIGN_CHECK_IDS.filter((id) => !covered.has(id));
    expect(missing).toEqual(["c5"]);
  });

  it("mỗi mã gốc được phủ bởi ít nhất một phép, và mã lạ thì không có", () => {
    const known = new Set(DESIGN_CHECK_IDS);
    const strange = CLOUD_CONTRACT_CHECKS.map((c) => c.designCheckId)
      .filter((id): id is string => id !== null)
      .filter((id) => !known.has(id));
    expect(strange).toEqual([]);
  });

  /**
   * Tám phép gốc phải THẬT SỰ có trong tài liệu.
   *
   * Không có phép kiểm này thì `DESIGN_CHECK_IDS` là một danh sách tự khai, và "truy vết về
   * §13.2" chỉ truy vết về chính nó.
   */
  it("tám phép gốc tồn tại trong khối runCloudAdapterContract của §13.2", () => {
    const from = DESIGN.indexOf("export function runCloudAdapterContract(");
    const to = DESIGN.indexOf(
      "**Hai base class cũng phải qua bộ test này",
      from,
    );
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const block = DESIGN.slice(from, to);

    /** Bảy `it(` cộng một `describe.each` — đúng tám phép */
    const its = [...block.matchAll(/^\s{4}it\(/gm)].length;
    const grids = [...block.matchAll(/describe\.each\(/g)].length;
    expect(its + grids).toBe(DESIGN_CHECK_IDS.length);
  });

  it("mọi phép đều có thân hàm thật, không phép nào rỗng", () => {
    for (const check of CLOUD_CONTRACT_CHECKS) {
      expect(check.run.toString().length, check.name).toBeGreaterThan(60);
    }
  });
});

/**
 * Meta-test: hợp đồng có RĂNG.
 *
 * Chạy cả 38 phép trên một adapter CỐ TÌNH SAI và đếm số phép đỏ. Một bộ hợp đồng mà không
 * phép nào đỏ trước một adapter hỏng thì nó chỉ là một danh sách tên.
 */
describe("meta — bộ hợp đồng bắt được adapter sai", () => {
  const brokenEnv = (): CloudContractEnv => envFor("tag").env;

  it("adapter thiếu phương thức bị bắt", async () => {
    const env = brokenEnv();
    const full = createSimAdapter({
      cloud: env.control as SimCloud,
      lookupBy: "tag",
    });
    const crippled = { ...full } as unknown as Record<string, unknown>;
    delete crippled["getKubeAuthToken"];

    const check = CLOUD_CONTRACT_CHECKS.find((c) =>
      c.name.includes("ĐỦ mười phương thức"),
    );
    expect(check).toBeDefined();
    /**
     * Bọc trong một hàm async.
     *
     * `assert` của bộ hợp đồng ném ĐỒNG BỘ, nên `check.run(...)` ném ngay chứ không trả về
     * một promise bị từ chối — và `.rejects` sẽ đỏ vì lý do sai. Bọc lại biến cả hai đường
     * (ném đồng bộ và promise bị từ chối) thành một, nên phép kiểm này không phụ thuộc vào
     * việc một phép cụ thể là `async` hay không.
     */
    await expect(
      (async () =>
        (check as NonNullable<typeof check>).run(
          crippled as unknown as CloudAdapter,
          env,
        ))(),
    ).rejects.toThrow("getKubeAuthToken");
  });

  /**
   * Adapter khai `lookupBy: "tag"` cho một `kind` mà API không gắn được tag lúc tạo.
   *
   * Đây đúng là chế độ hỏng mà phép `c1` của §13.2 sinh ra để bắt, và nó chỉ bắt được nếu
   * cloud mô phỏng có ít nhất một `kind` như thế (S-4).
   */
  it("adapter khai lookupBy=tag cho kind không gắn được tag lúc tạo bị bắt", async () => {
    const env = brokenEnv();
    const honest = createSimAdapter({
      cloud: env.control as SimCloud,
      lookupBy: "tag",
    });
    /**
     * Đổi cả HÀNH VI, không chỉ trường khai.
     *
     * Chỉ đặt `lookupBy: "tag"` mà vẫn tra theo tên thì adapter vẫn chạy đúng, và phép kiểm
     * `c1` xanh — đúng như nó nên. Chế độ hỏng thật là adapter TIN vào lời khai của mình:
     * nó tra theo tag cho một `kind` mà API không gắn được tag lúc tạo, nên `lookup` không
     * bao giờ tìm thấy thứ chính nó vừa tạo.
     */
    const cloud = env.control as SimCloud;
    const lying: CloudAdapter = {
      ...honest,
      networkSteps: (params) =>
        honest.networkSteps(params).map((s) => ({
          ...s,
          lookupBy: "tag" as const,
          lookup: () => {
            const found =
              cloud.findByTag("udp.key", s.idempotencyKey)[0] ?? null;
            return Promise.resolve(
              found === null
                ? ({ kind: "absent" } as const)
                : ({ kind: "found", resource: found } as const),
            );
          },
        })),
    };

    const check = CLOUD_CONTRACT_CHECKS.find((c) =>
      c.name.includes("THẬT SỰ tìm lại được"),
    );
    expect(check).toBeDefined();
    await expect(
      (async () => (check as NonNullable<typeof check>).run(lying, env))(),
    ).rejects.toThrow();
  });

  it("adapter gắn tag bằng một lời gọi RIÊNG bị bắt", async () => {
    const env = brokenEnv();
    const cloud = env.control as SimCloud;
    const honest = createSimAdapter({ cloud, lookupBy: "tag" });
    const sloppy: CloudAdapter = {
      ...honest,
      networkSteps: (params) =>
        honest.networkSteps(params).map((s) => ({
          ...s,
          create: async (cred, prior) => {
            const r = await s.create(cred, prior);
            /** Gắn thêm tag bằng một lời gọi riêng — cửa sổ crash thứ hai */
            cloud.tagResource(r.id, { "udp.extra": "x" });
            return r;
          },
        })),
    };

    const check = CLOUD_CONTRACT_CHECKS.find((c) =>
      c.name.includes("TRONG CÙNG lời gọi tạo"),
    );
    expect(check).toBeDefined();
    await expect(
      (async () => (check as NonNullable<typeof check>).run(sloppy, env))(),
    ).rejects.toThrow("lời gọi RIÊNG");
  });

  it("adapter chỉ đọc trang đầu của phân trang bị bắt", async () => {
    const env = brokenEnv();
    const cloud = env.control as SimCloud;
    const honest = createSimAdapter({ cloud, lookupBy: "tag" });
    const lazy: CloudAdapter = {
      ...honest,
      listTaggedResources: (_cred, projectId) =>
        Promise.resolve({
          status: "SUCCESS",
          data: cloud.listTaggedPage(projectId).items,
        }),
    };

    const check = CLOUD_CONTRACT_CHECKS.find((c) =>
      c.name.includes("đi HẾT phân trang"),
    );
    expect(check).toBeDefined();
    await expect(
      (async () => (check as NonNullable<typeof check>).run(lazy, env))(),
    ).rejects.toThrow("danh sách thiếu");
  });

  it("adapter khai confidence=exact mà không có API mô phỏng bị bắt", async () => {
    const env = brokenEnv();
    const honest = createSimAdapter({
      cloud: env.control as SimCloud,
      lookupBy: "tag",
    });
    const boastful: CloudAdapter = {
      ...honest,
      preflightPermissions: async (cred) => {
        const res = await honest.preflightPermissions(cred);
        return {
          ...res,
          data: {
            ...(res.data as NonNullable<typeof res.data>),
            confidence: "exact",
          },
        };
      },
    };

    const check = CLOUD_CONTRACT_CHECKS.find((c) =>
      c.name.includes("confidence là exact hoặc heuristic"),
    );
    expect(check).toBeDefined();
    await expect(
      (async () => (check as NonNullable<typeof check>).run(boastful, env))(),
    ).rejects.toThrow("heuristic");
  });
});
