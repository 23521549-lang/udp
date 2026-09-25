import type { FlagDetailWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";

export function SdkSnippet({ flag }: { flag: FlagDetailWire }) {
  const [lang, setLang] = useState<"node" | "python">("node");
  const method: Record<FlagDetailWire["flagType"], [string, string, string]> = {
    BOOLEAN: ["getBooleanValue", "get_boolean_value", "false"],
    STRING: ["getStringValue", "get_string_value", '""'],
    NUMBER: ["getNumberValue", "get_float_value", "0"],
    JSON: ["getObjectValue", "get_object_value", "{}"],
  };
  const [js, py, fallback] = method[flag.flagType];
  const code =
    lang === "node"
      ? `const value = await client.${js}("${flag.key}", ${fallback}, {\n  targetingKey: user.id,\n});`
      : `value = client.${py}("${flag.key}", ${fallback === "false" ? "False" : fallback}, EvaluationContext(user.id))`;

  return (
    <section aria-label="Dùng trong mã">
      <div className="sect">
        <h3>Dùng trong mã</h3>
        <div className="r seg" role="group" aria-label="Ngôn ngữ">
          <button
            type="button"
            aria-pressed={lang === "node"}
            onClick={() => setLang("node")}
          >
            Node.js
          </button>
          <button
            type="button"
            aria-pressed={lang === "python"}
            onClick={() => setLang("python")}
          >
            Python
          </button>
        </div>
      </div>
      <CodeBlock code={code} />
    </section>
  );
}
