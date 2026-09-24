import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readDesignDoc } from "../src/design-doc.js";

/**
 * [v4.10] Cổng P21 — chốt giữ I32 chiều (c) ở đúng chỗ nó dễ mất nhất: **chữ ký**.
 *
 * Ba tầng cưỡng chế "không bao giờ tự sửa drift" đã có test riêng: tầng lúc chạy và tầng
 * đếm nằm trong `day2-drift.test.ts`, tầng kiểu thì `tsc` canh. Nhưng tầng kiểu có một
 * đường lùi mà `tsc` KHÔNG canh, và nó là lý do tệp này tồn tại:
 *
 * **Phương thức trong TypeScript là song biến.** Một adapter khai
 * `detectDrift(ctx: DomainAdapterContext, ...)` vẫn thoả `DomainAdapter`, biên dịch sạch,
 * và lấy lại được `write` — tầng kiểu biến mất trong im lặng, ở đúng một adapter, và ba
 * tầng còn lại hai. Không có công cụ nào trong bộ này báo việc đó, nên chốt phải là một
 * phép kiểm đọc mã nguồn.
 *
 * Cộng một chốt thứ hai theo chiều tài liệu: `design-lint` là package DUY NHẤT thấy được
 * cả tài liệu và mã, và lời khai ở §4.6 ("cho hàm quét drift nhận
 * `ReadOnlyKubernetesClient` biến điều đó thành tính chất của KIỂU") đã từng là một lời
 * khai không có hiệu lực trong suốt v4. Nó mất hiệu lực lần nữa ngay khi một trong hai
 * bên trôi.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const CORE = resolve(ROOT, "packages/adapter-core/src");
const BACKEND = resolve(ROOT, "services/core-backend/src");

const read = (path: string): string => readFileSync(path, "utf8");

/** Tệp mã SẢN PHẨM của Service 1 — không tính test đặt cạnh adapter */
function productSources(): string[] {
  return globSync("modules/**/*.ts", { cwd: BACKEND })
    .filter((p) => !p.endsWith(".test.ts"))
    .map((p) => resolve(BACKEND, p));
}

describe("tài liệu và mã cùng khai bối cảnh chỉ đọc", () => {
  it("§4.6 khai ReadOnlyClusterAccess, và ClusterAccess mở rộng nó", () => {
    const doc = readDesignDoc().join("\n");
    expect(doc).toContain("interface ReadOnlyClusterAccess {");
    expect(doc).toContain(
      "getClient(as: ControlPlaneIdentity): Promise<ReadOnlyKubernetesClient>;",
    );
    expect(doc).toContain(
      "interface ClusterAccess extends ReadOnlyClusterAccess {",
    );

    const code = read(resolve(CORE, "cluster.ts"));
    expect(code).toContain("export interface ReadOnlyClusterAccess {");
    expect(code).toContain(
      "export interface ClusterAccess extends ReadOnlyClusterAccess {",
    );
  });

  it("§5.2 và mã cùng khai detectDrift nhận ReadOnlyAdapterContext", () => {
    const doc = readDesignDoc().join("\n");
    expect(doc).toContain("interface ReadOnlyAdapterContext");
    expect(doc).toContain("detectDrift(ctx: ReadOnlyAdapterContext");

    const code = read(resolve(CORE, "domain.ts"));
    expect(code).toContain("export interface ReadOnlyAdapterContext");
    expect(code).toContain("    ctx: ReadOnlyAdapterContext,");
  });

  /**
   * `readOnlyAccess` phải trả về một object MỚI, không phải `access` đã thu hẹp kiểu.
   *
   * Trả về chính `access` thì `write` vẫn còn đó và một `as` lấy lại được — tầng lúc chạy
   * mất hiệu lực trong khi tầng kiểu trông vẫn y nguyên. Chốt này đọc dấu hiệu rẻ nhất mà
   * không thể lách: hàm phải khai đúng `read` và không được nhắc `write` trong thân nó.
   */
  it("readOnlyAccess dựng object mới chỉ có read", () => {
    const code = read(resolve(CORE, "cluster.ts"));
    const start = code.indexOf("export function readOnlyAccess(");
    expect(start).toBeGreaterThan(0);
    const body = code.slice(start);
    const end = body.indexOf("\n}\n");
    const fn = body.slice(0, end);
    expect(fn).toContain("read<T>(verb: K8sReadVerb, ref: ObjectRef)");
    expect(fn).not.toContain("write");
  });
});

describe("không adapter nào nới lại quyền ghi cho đường quét drift", () => {
  /**
   * Không tệp sản phẩm nào khai `detectDrift` với bối cảnh đầy đủ.
   *
   * Đây là phép kiểm bắt cái mà `tsc` cho qua. Nếu một ngày một adapter thật sự cần bối
   * cảnh đầy đủ trong lúc quét thì câu trả lời không phải là nới chữ ký ở đúng adapter đó,
   * mà là sửa §8.6 trước — vì lúc ấy bất biến I32 chiều (c) không còn đúng như đã viết.
   */
  it("không nơi nào khai detectDrift(ctx: DomainAdapterContext", () => {
    const offenders = productSources().filter((file) =>
      read(file).includes("detectDrift(ctx: DomainAdapterContext"),
    );
    expect(
      offenders.map((f) => f.slice(BACKEND.length + 1)),
      "khai lại chữ ký với bối cảnh đầy đủ ⇒ tầng kiểu của I32 (c) mất hiệu lực",
    ).toEqual([]);
  });

  /**
   * MỌI chỗ gọi `detectDrift` trong mã sản phẩm đều đi qua `readOnlyContext`.
   *
   * Một route `POST /domains/:type/drift` viết vội sẽ gọi `adapter.detectDrift(ctx, cfg)`
   * với bối cảnh nó đang có — và ở đường đó thì tầng lúc chạy không đỡ được gì. Chốt này
   * là lý do route đó, khi được viết, sẽ không lặng lẽ mở lại lỗ hổng.
   */
  it("mọi lời gọi detectDrift trong mã sản phẩm đi qua readOnlyContext", () => {
    const badCalls: string[] = [];
    for (const file of productSources()) {
      const source = read(file);
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        if (!line.includes(".detectDrift(")) return;
        /** Lời gọi có thể xuống dòng, nên xét cả hai dòng kế tiếp */
        const window = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].join(" ");
        if (!window.includes("readOnlyContext(")) {
          badCalls.push(`${file.slice(BACKEND.length + 1)}:${String(i + 1)}`);
        }
      });
    }
    expect(badCalls).toEqual([]);
  });
});

describe("lưới E16 còn đủ năm ô cộng ô âm", () => {
  /**
   * Năm ô, đếm từ chính tệp test.
   *
   * E16 là một MA TRẬN đo, nên con số 5 là một phần của phép đo chứ không phải một chi
   * tiết hiện thực: bỏ một ô đi thì bảng kết quả vẫn "xanh hết" và vẫn trông đầy đủ.
   */
  it("day2-drift.test.ts có đúng năm ô sửa đổi và một ô âm", () => {
    const source = read(
      resolve(ROOT, "services/core-backend/tests/day2-drift.test.ts"),
    );
    const numbered = [...source.matchAll(/^ {2}it\("(\d)\. /gm)].map(
      (m) => m[1],
    );
    expect(numbered).toEqual(["1", "2", "3", "4", "5"]);
    expect(source).toContain('it("ô âm:');
  });
});
