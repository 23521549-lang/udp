import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { Check, Github } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { LanguageSwitch } from "../../app/Preferences";
import { Field, focusFirstInvalid } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { Logo } from "../../components/Logo";
import { PasswordInput } from "../../components/PasswordInput";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { DOMAIN_COUNT, TOOL_COUNT } from "../landing/landing-facts";
import { useShot } from "../landing/shots";
import { authApi, githubStartUrl } from "./auth-api";
import type { OAuthCode } from "./auth-search";
import { authMessages } from "./auth.messages";
import { useAuthStore } from "./auth-store";

const HOME = "/app/home";

/**
 * [Plan #58 UX-24] Độ dài tối thiểu của mật khẩu — BẢN SOI của `AUTH.passwordMinLength` (packages/config/src/
 * constants.ts), luật mà Service 1 dùng ở `registerSchema` (services/core-backend/src/modules/auth/auth.types.ts).
 * Portal không phụ thuộc `@udp/config`, nên chép số ở đây; đổi một bên thì đổi bên kia.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** Email đủ hình (kiểm ở Portal để báo sớm; máy chủ kiểm lại) */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Kiểm trước khi gửi: lỗi hiện dưới đúng ô, nói cách sửa, bằng ngôn ngữ đang chọn */
export function registerErrors(
  input: { name: string; email: string; password: string; agree: boolean },
  m: (typeof authMessages)["vi"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.name.trim() === "") out.name = m.nameRequired;
  if (!EMAIL.test(input.email.trim())) {
    out.email = m.emailInvalid;
  }
  if (input.password.length < PASSWORD_MIN_LENGTH) {
    out.password = m.passwordShort(PASSWORD_MIN_LENGTH);
  }
  // [Plan #60 QĐ-6] Nghị định 13/2023: đồng ý phải là một hành động, không mặc định
  if (!input.agree) out.acceptTerms = m.consentRequired;
  return out;
}

/**
 * Chỉ chấp nhận đường dẫn NỘI BỘ của hai khung (`/app`, `/admin`) và trang nhận lời mời (`/invite`, Plan #55)
 * làm đích quay lại. `redirectTo` đến từ URL, nên nhận nguyên văn là một open redirect:
 * `/login?redirectTo=https://evil.example` sẽ đưa người vừa đăng nhập sang trang lạ. `/admin` vẫn qua guard vai
 * của route đó.
 */
export function safeRedirect(target: string | undefined): string {
  if (target === undefined) return HOME;
  try {
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return HOME;
    if (!/^\/(app|admin|invite)(\/|$)/.test(url.pathname)) return HOME;
    return `${url.pathname}${url.search}`;
  } catch {
    return HOME;
  }
}

/**
 * Khung của các trang ngoài hai không gian: đăng nhập, đăng ký, nhận lời mời. [Plan #59] Logo ở góc trên dẫn về
 * trang giới thiệu (luôn có đường về); `aside` là panel bên của trang đăng ký, chỉ chứa sự thật về sản phẩm, không
 * nằm trong form.
 */
