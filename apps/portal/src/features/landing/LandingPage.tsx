import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, Minus } from "lucide-react";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { LanguageSwitch, ThemeSwitch } from "../../app/Preferences";
import { CodeBlock } from "../../components/CodeBlock";
import { Icon } from "../../components/Icon";
import { JumpLink } from "../../components/JumpLink";
import { Logo } from "../../components/Logo";
import { Tabs } from "../../components/Tabs";
import {
  INTL_LOCALE,
  LOCALE_NAME,
  useLocale,
  useLocaleStore,
  useMessages,
} from "../../i18n";
import {
  DOMAIN_GROUPS,
  domainInfoMessages,
} from "../domain/domain-info.messages";
import { domainName } from "../domain/domain-labels";
import {
  flagHost,
  quickstartCode,
  type SdkLang,
} from "../project/settings/sdk-quickstart";
import {
  DOMAIN_COUNT,
  LANDING_TOOLS,
  SAFETY_QUOTA,
  TOOL_COUNT,
} from "./landing-facts";
import { changelogMessages } from "./changelog.messages";
import { landingMessages } from "./landing.messages";
import { useShot, type ShotName } from "./shots";
import "../../styles/landing.css";

/**
 * [Plan #59] Trang giới thiệu cho người chưa đăng nhập (người đã đăng nhập vào thẳng `/app/home`, router lo).
 *
 * Bố cục "Workbench" của hallmark: ảnh chụp THẬT của Portal là nội dung chính, mỗi phần một việc kèm một hiện vật
 * thật (ảnh, mã SDK, bảng công cụ). Dùng nguyên token đã duyệt của Portal (DESIGN.md): cùng font, một màu nhấn, đường
 * kẻ mảnh, sáng và tối. Không lời chứng thực hay logo khách hàng: UDP chưa có, và bịa ra là mất lòng tin.
 */
