import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOUD_ADAPTER_METHODS,
  DOMAIN_ADAPTER_METHODS,
  DOMAIN_ADAPTER_PROPERTIES,
} from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { readDesignDoc } from "../src/design-doc.js";

/**
 * [v4.10] Cổng P18 — ĐÓNG BĂNG bề mặt interface adapter (cổng thứ tự 4).
 *
 * Trước khi hai adapter thật của P19/P20 được viết, bề mặt mà chúng hiện thực phải được
 * chốt: mọi thay đổi interface SAU đó là một thay đổi phá vỡ, và nó phải là một quyết
 * định chứ không phải một lần thêm phương thức cho tiện.
 *
 * "Chốt" ở đây có nghĩa kiểm được: **tài liệu và mã khai cùng một bề mặt**, đếm tới từng
 * tên. Ba con số, và mỗi con số có một lý do riêng để được đếm:
 *
 * | Bề mặt | Số | Vì sao đếm |
 * | --- | --- | --- |
 * | `CloudAdapter` | **10 + 1** | 10 phương thức của §4.2 cộng thuộc tính `providerId`. Một bản nháp của plan từng ghi "sáu phương thức", và chính phép kiểm này sẽ đỏ vì con số đó |
 * | `DomainAdapter` | **7 + 6** | 7 phương thức của §5.2 cộng 6 thuộc tính read-only. Một bản nháp từng ghi "tám phương thức" |
 * | `CicdDomainAdapter` | **+3** | `verifySignature`, `parsePayload`, `renderPipelineTemplate` — mở rộng cho họ CI/CD |
 *
 * `design-lint` là package DUY NHẤT thấy được cả tài liệu và mã, nên chốt nằm ở đây.
 *
 * **Git tag `adapter-interface-v1` chỉ được tạo sau khi tệp này xanh.** Tag đó là mốc để
 * một lần đổi interface về sau nhìn thấy được trong lịch sử, chứ không chỉ trong diff.
 */

const CORE = resolve(import.meta.dirname, "../../adapter-core/src");

/** Tên phương thức khai trong một `interface X { ... }` của tài liệu */
function docInterface(name: string): { methods: string[]; props: string[] } {
  const lines = readDesignDoc();
  /**
   * Khớp có BIÊN TỪ, không phải `includes`.
   *
   * `interface DomainAdapterContext` xuất hiện TRƯỚC `interface DomainAdapter` trong cả
   * tài liệu lẫn mã, nên một lần khớp tiền tố sẽ đọc thân của Context và trả về danh sách
   * rỗng — phép kiểm đỏ với "expected [] to have a length of 7", một thông điệp không nói
   * gì về nguyên nhân. Đã gặp đúng lỗi đó khi viết tệp này.
   */
  const heads = [`interface ${name} {`, `interface ${name} extends`];
  const start = lines.findIndex((l) => heads.some((h) => l.includes(h)));
  if (start < 0) throw new Error(`tài liệu không khai interface ${name}`);

  const methods: string[] = [];
  const props: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "}") break;
    const m = /^ {2}(\w+)\(/.exec(line);
    if (m?.[1] !== undefined) methods.push(m[1]);
    const p = /^ {2}readonly (\w+)/.exec(line);
    if (p?.[1] !== undefined) props.push(p[1]);
  }
  return { methods, props };
}

/** Tên phương thức khai trong một `export interface X { ... }` của mã nguồn */
function codeInterface(
  file: string,
  name: string,
): { methods: string[]; props: string[] } {
  const source = readFileSync(resolve(CORE, file), "utf8");
  /** Cùng lý do biên từ như `docInterface` */
  const heads = [
    `export interface ${name} {`,
    `export interface ${name} extends`,
  ];
  const start = heads
    .map((h) => source.indexOf(h))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (start === undefined) throw new Error(`${file} không khai ${name}`);
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);

  const methods = [...body.matchAll(/^ {2}(\w+)\(/gm)].map(
    (m) => m[1] as string,
  );
  const props = [...body.matchAll(/^ {2}readonly (\w+)/gm)].map(
    (m) => m[1] as string,
  );
  return { methods, props };
}