export function AuthFrame({
  title,
  lead,
  aside,
  children,
}: {
  title: string;
  lead?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const m = useMessages(authMessages);
  useEffect(() => {
    document.title = `${title} · UDP`;
  }, [title]);
  return (
    <div className="auth">
      <header className="auth-top">
        <Link to="/" className="auth-home" aria-label={m.home}>
          <Logo />
          <b>udp</b>
        </Link>
      </header>
      {/* `main`: trang đăng nhập cũng có vùng nội dung chính cho trình đọc màn hình (không nằm trong khung nào) */}
      <main className={aside === undefined ? "auth-main" : "auth-main split"}>
        <div className="auth-card">
          <div className="auth-head">
            <h1>{title}</h1>
            {lead !== undefined && <p className="c2">{lead}</p>}
          </div>
          {children}
          {/* Người chưa đăng nhập cũng chọn được ngôn ngữ (Plan #54 QĐ-1) */}
          <LanguageSwitch />
        </div>
        {aside}
      </main>
    </div>
  );
}

/** [Plan #59] Panel bên của trang đăng ký: ba điều có ngay, và một mẩu ảnh thật của sản phẩm */
function RegisterAside() {
  const m = useMessages(authMessages).aside;
  const shot = useShot("hero");
  return (
    <aside className="auth-aside" aria-labelledby="auth-aside-title">
      <h2 id="auth-aside-title">{m.title}</h2>
      <ul>
        {m.items(DOMAIN_COUNT, TOOL_COUNT).map((item) => (
          <li key={item}>
            <Icon of={Check} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
      <figure className="auth-shot">
        <picture>
          {shot.darkSrc !== undefined && (
            <source
              media="(prefers-color-scheme: dark)"
              srcSet={shot.darkSrc}
            />
          )}
          <img
            src={shot.src}
            alt={m.shotAlt}
            width={shot.width}
            height={shot.height}
            decoding="async"
          />
        </picture>
      </figure>
    </aside>
  );
}

/** [Plan #60] Cách đăng nhập mà triển khai này bật — ít đổi, một lần mỗi phiên xem */
function useAuthOptions() {
  return useQuery({
    queryKey: qk.authOptions(),
    queryFn: authApi.options,
    staleTime: 5 * 60_000,
  });
}

/** [Plan #60 QĐ-8] Nút GitHub: một ĐIỀU HƯỚNG cả trang tới máy chủ (đặt cookie `state` rồi chuyển sang GitHub) */
function GithubButton({
  href,
  onClick,
}: {
  href: string;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const m = useMessages(authMessages);
  return (
    <>
      <div className="auth-or" aria-hidden="true">
        <span>{m.or}</span>
      </div>
      <a className="btn auth-gh" href={href} onClick={onClick}>
        <Icon of={Github} />
        {m.github}
      </a>
    </>
  );
}

/** [Plan #60 QĐ-8] Lỗi của lần quay về từ GitHub: máy chủ trả MÃ trên query, Portal viết câu theo ngôn ngữ */
function OAuthNotice({ code }: { code: OAuthCode | undefined }) {
  const m = useMessages(authMessages);
  if (code === undefined) return null;
  return (
    <p role="alert" className="alert auth-alert">
      {m.oauth[code]}
    </p>
  );
}

export function LoginPage() {
  const m = useMessages(authMessages);
  const search = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const options = useAuthOptions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => authApi.login({ email, password }),
    onSuccess: async ({ user }) => {
      setUser(user);
      await navigate({ href: safeRedirect(search.redirectTo) });
    },
  });
  const fields = fieldErrorsOf(login.error);
  const back =
    search.redirectTo === undefined ? {} : { redirectTo: search.redirectTo };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthFrame title={m.signIn}>
      <OAuthNotice code={search.oauth} />
      {search.reset === "done" && (
        <p role="status" className="alert ok auth-alert">
          {m.resetDone}
        </p>
      )}
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field id="email" label={m.email} error={fields.email}>
          {(p) => (
            <input
              {...p}
              className="inp"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          id="password"
          label={m.password}
          error={fields.password}
          labelAside={
            options.data?.passwordReset === true && (
              <Link to="/forgot-password" className="auth-forgot">
                {m.forgotLink}
              </Link>
            )
          }
        >
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="current-password"
              value={password}
              onChange={setPassword}
            />
          )}
        </Field>
        {login.isError && Object.keys(fields).length === 0 && (
          <p role="alert" className="field-error">
            {messageOf(login.error)}
          </p>
        )}
        <button type="submit" className="btn pri" disabled={login.isPending}>
          {login.isPending ? m.signingIn : m.signIn}
        </button>
      </form>
      {options.data?.github === true && (
        <GithubButton
          href={githubStartUrl({
            intent: "login",
            redirectTo: search.redirectTo,
          })}
        />
      )}
      <p className="c3">
        {m.noAccount(
          <Link to="/register" search={back}>
            {m.registerLink}
          </Link>,
        )}
      </p>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const m = useMessages(authMessages);
  const search = useSearch({ from: "/register" });
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const options = useAuthOptions();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agree, setAgree] = useState(false);

  const register = useMutation({
    mutationFn: () =>
      authApi.register({ name, email, password, acceptTerms: true }),
    onSuccess: async ({ user }) => {
      setUser(user);
      // [Plan #55] Người được mời tạo tài khoản rồi quay về đúng trang nhận lời mời
      await navigate({ href: safeRedirect(search.redirectTo) });
    },
  });
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const fields = { ...fieldErrorsOf(register.error), ...clientErrors };
  const back =
    search.redirectTo === undefined ? {} : { redirectTo: search.redirectTo };

  /** [Plan #60 QĐ-6] Chưa tích ô đồng ý: báo NGAY dưới ô, đưa focus tới ô — không gửi gì đi */
  const needConsent = (): boolean => {
    if (agree) return false;
    setClientErrors((e) => ({ ...e, acceptTerms: m.consentRequired }));
    requestAnimationFrame(() =>
      document.getElementById("acceptTerms")?.focus(),
    );
    return true;
  };

  return (
    <AuthFrame
      title={m.register}
      lead={m.registerLead}
      aside={<RegisterAside />}
    >
      <OAuthNotice code={search.oauth} />
      <form
        ref={form}
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const errors = registerErrors({ name, email, password, agree }, m);
          setClientErrors(errors);
          if (Object.keys(errors).length > 0) {
            requestAnimationFrame(() => focusFirstInvalid(form.current));
            return;
          }
          register.mutate();
        }}
      >
        <Field id="name" label={m.name} error={fields.name}>
          {(p) => (
            <input
              {...p}
              className="inp"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field id="email" label={m.email} error={fields.email}>
          {(p) => (
            <input
              {...p}
              className="inp"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        {/* [Plan #58 UX-24] Luật mật khẩu nói TRƯỚC khi gõ, không đợi lỗi */}
        <Field
          id="password"
          label={m.password}
          hint={m.passwordHint(PASSWORD_MIN_LENGTH)}
          error={fields.password}
        >
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              value={password}
              onChange={setPassword}
            />
          )}
        </Field>
        {/* [Plan #60 QĐ-6] Đồng ý phải là một hành động: ô KHÔNG tích sẵn; hai văn bản mở ở thẻ mới, form giữ nguyên */}
        <div className="f auth-consent">
          <label className="auth-check">
            <input
              id="acceptTerms"
              type="checkbox"
              checked={agree}
              aria-invalid={fields.acceptTerms !== undefined}
              aria-describedby={
                fields.acceptTerms === undefined ? undefined : "acceptTerms-err"
              }
              onChange={(e) => {
                setAgree(e.target.checked);
                if (e.target.checked) {
                  setClientErrors(({ acceptTerms: _drop, ...rest }) => rest);
                }
              }}
            />
            <span>
              {m.consent(
                <Link to="/terms" target="_blank" rel="noopener">
                  {m.termsLink}
                </Link>,
                <Link to="/privacy" target="_blank" rel="noopener">
                  {m.privacyLink}
                </Link>,
              )}
            </span>
          </label>
          {fields.acceptTerms !== undefined && (
            <span id="acceptTerms-err" className="field-error">
              {fields.acceptTerms}
            </span>
          )}
        </div>
        {register.isError && Object.keys(fields).length === 0 && (
          <p role="alert" className="field-error">
            {messageOf(register.error)}
          </p>
        )}
        <button type="submit" className="btn pri" disabled={register.isPending}>
          {register.isPending ? m.registering : m.register}
        </button>
      </form>
      {options.data?.github === true && (
        <GithubButton
          href={githubStartUrl({
            intent: "register",
            acceptTerms: true,
            redirectTo: search.redirectTo,
          })}
          onClick={(e) => {
            if (needConsent()) e.preventDefault();
          }}
        />
      )}
      <p className="c3">
        {m.haveAccount(
          <Link to="/login" search={back}>
            {m.signIn}
          </Link>,
        )}
      </p>
    </AuthFrame>
  );
}

/** [Plan #60 QĐ-7] Xin thư đặt lại mật khẩu — kết quả luôn như nhau, có tài khoản hay không */
export function ForgotPasswordPage() {
  const m = useMessages(authMessages);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const forgot = useMutation({
    mutationFn: () => authApi.forgot(email.trim()),
  });

  if (forgot.isSuccess) {
    return (
      <AuthFrame title={m.forgot.sentTitle}>
        <p role="status" className="c2">
          {m.forgot.sent(<b translate="no">{email.trim()}</b>)}
        </p>
        <Link to="/login">{m.forgot.back}</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={m.forgot.title} lead={m.forgot.lead}>
      <form
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const invalid = !EMAIL.test(email.trim());
          setError(invalid ? m.emailInvalid : undefined);
          if (invalid) {
            requestAnimationFrame(() =>
              document.getElementById("email")?.focus(),
            );
            return;
          }
          forgot.mutate();
        }}
      >
        <Field
          id="email"
          label={m.email}
          error={error ?? fieldErrorsOf(forgot.error).email}
        >
          {(p) => (
            <input
              {...p}
              className="inp"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        {forgot.isError && (
          <p role="alert" className="field-error">
            {messageOf(forgot.error)}
          </p>
        )}
        <button type="submit" className="btn pri" disabled={forgot.isPending}>
          {forgot.isPending ? m.forgot.sending : m.forgot.submit}
        </button>
      </form>
      <Link to="/login">{m.forgot.back}</Link>
    </AuthFrame>
  );
}

/**
 * [Plan #60 QĐ-7] `/reset-password#<token>` — mã ở FRAGMENT (không bao giờ tới máy chủ khi tải trang), đọc một lần vào
 * bộ nhớ rồi xoá khỏi thanh địa chỉ: không nằm trong lịch sử trình duyệt. Đổi xong thì về đăng nhập.
 */
export function ResetPasswordPage() {
  const m = useMessages(authMessages);
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => location.hash);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (location.hash !== "") {
      void navigate({ to: "/reset-password", replace: true });
    }
  }, [location.hash, navigate]);

  const reset = useMutation({
    mutationFn: () => authApi.reset(token, password),
    onSuccess: () =>
      navigate({ to: "/login", search: { reset: "done" }, replace: true }),
  });

  if (token === "") {
    return (
      <AuthFrame title={m.reset.title}>
        <p role="alert">{m.reset.missingToken}</p>
        <Link to="/forgot-password">{m.reset.requestNew}</Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title={m.reset.title}>
      <form
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const short = password.length < PASSWORD_MIN_LENGTH;
          setError(short ? m.passwordShort(PASSWORD_MIN_LENGTH) : undefined);
          if (short) {
            requestAnimationFrame(() =>
              document.getElementById("password")?.focus(),
            );
            return;
          }
          reset.mutate();
        }}
      >
        <Field
          id="password"
          label={m.reset.password}
          hint={m.passwordHint(PASSWORD_MIN_LENGTH)}
          error={error ?? fieldErrorsOf(reset.error).password}
        >
          {(p) => (
            <PasswordInput
              {...p}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              value={password}
              onChange={setPassword}
            />
          )}
        </Field>
        {reset.isError && fieldErrorsOf(reset.error).password === undefined && (
          <div role="alert">
            <p className="field-error">{messageOf(reset.error)}</p>
            <Link to="/forgot-password">{m.reset.requestNew}</Link>
          </div>
        )}
        <button type="submit" className="btn pri" disabled={reset.isPending}>
          {reset.isPending ? m.reset.saving : m.reset.submit}
        </button>
      </form>
    </AuthFrame>
  );
}
