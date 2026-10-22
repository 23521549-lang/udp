import type { SdkKeyWire } from "@udp/shared-types/wire";
import { useState } from "react";
import { CodeBlock } from "../../../components/CodeBlock";
import { InfoTip } from "../../../components/InfoTip";
import { useMessages } from "../../../i18n";
import {
  flagHost,
  LANGS_OF,
  quickstartCode,
  SAMPLE_FLAG,
  type SdkLang,
} from "./sdk-quickstart";
import { settingsMessages } from "./settings.messages";

/**
 * [Plan #58 UX-13] Ba bước cài SDK (cài gói, khởi tạo với key và địa chỉ, hỏi một flag) — ngay trong hộp "Key đã
 * tạo" và ở tab SDK key. Biết loại key thì chỉ hiện ngôn ngữ hợp với nó (server: Node, Python; client: trình duyệt);
 * không biết (tab SDK key) thì hiện cả ba.
 */
export function SdkQuickstart({
  keyType,
  level,
}: {
  keyType?: SdkKeyWire["keyType"];
  /** Bậc tiêu đề theo chỗ đặt: tab (h2) hay trong hộp thoại (h3) */
  level: 2 | 3;
}) {
  const m = useMessages(settingsMessages).keys.quickstart;
  const langs: readonly SdkLang[] =
    keyType === undefined
      ? [...LANGS_OF.SERVER, ...LANGS_OF.CLIENT]
      : LANGS_OF[keyType];
  const [lang, setLang] = useState<SdkLang>(langs[0] ?? "node");
  const [install, init, evaluate] = quickstartCode(lang, flagHost());
  const Heading = `h${String(level)}` as "h2" | "h3";
  const steps = [
    { title: m.install, hint: m.installHint, code: install },
    {
      title: m.init,
      hint: lang === "browser" ? m.initBrowser : m.initServer,
      code: init,
    },
    { title: m.evaluate, hint: m.evaluateHint(SAMPLE_FLAG), code: evaluate },
  ];

  return (
    <section className="qs" aria-label={m.title}>
      <div className="sect">
        <Heading>{m.title}</Heading>
        <InfoTip term={lang === "browser" ? "ofrep" : "sdkKey"} />
        {langs.length > 1 && (
          <div className="r seg" role="group" aria-label={m.language}>
            {langs.map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
              >
                {m.lang[l]}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="c3">{m.lead}</p>
      <ol className="qs-steps" aria-label={m.steps}>
        {steps.map((s) => (
          <li key={s.title}>
            <b>{s.title}</b>
            <span className="c3">{s.hint}</span>
            <CodeBlock code={s.code} label={m.codeOf(m.lang[lang], s.title)} />
          </li>
        ))}
      </ol>
    </section>
  );
}