describe("CloudAdapter — 10 + 1", () => {
  it("tài liệu khai đúng 10 phương thức và 1 thuộc tính", () => {
    const doc = docInterface("CloudAdapter");
    expect(doc.methods).toHaveLength(10);
    expect(doc.props).toEqual(["providerId"]);
  });

  it("mã khai đúng bề mặt của tài liệu, từng tên", () => {
    const doc = docInterface("CloudAdapter");
    const code = codeInterface("cloud.ts", "CloudAdapter");
    expect([...code.methods].sort()).toEqual([...doc.methods].sort());
    expect([...code.props].sort()).toEqual([...doc.props].sort());
  });

  /**
   * Và hằng số chạy được cũng khớp.
   *
   * `CLOUD_ADAPTER_METHODS` là bản khai THỨ BA (sau tài liệu và interface), và nó là bản
   * mà type guard lúc chạy dùng. Ba bản phải cùng nói một điều; hai bản khớp nhau mà bản
   * thứ ba lệch nghĩa là guard cho qua một adapter thiếu phương thức.
   */
  it("hằng số CLOUD_ADAPTER_METHODS khớp interface", () => {
    const code = codeInterface("cloud.ts", "CloudAdapter");
    expect([...CLOUD_ADAPTER_METHODS].sort()).toEqual([...code.methods].sort());
  });
});

describe("DomainAdapter — 7 + 6", () => {
  it("tài liệu khai đúng 7 phương thức và 6 thuộc tính", () => {
    const doc = docInterface("DomainAdapter");
    expect(doc.methods).toHaveLength(7);
    expect(doc.props).toHaveLength(6);
  });

  it("mã khai đúng bề mặt của tài liệu, từng tên", () => {
    const doc = docInterface("DomainAdapter");
    const code = codeInterface("domain.ts", "DomainAdapter");
    expect([...code.methods].sort()).toEqual([...doc.methods].sort());
    expect([...code.props].sort()).toEqual([...doc.props].sort());
  });

  it("hai hằng số chạy được khớp interface", () => {
    const code = codeInterface("domain.ts", "DomainAdapter");
    expect([...DOMAIN_ADAPTER_METHODS].sort()).toEqual(
      [...code.methods].sort(),
    );
    expect([...DOMAIN_ADAPTER_PROPERTIES].sort()).toEqual(
      [...code.props].sort(),
    );
  });
});

describe("CicdDomainAdapter — mở rộng đúng ba phương thức", () => {
  it("tài liệu và mã khai cùng ba phương thức mở rộng", () => {
    const doc = docInterface("CicdDomainAdapter");
    const code = codeInterface("domain.ts", "CicdDomainAdapter");
    expect([...doc.methods].sort()).toEqual([
      "parsePayload",
      "renderPipelineTemplate",
      "verifySignature",
    ]);
    expect([...code.methods].sort()).toEqual([...doc.methods].sort());
  });

  /**
   * Mở rộng KHÔNG được khai lại phương thức của `DomainAdapter`.
   *
   * Khai lại là một cách âm thầm đổi chữ ký: `CicdDomainAdapter` khai lại `deploy` với
   * một tham số thêm thì họ CI/CD không còn đi qua cùng một điểm vào, và bộ hợp đồng
   * Domain không chạm tới nhánh đó nữa.
   */
  it("không khai lại phương thức nào của DomainAdapter", () => {
    const code = codeInterface("domain.ts", "CicdDomainAdapter");
    const overlap = code.methods.filter((m) =>
      DOMAIN_ADAPTER_METHODS.includes(m),
    );
    expect(overlap).toEqual([]);
  });
});
