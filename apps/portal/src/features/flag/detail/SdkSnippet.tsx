import type { FlagDetailWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";
import { useMessages } from "../../../i18n";
import { detailMessages } from "./detail.messages";

export function SdkSnippet({ flag }: { flag: FlagDetailWire }) {
  const m = useMessages(detailMessages).sdk;
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
    <section aria-label={m.title}>
      <div className="sect">
        <h3>{m.title}</h3>
        <div className="r seg" role="group" aria-label={m.language}>
          <button
            type="button"
            aria-pressed={lang === "node"}
            onClick={() => setLang("node")}
          >
            {m.node}
          </button>
          <button
            type="button"
            aria-pressed={lang === "python"}
            onClick={() => setLang("python")}
          >
            {m.python}
          </button>
        </div>
      </div>
      <CodeBlock code={code} />
    </section>
  );
}
