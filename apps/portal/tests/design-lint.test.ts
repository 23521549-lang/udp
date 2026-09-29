import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Ba luật của DESIGN.md mà mắt người sẽ bỏ sót ở màn hình thứ mười, thành phép kiểm máy:
 *
 * 1. **Không em-dash trong chữ giao diện** (DESIGN.md §9). Chỉ xét chuỗi và chữ JSX —
 *    chú thích mã được phép, vì chúng không lên màn hình. Đọc bằng trình phân tích của
 *    TypeScript chứ không bằng regex: regex không phân biệt được chú thích với chuỗi.
 * 2. **Chỉ Lucide** (DESIGN.md §5): không import bộ icon khác, và `<svg>` tự vẽ chỉ ở
 *    những tệp đã khai (logo, vòng tiến độ, sparkline, biểu đồ).
 * 3. **Màu chỉ qua token**: không hex/rgb/hsl/oklch thô trong CSS của Portal hay trong mã
 *    — màu thô là cách chế độ tối lặng lẽ vỡ.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return walk(full, ext);
    return ext.test(e) ? [full] : [];
  });
}

const codeFiles = walk(SRC, /\.(ts|tsx)$/);
const tsxFiles = codeFiles.filter((f) => f.endsWith(".tsx"));

/** Mọi đoạn chữ có thể lên màn hình: string literal, template, và chữ JSX */
function visibleTexts(file: string): { text: string; line: number }[] {
  const src = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({
        text: node.text,
        line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

describe("lint thiết kế của Portal", () => {
  it("quét được mã thật — không phải 0 tệp", () => {
    expect(tsxFiles.length).toBeGreaterThan(15);
  });

  it("không em-dash (—) trong chữ giao diện", () => {
    const offenders = codeFiles.flatMap((f) =>
      visibleTexts(f)
        .filter((t) => t.text.includes("—"))
        .map((t) => `${relative(SRC, f)}:${String(t.line)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("không em-dash trong dữ liệu mẫu của bản xem thử — chữ ở đó cũng lên màn hình", () => {
    const MOCK = join(here, "..", "demo", "mock");
    const offenders = walk(MOCK, /\.ts$/).flatMap((f) =>
      visibleTexts(f)
        .filter((t) => t.text.includes("—"))
        .map((t) => `${relative(MOCK, f)}:${String(t.line)}`),
    );
    expect(offenders).toEqual([]);
  });

  it("đối chứng: bộ đọc chữ THẤY em-dash trong chuỗi và bỏ qua chú thích", () => {
    const probe = join(here, "fixtures", "emdash-probe.tsx");
    const texts = visibleTexts(probe).map((t) => t.text);
    expect(texts.some((t) => t.includes("—"))).toBe(true);
    expect(texts.some((t) => t.includes("chú thích"))).toBe(false);
  });

  it("chỉ import icon từ lucide-react", () => {
    const banned =
      /from\s+"(react-icons|@heroicons|@radix-ui\/react-icons|@tabler\/icons|react-feather|@phosphor-icons)/;
    const offenders = codeFiles
      .filter((f) => banned.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("<svg> tự vẽ chỉ ở những tệp đã khai", () => {
    const allowed = new Set([
      join("components", "Logo.tsx"),
      join("components", "ProgressRing.tsx"),
      join("components", "Sparkline.tsx"),
      join("components", "LineChart.tsx"),
      // Lớp cạnh của sơ đồ kiến trúc: nét nối giữa các nút HTML, vẽ sau layout (Plan #53 QĐ-7)
      join("features", "architecture", "EdgeLayer.tsx"),
    ]);
    const offenders = tsxFiles
      .map((f) => relative(SRC, f))
      .filter((f) => !allowed.has(f))
      .filter((f) => /<svg[\s>]/.test(readFileSync(join(SRC, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("không màu thô trong mã Portal (chỉ var(--token))", () => {
    const raw = /#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch)\(/;
    const offenders = codeFiles.flatMap((f) =>
      visibleTexts(f)
        .filter((t) => raw.test(t.text))
        .map(
          (t) =>
            `${relative(SRC, f)}:${String(t.line)}: ${t.text.slice(0, 40)}`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  /*
   * [Plan #53 QĐ-9] Ba luật từ vòng review bằng Web Interface Guidelines — những lỗi mà mắt sửa được
   * một lần nhưng tái phát ở màn thứ mười một.
   */
  it("không '...' trong chữ giao diện — dùng dấu ba chấm '…'", () => {
    const offenders = codeFiles.flatMap((f) =>
      visibleTexts(f)
        .filter((t) => t.text.includes("..."))
        .map(
          (t) =>
            `${relative(SRC, f)}:${String(t.line)}: ${t.text.slice(0, 40)}`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("Link và button không bị role danh sách ghi đè (mất vai link/nút với trình đọc màn hình)", () => {
    const banned = new Set(["listitem", "option", "row", "listbox"]);
    const offenders = tsxFiles.flatMap((file) => {
      const src = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const out: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(src);
          if (tag === "Link" || tag === "button" || tag === "a") {
            for (const attr of node.attributes.properties) {
              if (
                ts.isJsxAttribute(attr) &&
                attr.name.getText(src) === "role" &&
                attr.initializer !== undefined &&
                ts.isStringLiteral(attr.initializer) &&
                banned.has(attr.initializer.text)
              ) {
                const line =
                  src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                out.push(
                  `${relative(SRC, file)}:${String(line)} <${tag} role="${attr.initializer.text}">`,
                );
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
      return out;
    });
    expect(offenders).toEqual([]);
  });

  it("placeholder kết thúc bằng '…' (một ví dụ, không phải nhãn)", () => {
    const offenders = tsxFiles.flatMap((file) => {
      const src = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const out: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isJsxAttribute(node) &&
          node.name.getText(src) === "placeholder" &&
          node.initializer !== undefined
        ) {
          // Chỉ những giá trị placeholder có thể nhận: nhánh của `?:`, không phải chuỗi đem so sánh
          const valuesOf = (n: ts.Node): string[] =>
            ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
              ? [n.text]
              : ts.isJsxExpression(n) && n.expression !== undefined
                ? valuesOf(n.expression)
                : ts.isParenthesizedExpression(n)
                  ? valuesOf(n.expression)
                  : ts.isConditionalExpression(n)
                    ? [...valuesOf(n.whenTrue), ...valuesOf(n.whenFalse)]
                    : [];
          const texts = valuesOf(node.initializer);
          for (const text of texts) {
            if (text !== "" && !text.endsWith("…")) {
              const line =
                src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              out.push(`${relative(SRC, file)}:${String(line)}: ${text}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
      return out;
    });
    expect(offenders).toEqual([]);
  });

  it("portal.css chỉ dùng token màu, không màu thô", () => {
    const css = readFileSync(join(SRC, "styles", "portal.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(
      css.match(/#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch)\(/g) ?? [],
    ).toEqual([]);
  });

  it("prototype.css là bản chép NGUYÊN VĂN của bản mẫu đã duyệt", () => {
    const html = readFileSync(
      join(here, "..", "..", "..", "docs", "design", "portal-prototype.html"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const original = html
      .slice(html.indexOf("<style>") + 7, html.indexOf("</style>"))
      .trim();
    const copy = readFileSync(join(SRC, "styles", "prototype.css"), "utf8");
    expect(copy.replace(/^\/\*[\s\S]*?\*\/\n/, "").trim()).toBe(original);
  });
});

/*
 * [Plan #54 QĐ-2] Luật của hai ngôn ngữ: mọi chữ giao diện nằm trong `*.messages.ts(x)` với hai bản, và bản
 * tiếng Anh thật sự là tiếng Anh. Thiếu khoá hay sai tham số thì TypeScript đã bắt (`defineMessages`); các
 * luật này bắt thứ kiểu không thấy: một câu viết thẳng trong component.
 */
const VI =
  /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const isMessages = (f: string): boolean => /\.messages\.tsx?$/.test(f);

/** Chữ chỉ lập trình viên đọc, hay tên ngôn ngữ viết bằng chính ngôn ngữ đó — khai tường minh */
const VI_EXEMPT = new Set([
  // Lý do miễn trừ I38 của từng query key: đọc trong test, không lên màn hình
  "lib/query-keys.ts",
  // "Tiếng Việt" trong bộ chọn ngôn ngữ: tên ngôn ngữ không dịch
  "i18n/index.ts",
]);

/** Đường dẫn tương đối với `src/`, dấu `/` trên mọi hệ điều hành */
const relPosix = (file: string): string =>
  relative(SRC, file).replaceAll("\\", "/");

/** Chữ JSX không phải câu: tên thương hiệu */
const JSX_TEXT_ALLOWED = new Set(["udp"]);

/** Thuộc tính mà trình đọc màn hình hay người dùng đọc — phải đến từ messages */
const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "aria-roledescription",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
]);

/**
 * Hàng đợi chuyển chữ của Plan #54 đợt 54b: tệp CHƯA chuyển. Mỗi tệp ở đây phải còn vi phạm thật (một tệp đã
 * chuyển xong mà quên xoá khỏi danh sách là đỏ), nên danh sách chỉ ngắn đi. Đợt 54b kết thúc khi nó rỗng và bị
 * xoá cùng phép kiểm của nó.
 */
const PENDING = new Set<string>([
  "features/admin/pages/AdminCatalogPage.tsx",
  "features/admin/pages/AdminCredentialsPage.tsx",
  "features/admin/pages/AdminJobsPage.tsx",
  "features/admin/pages/AdminOrphansPage.tsx",
  "features/admin/pages/AdminOverviewPage.tsx",
  "features/admin/pages/AdminProjectsPage.tsx",
  "features/admin/pages/AdminSystemPage.tsx",
  "features/admin/pages/AdminUsersPage.tsx",
  "features/admin/platform-model.ts",
  "features/architecture/ArchitectureDiagram.tsx",
  "features/architecture/ArchitecturePage.tsx",
  "features/architecture/DomainHealthGrid.tsx",
  "features/architecture/architecture-model.ts",
  "features/auth/session.ts",
  "features/code/CodePage.tsx",
  "features/code/RepoReadinessCard.tsx",
  "features/deployment/DeploymentsPage.tsx",
  "features/deployment/DoraCards.tsx",
  "features/domain/CicdPanel.tsx",
  "features/domain/ConfigForm.tsx",
  "features/domain/DomainActions.tsx",
  "features/domain/DomainDetailPage.tsx",
  "features/domain/DomainPanel.tsx",
  "features/domain/DomainRow.tsx",
  "features/domain/DomainsPage.tsx",
  "features/domain/ValidationPanel.tsx",
  "features/domain/config-labels.ts",
  "features/flag/CleanupPage.tsx",
  "features/flag/CreateFlagDialog.tsx",
  "features/flag/FlagDetail.tsx",
  "features/flag/FlagsPage.tsx",
  "features/flag/PromoteDialog.tsx",
  "features/flag/RuleEditor.tsx",
  "features/flag/detail/EnvControls.tsx",
  "features/flag/detail/LifecycleActions.tsx",
  "features/flag/detail/RulesSection.tsx",
  "features/flag/detail/SdkSnippet.tsx",
  "features/flag/detail/StatsSection.tsx",
  "features/flag/detail/Tester.tsx",
  "features/flag/detail/VariantsSection.tsx",
  "features/flag/flag-labels.ts",
  "features/flag/rules-model.ts",
  "features/home/HomePage.tsx",
  "features/monitoring/MonitoringPage.tsx",
  "features/project/CommandPalette.tsx",
  "features/project/NewProjectPage.tsx",
  "features/project/OverviewPage.tsx",
  "features/project/ProjectLayout.tsx",
  "features/project/ProjectsPage.tsx",
  "features/project/SettingsPage.tsx",
  "features/project/cloud/CloudCard.tsx",
  "features/project/cloud/CloudEditor.tsx",
  "features/project/cloud/CloudPanel.tsx",
  "features/project/cloud/CloudStatus.tsx",
  "features/project/cloud/cloud-form.ts",
  "features/project/cloud/cloud-labels.ts",
  "features/project/settings/AuditTab.tsx",
  "features/project/settings/EnvironmentsTab.tsx",
  "features/project/settings/MembersTab.tsx",
  "features/project/settings/ProjectTab.tsx",
  "features/project/settings/SdkKeysTab.tsx",
  "features/provisioning/CostPanel.tsx",
  "features/provisioning/InfraPage.tsx",
  "features/provisioning/JobLog.tsx",
  "features/provisioning/PreviewPanel.tsx",
  "features/rollout/CreateRolloutDialog.tsx",
  "features/rollout/RolloutDetailPage.tsx",
  "features/rollout/RolloutsPage.tsx",
  "features/rollout/ServiceRolloutDialog.tsx",
  "features/rollout/rollout-form.tsx",
  "features/rollout/rollout-status.tsx",
  "features/rollout/use-rollout-watcher.ts",
  "features/segment/SegmentsPage.tsx",
  "lib/http.ts",
]);

interface Violation {
  file: string;
  line: number;
  what: string;
}

function i18nViolations(file: string): Violation[] {
  const rel = relPosix(file);
  if (isMessages(file)) return [];
  const src = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Violation[] = [];
  const at = (node: ts.Node, what: string): void => {
    out.push({
      file: rel,
      line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      what,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (/\p{L}{2,}/u.test(text) && !JSX_TEXT_ALLOWED.has(text)) {
        at(node, `chữ JSX "${text.slice(0, 40)}"`);
      }
    } else if (
      ts.isJsxAttribute(node) &&
      TEXT_ATTRIBUTES.has(node.name.getText(src)) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer) &&
      /\p{L}/u.test(node.initializer.text)
    ) {
      at(
        node,
        `${node.name.getText(src)}="${node.initializer.text.slice(0, 40)}"`,
      );
    } else if (
      !VI_EXEMPT.has(rel) &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      VI.test(node.text)
    ) {
      at(node, `chuỗi tiếng Việt "${node.text.slice(0, 40)}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

/** Nút chữ trong bản `en` của mọi `defineMessages({ vi, en })` của một tệp messages */
function englishTexts(file: string): { line: number; text: string }[] {
  const src = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: { line: number; text: string }[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({
        line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.text,
      });
    }
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(src) === "defineMessages" &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const p of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(p) && p.name.getText(src) === "en") {
          collect(p.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

describe("hai ngôn ngữ (Plan #54 QĐ-2)", () => {
  const byFile = new Map(
    codeFiles.map((f) => [relPosix(f), i18nViolations(f)] as const),
  );

  it("không chữ giao diện viết thẳng ngoài *.messages.ts: không chuỗi có dấu, không chữ JSX, không aria-label/title/placeholder/alt là chuỗi", () => {
    const offenders = [...byFile.values()]
      .flat()
      .filter((v) => !PENDING.has(v.file))
      .map((v) => `${v.file}:${String(v.line)} ${v.what}`);
    expect(offenders).toEqual([]);
  });

  it("hàng đợi chuyển chữ chỉ ngắn đi: tệp nào trong đó cũng còn vi phạm thật", () => {
    const done = [...PENDING].filter((f) => (byFile.get(f) ?? []).length === 0);
    expect(done).toEqual([]);
  });

  it("bản tiếng Anh không còn chữ tiếng Việt (bắt chỗ chép nguyên văn mà quên dịch)", () => {
    const offenders = codeFiles.filter(isMessages).flatMap((f) =>
      englishTexts(f)
        .filter((t) => VI.test(t.text))
        .map(
          (t) =>
            `${relative(SRC, f)}:${String(t.line)}: ${t.text.slice(0, 40)}`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("placeholder trong messages kết thúc bằng '…' ở cả hai ngôn ngữ (luật của Plan #53 đi theo chữ)", () => {
    const offenders = codeFiles.filter(isMessages).flatMap((file) => {
      const src = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const out: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isPropertyAssignment(node) &&
          /placeholder$/i.test(node.name.getText(src)) &&
          (ts.isStringLiteral(node.initializer) ||
            ts.isNoSubstitutionTemplateLiteral(node.initializer)) &&
          !node.initializer.text.endsWith("…")
        ) {
          const line =
            src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          out.push(
            `${relative(SRC, file)}:${String(line)}: ${node.initializer.text}`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(src);
      return out;
    });
    expect(offenders).toEqual([]);
  });

  it("đối chứng: luật THẤY chữ viết thẳng và bỏ qua chữ trong messages", () => {
    const probe = join(here, "fixtures", "emdash-probe.tsx");
    expect(i18nViolations(probe).length).toBeGreaterThan(0);
    const messages = codeFiles.find((f) => f.endsWith("app.messages.tsx"));
    expect(messages).toBeDefined();
    expect(i18nViolations(messages ?? "")).toEqual([]);
    expect(englishTexts(messages ?? "").length).toBeGreaterThan(20);
  });
});
