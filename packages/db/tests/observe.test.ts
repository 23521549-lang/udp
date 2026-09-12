import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, observeQueries } from "../src/index.js";
import { connectionString } from "./helpers/db.js";

/**
 * `observeQueries` là dụng cụ đếm round trip của I19 [v4.2] và I21. Nếu nó đếm
 * sai thì hai bất biến đó xanh hay đỏ đều vô nghĩa, nên nó có test riêng — trên
 * client thật, vì thứ cần kiểm là sự kiện Prisma thật sự phát.
 */

const client = createPrismaClient({
  connectionString: connectionString(),
  max: 1,
  cacheKey: `__udp_prisma_observe_${randomUUID()}`,
});

afterAll(async () => {
  await client.$disconnect();
});

describe("observeQueries", () => {
  it("nghe được từng truy vấn, kể cả $queryRaw, kèm thời lượng", async () => {
    const seen: string[] = [];
    const stop = observeQueries(client, (q) => {
      seen.push(q.query);
      expect(q.durationMs).toBeGreaterThanOrEqual(0);
      expect(q.timestamp).toBeInstanceOf(Date);
    });
    try {
      await client.$queryRaw`SELECT 1 AS one`;
    } finally {
      stop();
    }
    expect(seen).toEqual(["SELECT 1 AS one"]);
  });

  it("hai người nghe trên cùng client; gỡ một thì người kia vẫn nhận", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const stopA = observeQueries(client, (q) => a.push(q.query));
    const stopB = observeQueries(client, (q) => b.push(q.query));
    await client.$queryRaw`SELECT 2 AS two`;
    stopA();
    await client.$queryRaw`SELECT 3 AS three`;
    stopB();
    await client.$queryRaw`SELECT 4 AS four`;

    expect(a).toEqual(["SELECT 2 AS two"]);
    expect(b).toEqual(["SELECT 2 AS two", "SELECT 3 AS three"]);
  });

  it("đăng ký cùng một listener hai lần vẫn chỉ nhận một lần", async () => {
    const seen: string[] = [];
    const listener = (q: { query: string }): void => {
      seen.push(q.query);
    };
    const stop1 = observeQueries(client, listener);
    const stop2 = observeQueries(client, listener);
    await client.$queryRaw`SELECT 5 AS five`;
    stop1();
    stop2();
    expect(seen).toEqual(["SELECT 5 AS five"]);
  });
});
