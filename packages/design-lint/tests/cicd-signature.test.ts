import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * [v4.11] Plan #36 AC-2 — chữ ký webhook CI/CD so theo thời gian HẰNG (trả nợ `cicd-adapter`).
 *
 * `===` trên chuỗi chữ ký dừng ở byte khác đầu tiên, nên thời gian trả lời rò độ dài tiền tố
 * khớp: kẻ dò đoán chữ ký từng byte một. `timingSafeEqual` thì NÉM khi hai độ dài lệch, nên
 * hiện thực phải kiểm độ dài trước và trả `false`. Không phép kiểm lúc chạy nào đo được thời
 * gian đủ tin trên máy đo này — phép kiểm là CẤU TRÚC, đọc mã bằng AST:
 *
 * 1. `constantTimeEquals` (adapter-base/cicd.ts) kiểm độ dài rồi gọi `timingSafeEqual`;
 * 2. hai bộ kiểm header (`verifyHmacHeader`, `verifyTokenHeader`) đi qua `constantTimeEquals`
 *    và không so bằng nhau thứ gì ngoài `undefined`;
 * 3. `verifySignature` của MỌI adapter CI/CD là một lời gọi tới đúng một trong hai bộ kiểm đó,
 *    không một phép so bằng nhau nào.
 *
 * Đối chứng ở cuối: một hiện thực so bằng `===` phải bị chính bộ đọc này bắt.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const MODULES = resolve(ROOT, "services/core-backend/src/modules");
const BASE = resolve(MODULES, "adapter-base/cicd.ts");

const HEADER_CHECKS = ["verifyHmacHeader", "verifyTokenHeader"] as const;
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const parse = (path: string, text = readFileSync(path, "utf8")) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

function functionNamed(
  file: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  walk(file, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
  });
  if (found === undefined) throw new Error(`không thấy hàm ${name}`);
  return found;
}

const calls = (node: ts.Node): string[] => {
  const out: string[] = [];
  walk(node, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      out.push(n.expression.text);
    }
  });
  return out;
};

/** Các phép so bằng nhau, trừ phép so với `undefined` (header vắng) */
const equalities = (node: ts.Node): string[] => {
  const out: string[] = [];
  walk(node, (n) => {
    if (
      ts.isBinaryExpression(n) &&
      EQUALITY.has(n.operatorToken.kind) &&
      ![n.left, n.right].some(
        (side) => ts.isIdentifier(side) && side.text === "undefined",
      )
    ) {
      out.push(n.getText());
    }
  });
  return out;
};

/** Thân `verifySignature` trong đối số của `createCicdAdapter(...)` */
function verifySignatureOf(file: ts.SourceFile): ts.Node {
  let found: ts.Node | undefined;
  walk(file, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "createCicdAdapter"
    ) {
      const spec = n.arguments[0];
      if (spec !== undefined && ts.isObjectLiteralExpression(spec)) {
        for (const p of spec.properties) {
          if (
            ts.isPropertyAssignment(p) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "verifySignature"
          ) {
            found = p.initializer;
          }
        }
      }
    }
  });
  if (found === undefined) {
    throw new Error(
      `${file.fileName}: không gọi createCicdAdapter({ verifySignature })`,
    );
  }
  return found;
}

/** Luật 3 cho MỘT adapter — trả danh sách vi phạm */
function signatureProblems(file: ts.SourceFile): string[] {
  const body = verifySignatureOf(file);
  const used = calls(body).filter((c) =>
    (HEADER_CHECKS as readonly string[]).includes(c),
  );
  return [
    ...(used.length === 1
      ? []
      : [`gọi ${String(used.length)} bộ kiểm header, phải đúng 1`]),
    ...equalities(body).map((e) => `so bằng nhau: ${e}`),
  ];
}

const adapters = (): string[] =>
  globSync("cicd-adapter/*/index.ts", { cwd: MODULES }).map((p) =>
    resolve(MODULES, p),
  );

describe("AC-2: chữ ký CI/CD so theo thời gian hằng", () => {
  it("constantTimeEquals kiểm độ dài rồi mới gọi timingSafeEqual", () => {
    const fn = functionNamed(parse(BASE), "constantTimeEquals");
    expect(calls(fn)).toContain("timingSafeEqual");
    const guards: string[] = [];
    walk(fn, (n) => {
      if (
        ts.isIfStatement(n) &&
        ts.isBinaryExpression(n.expression) &&
        n.expression.getText().includes(".length")
      ) {
        guards.push(n.expression.getText());
      }
    });
    expect(guards).toHaveLength(1);
  });

  for (const name of HEADER_CHECKS) {
    it(`${name} đi qua constantTimeEquals, không so bằng nhau trên chữ ký`, () => {
      const fn = functionNamed(parse(BASE), name);
      expect(calls(fn)).toContain("constantTimeEquals");
      expect(equalities(fn)).toEqual([]);
    });
  }

  it("đủ sáu adapter CI/CD của §5.5", () => {
    expect(
      adapters()
        .map((p) => p.split(/[\\/]/).at(-2))
        .sort(),
    ).toEqual([
      "circleci",
      "drone",
      "github-actions",
      "gitlab-ci",
      "jenkins",
      "tekton",
    ]);
  });

  for (const path of adapters()) {
    it(`${path.split(/[\\/]/).at(-2) ?? path}: verifySignature là đúng một bộ kiểm header`, () => {
      expect(signatureProblems(parse(path))).toEqual([]);
    });
  }
});

describe("đối chứng: bộ đọc bắt được hiện thực sai", () => {
  const source = (verify: string) =>
    parse(
      "gia.ts",
      `const adapter = createCicdAdapter({ base, verifySignature: ${verify}, renderPipelineTemplate });`,
    );

  it("so chữ ký bằng === ⇒ vi phạm", () => {
    expect(
      signatureProblems(
        source(
          `(h, raw, secret) => headerOf(h, "X-Sig") === hmacSha256(secret, raw).toString("hex")`,
        ),
      ),
    ).toEqual([
      "gọi 0 bộ kiểm header, phải đúng 1",
      `so bằng nhau: headerOf(h, "X-Sig") === hmacSha256(secret, raw).toString("hex")`,
    ]);
  });

  it("bộ kiểm header cộng một phép so tắt ⇒ vi phạm", () => {
    expect(
      signatureProblems(
        source(
          `(h, raw, secret) => h["x-sig"] === "dev" || verifyHmacHeader(h, raw, secret, "X-Sig", "sha256=")`,
        ),
      ),
    ).toEqual([`so bằng nhau: h["x-sig"] === "dev"`]);
  });

  it("hiện thực đúng ⇒ không vi phạm", () => {
    expect(
      signatureProblems(
        source(
          `(h, raw, secret) => verifyTokenHeader(h, secret, "X-Gitlab-Token")`,
        ),
      ),
    ).toEqual([]);
  });
});