export function LandingPage() {
  const m = useMessages(landingMessages);

  useEffect(() => {
    document.title = m.docTitle;
  }, [m.docTitle]);

  return (
    <div className="lp">
      <JumpLink to="lp-main" className="lp-skip">
        {m.skip}
      </JumpLink>
      <Nav />
      <main id="lp-main" tabIndex={-1}>
        <Hero />
        <Facts />
        <Domains />
        <Rollout />
        <Flags />
        <Byoc />
        <Tools />
        <How />
        <Changelog />
        <Free />
        <Faq />
        <Final />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  const m = useMessages(landingMessages).nav;
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const other = locale === "vi" ? "en" : "vi";
  return (
    <header className="lp-nav">
      <div className="lp-wrap lp-nav-in">
        <JumpLink to="lp-main" className="lp-brand" label={m.home}>
          <Logo />
          <b>udp</b>
        </JumpLink>
        <nav className="lp-links" aria-label={m.label}>
          <JumpLink to="features">{m.features}</JumpLink>
          <JumpLink to="byoc">{m.byoc}</JumpLink>
          <JumpLink to="tools">{m.tools}</JumpLink>
          <JumpLink to="faq">{m.faq}</JumpLink>
        </nav>
        <div className="lp-nav-end">
          <button
            type="button"
            className="lp-lang"
            lang={other}
            aria-label={m.switchLabel}
            onClick={() => setLocale(other)}
          >
            {LOCALE_NAME[other]}
          </button>
          <Link to="/login" className="lp-signin">
            {m.signIn}
          </Link>
          <Link to="/register" className="lp-btn pri lp-nav-cta">
            {m.start}
          </Link>
        </div>
      </div>
    </header>
  );
}

/** Ảnh chụp thật trong `figure` viền mảnh; chỗ của ảnh giữ sẵn theo kích thước thật (không nhảy bố cục) */
function ShotFigure({
  name,
  alt,
  className,
  eager = false,
  children,
}: {
  name: ShotName;
  alt: string;
  className?: string;
  eager?: boolean;
  children?: ReactNode;
}) {
  const shot = useShot(name);
  return (
    <figure
      className={className === undefined ? "lp-shot" : `lp-shot ${className}`}
    >
      <picture>
        {shot.darkSrc !== undefined && (
          <source media="(prefers-color-scheme: dark)" srcSet={shot.darkSrc} />
        )}
        <img
          src={shot.src}
          alt={alt}
          width={shot.width}
          height={shot.height}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
        />
      </picture>
      {children}
    </figure>
  );
}

function Hero() {
  const m = useMessages(landingMessages).hero;
  return (
    <section className="lp-hero" aria-labelledby="lp-title">
      <div className="lp-wrap">
        <div className="lp-hero-grid">
          <div className="lp-hero-title">
            <p className="lp-badge">{m.badge}</p>
            <h1 id="lp-title">{m.title}</h1>
          </div>
          <p className="lp-lead">{m.lead}</p>
          <div className="lp-hero-side">
            <div className="lp-ctas">
              <Link to="/register" className="lp-btn pri lg">
                {m.primary}
                <Icon of={ArrowRight} />
              </Link>
              <JumpLink to="how" className="lp-btn lg">
                {m.secondary}
              </JumpLink>
            </div>
            <p className="lp-note">{m.note}</p>
          </div>
        </div>
        <ShotFigure
          name="hero"
          alt={m.shotAlt}
          className="lp-hero-shot"
          eager
        />
      </div>
    </section>
  );
}

function Facts() {
  const m = useMessages(landingMessages).facts;
  const items = [
    { value: String(DOMAIN_COUNT), label: m.domains, detail: m.domainsDetail },
    { value: String(TOOL_COUNT), label: m.tools, detail: m.toolsDetail },
    { value: "3", label: m.clouds, detail: m.cloudsDetail },
    { value: m.fee, label: m.feeLabel, detail: m.feeDetail },
  ];
  return (
    <section className="lp-facts" aria-label={m.label}>
      <dl className="lp-wrap lp-facts-in">
        {items.map((f) => (
          <div key={f.label}>
            <dt>
              <span className="lp-fact-v">{f.value}</span> {f.label}
            </dt>
            <dd>{f.detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Points({ items }: { items: readonly string[] }) {
  return (
    <ul className="lp-points">
      {items.map((p) => (
        <li key={p}>
          <Icon of={Check} />
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

function Domains() {
  const m = useMessages(landingMessages).domains;
  return (
    <section
      id="features"
      tabIndex={-1}
      className="lp-sec"
      aria-labelledby="lp-domains"
    >
      <div className="lp-wrap lp-split">
        <div className="lp-copy">
          <h2 id="lp-domains">{m.title}</h2>
          <p>{m.body}</p>
          <Points items={m.points} />
        </div>
        <ShotFigure name="domains" alt={m.shotAlt} />
      </div>
    </section>
  );
}

function Rollout() {
  const m = useMessages(landingMessages).rollout;
  const shot = useShot("rollout");
  return (
    <section className="lp-sec" aria-labelledby="lp-rollout">
      <div className="lp-wrap">
        <div className="lp-head2">
          <h2 id="lp-rollout">{m.title}</h2>
          <p>{m.body}</p>
        </div>
        <ShotFigure name="rollout" alt={m.shotAlt} className="lp-annotated">
          {shot.marks.map(([x, y], i) => (
            <span
              key={i}
              className="lp-mark"
              aria-hidden="true"
              style={{ left: `${String(x)}%`, top: `${String(y)}%` }}
            >
              {i + 1}
            </span>
          ))}
        </ShotFigure>
        <ol className="lp-callouts" aria-label={m.marksLabel}>
          {m.marks.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const SDK_LANGS: readonly SdkLang[] = ["node", "python", "browser"];

/** Địa chỉ mẫu trong đoạn mã khi trang được dựng sẵn ở máy chủ (chưa có `window`); trình duyệt thay ngay khi chạy */
const SAMPLE_HOST = "https://udp.example.com";
const noSubscribe = () => () => undefined;

function Flags() {
  const m = useMessages(landingMessages).flags;
  const [lang, setLang] = useState<SdkLang>("node");
  const host = useSyncExternalStore(noSubscribe, flagHost, () => SAMPLE_HOST);
  const [install, init, evaluate] = quickstartCode(lang, host);
  const name = m.langs[lang];
  return (
    <section className="lp-sec" aria-labelledby="lp-flags">
      <div className="lp-wrap lp-split">
        <div className="lp-copy">
          <h2 id="lp-flags">{m.title}</h2>
          <p>{m.body}</p>
          <Points items={m.points} />
        </div>
        <div className="lp-code">
          <Tabs
            label={m.langLabel}
            value={lang}
            options={SDK_LANGS.map((l) => ({ value: l, label: m.langs[l] }))}
            onChange={setLang}
            controls="lp-code-panel"
          />
          <div id="lp-code-panel" role="tabpanel" aria-label={name}>
            <CodeBlock code={install} label={m.install(name)} />
            <CodeBlock code={`${init}\n\n${evaluate}`} label={m.code(name)} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Byoc() {
  const m = useMessages(landingMessages).byoc;
  return (
    <section
      id="byoc"
      tabIndex={-1}
      className="lp-sec"
      aria-labelledby="lp-byoc"
    >
      <div className="lp-wrap lp-split rev">
        <div className="lp-copy">
          <h2 id="lp-byoc">{m.title}</h2>
          <p>{m.body}</p>
          <div className="lp-ledger">
            <div>
              <h3>{m.yours}</h3>
              <ul>
                {m.yoursItems.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>{m.udp}</h3>
              <ul>
                {m.udpItems.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="lp-small">{m.quota(SAFETY_QUOTA)}</p>
          <p className="lp-small">{m.tags}</p>
        </div>
        <ShotFigure name="cloud" alt={m.shotAlt} />
      </div>
    </section>
  );
}

function Tools() {
  const m = useMessages(landingMessages).tools;
  const groups = useMessages(domainInfoMessages).group;
  return (
    <section
      id="tools"
      tabIndex={-1}
      className="lp-sec"
      aria-labelledby="lp-tools"
    >
      <div className="lp-wrap">
        <div className="lp-head2">
          <h2 id="lp-tools">{m.title(DOMAIN_COUNT, TOOL_COUNT)}</h2>
          <p>{m.body}</p>
        </div>
        <div className="lp-groups">
          {(Object.keys(DOMAIN_GROUPS) as (keyof typeof DOMAIN_GROUPS)[]).map(
            (g) => (
              <div key={g} className="lp-group">
                <h3>{groups[g]}</h3>
                <dl>
                  {DOMAIN_GROUPS[g].map((d) => (
                    <div key={d}>
                      <dt>{domainName(d)}</dt>
                      <dd translate="no">
                        {LANDING_TOOLS[d].map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ),
          )}
        </div>
      </div>
    </section>
  );
}

function How() {
  const m = useMessages(landingMessages).how;
  return (
    <section id="how" tabIndex={-1} className="lp-sec" aria-labelledby="lp-how">
      <div className="lp-wrap">
        <h2 id="lp-how">{m.title}</h2>
        <ol className="lp-steps">
          {m.steps.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** [Plan #60 QĐ-10] Bốn thay đổi gần nhất, có ngày — việc đã có trong mã, không hứa hẹn */
const CHANGELOG_SHOWN = 4;

function Changelog() {
  const m = useMessages(changelogMessages);
  const locale = useLocale();
  const day = new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  return (
    <section className="lp-sec" aria-labelledby="lp-changelog">
      <div className="lp-wrap">
        <div className="lp-head2">
          <h2 id="lp-changelog">{m.title}</h2>
          <p>{m.lead}</p>
        </div>
        <ol className="lp-log">
          {m.entries.slice(0, CHANGELOG_SHOWN).map((e) => (
            <li key={e.title}>
              <time dateTime={e.date}>
                {day.format(new Date(`${e.date}T00:00:00Z`))}
              </time>
              <div>
                <h3>{e.title}</h3>
                <p>{e.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Free() {
  const m = useMessages(landingMessages).free;
  return (
    <section className="lp-sec" aria-labelledby="lp-free">
      <div className="lp-wrap lp-free">
        <div className="lp-copy">
          <h2 id="lp-free">{m.title}</h2>
          <p>{m.body}</p>
          <Link to="/register" className="lp-btn pri lg">
            {m.cta}
            <Icon of={ArrowRight} />
          </Link>
        </div>
        <div className="lp-plan">
          <h3>{m.included}</h3>
          <Points items={m.includedItems(DOMAIN_COUNT, TOOL_COUNT)} />
        </div>
        <div className="lp-notfit">
          <h3>{m.notFit}</h3>
          <ul className="lp-points">
            {m.notFitItems.map((t) => (
              <li key={t}>
                <Icon of={Minus} />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const m = useMessages(landingMessages).faq;
  return (
    <section id="faq" tabIndex={-1} className="lp-sec" aria-labelledby="lp-faq">
      <div className="lp-wrap lp-faq">
        <h2 id="lp-faq">{m.title}</h2>
        <div className="lp-qa">
          {m.items(SAFETY_QUOTA).map((item) => (
            <details key={item.q}>
              <summary>{item.q}</summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Final() {
  const m = useMessages(landingMessages).final;
  return (
    <section className="lp-final" aria-labelledby="lp-final">
      <div className="lp-wrap">
        <h2 id="lp-final">{m.title}</h2>
        <p>{m.body}</p>
        <div className="lp-ctas">
          <Link to="/register" className="lp-btn pri lg">
            {m.primary}
            <Icon of={ArrowRight} />
          </Link>
          <Link to="/login" className="lp-textlink">
            {m.signIn}
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const m = useMessages(landingMessages);
  return (
    <footer className="lp-foot" aria-label={m.footer.label}>
      <div className="lp-wrap lp-foot-in">
        <div className="lp-foot-mast">
          <span className="lp-brand">
            <Logo />
            <b>udp</b>
          </span>
          <p>{m.footer.tagline}</p>
          <p className="lp-small">
            {m.footer.copyright(new Date().getFullYear())}
          </p>
        </div>
        <nav className="lp-foot-links" aria-label={m.footer.links}>
          <JumpLink to="features">{m.nav.features}</JumpLink>
          <JumpLink to="tools">{m.nav.tools}</JumpLink>
          <JumpLink to="faq">{m.nav.faq}</JumpLink>
          <Link to="/login">{m.nav.signIn}</Link>
          <Link to="/terms">{m.footer.terms}</Link>
          <Link to="/privacy">{m.footer.privacy}</Link>
        </nav>
        <div className="lp-foot-prefs">
          <LanguageSwitch />
          <ThemeSwitch />
        </div>
      </div>
    </footer>
  );
}
