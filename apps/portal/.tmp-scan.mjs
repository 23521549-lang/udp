import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const walk = (d) => readdirSync(d).flatMap((e) => { const f = join(d, e); return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(e) ? [f] : []; });
const target = process.argv[2];
const files = statSync(target).isDirectory() ? walk(target) : [target];
for (const f of files) {
  if (/\.messages\.tsx?$/.test(f)) continue;
  const src = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const v = (node) => {
    let t;
    if (ts.isJsxText(node) && /\p{L}{2,}/u.test(node.text)) t = "JSX";
    else if (ts.isJsxAttribute(node) && ["aria-label","title","placeholder","alt","aria-roledescription","aria-valuetext"].includes(node.name.getText()) && node.initializer && ts.isStringLiteral(node.initializer)) t = "ATTR";
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(node.text)) t = "VI";
    if (t) console.log(`${f}:${src.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${t} ${JSON.stringify(node.getText().trim().slice(0, 90))}`);
    ts.forEachChild(node, v);
  };
  v(src);
}
