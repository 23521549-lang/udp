import { Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { LanguageSwitch } from "../../app/Preferences";
import { JumpLink } from "../../components/JumpLink";
import { Logo } from "../../components/Logo";
import { INTL_LOCALE, useLocale, useMessages } from "../../i18n";
import { legalMessages } from "./legal.messages";

/**
 * [Plan #60 QĐ-6] Phiên bản HIỆN HÀNH của hai văn bản — BẢN SOI của `LEGAL.termsVersion` (packages/config), giá trị
 * Service 1 ghi vào `users.terms_version` khi người đăng ký tích ô đồng ý. Portal không phụ thuộc `@udp/config`; test
 * `legal.test.tsx` đọc tệp hằng số và so.
 */
export const LEGAL_VERSION = "2026-10-01";

/** Điều khoản sử dụng hay Chính sách quyền riêng tư — trang công khai, đọc được khi chưa đăng nhập */
export function LegalPage({ doc }: { doc: "terms" | "privacy" }) {
  const m = useMessages(legalMessages);
  const locale = useLocale();
  const page = m[doc];
  const date = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${LEGAL_VERSION}T00:00:00Z`));
  useEffect(() => {
    document.title = `${page.title} · UDP`;
  }, [page.title]);

  return (
    <div className="legal">
      <header className="auth-top">
        <Link to="/" className="auth-home" aria-label={m.home}>
          <Logo />
          <b>udp</b>
        </Link>
      </header>
      <main className="legal-main">
        <h1>{page.title}</h1>
        <p className="legal-lead">{page.lead}</p>
        <p className="c3">{m.updated(date, LEGAL_VERSION)}</p>
        <nav className="legal-toc" aria-label={m.toc}>
          <ol>
            {page.sections.map((s, i) => (
              <li key={s.title}>
                <JumpLink to={`legal-${String(i + 1)}`}>{s.title}</JumpLink>
              </li>
            ))}
          </ol>
        </nav>
        {page.sections.map((s, i) => (
          <section
            key={s.title}
            id={`legal-${String(i + 1)}`}
            tabIndex={-1}
            aria-labelledby={`legal-h-${String(i + 1)}`}
          >
            <h2 id={`legal-h-${String(i + 1)}`}>{s.title}</h2>
            <Body lines={s.body} />
          </section>
        ))}
        <footer className="legal-foot">
          <Link to={doc === "terms" ? "/privacy" : "/terms"}>
            {doc === "terms" ? m.otherPrivacy : m.otherTerms}
          </Link>
          <LanguageSwitch />
        </footer>
      </main>
    </div>
  );
}

/** Đoạn bắt đầu bằng "• " liền nhau gộp thành một danh sách */
function Body({ lines }: { lines: readonly string[] }) {
  const blocks: (string | string[])[] = [];
  for (const line of lines) {
    if (line.startsWith("• ")) {
      const last = blocks[blocks.length - 1];
      if (Array.isArray(last)) last.push(line.slice(2));
      else blocks.push([line.slice(2)]);
    } else blocks.push(line);
  }
  return (
    <>
      {blocks.map((b) =>
        Array.isArray(b) ? (
          <ul key={b[0]}>
            {b.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={b}>{b}</p>
        ),
      )}
    </>
  );
}
