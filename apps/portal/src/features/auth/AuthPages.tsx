import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useRef, useState, type FormEvent } from "react";
import { LanguageSwitch } from "../../app/Preferences";
import { Field, focusFirstInvalid } from "../../components/Field";
import { Logo } from "../../components/Logo";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { authApi } from "./auth-api";
import { authMessages } from "./auth.messages";
import { useAuthStore } from "./auth-store";

const HOME = "/app/home";

/**
 * [Plan #58 UX-24] Độ dài tối thiểu của mật khẩu — BẢN SOI của `AUTH.passwordMinLength` (packages/config/src/
 * constants.ts), luật mà Service 1 dùng ở `registerSchema` (services/core-backend/src/modules/auth/auth.types.ts).
 * Portal không phụ thuộc `@udp/config`, nên chép số ở đây; đổi một bên thì đổi bên kia.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** Kiểm trước khi gửi: lỗi hiện dưới đúng ô, nói cách sửa, bằng ngôn ngữ đang chọn */
export function registerErrors(
  input: { name: string; email: string; password: string },
  m: (typeof authMessages)["vi"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.name.trim() === "") out.name = m.nameRequired;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    out.email = m.emailInvalid;
  }
  if (input.password.length < PASSWORD_MIN_LENGTH) {
    out.password = m.passwordShort(PASSWORD_MIN_LENGTH);
  }
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

/** Khung của các trang ngoài hai không gian: đăng nhập, đăng ký, nhận lời mời */
export function AuthFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  // `main`: trang đăng nhập cũng có vùng nội dung chính cho trình đọc màn hình (không nằm trong khung nào)
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo />
          <b>udp</b>
        </div>
        <h1>{title}</h1>
        {children}
        {/* Người chưa đăng nhập cũng chọn được ngôn ngữ (Plan #54 QĐ-1) */}
        <LanguageSwitch />
      </div>
    </main>
  );
}

export function LoginPage() {
  const m = useMessages(authMessages);
  const search = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthFrame title={m.signIn}>
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
        <Field id="password" label={m.password} error={fields.password}>
          {(p) => (
            <input
              {...p}
              className="inp"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
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
      <p className="c3">
        {m.noAccount(
          <Link to="/register" search={search}>
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
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const register = useMutation({
    mutationFn: () => authApi.register({ name, email, password }),
    onSuccess: async ({ user }) => {
      setUser(user);
      // [Plan #55] Người được mời tạo tài khoản rồi quay về đúng trang nhận lời mời
      await navigate({ href: safeRedirect(search.redirectTo) });
    },
  });
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const fields = { ...fieldErrorsOf(register.error), ...clientErrors };

  return (
    <AuthFrame title={m.register}>
      <form
        ref={form}
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const errors = registerErrors({ name, email, password }, m);
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
            <input
              {...p}
              className="inp"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {register.isError && Object.keys(fields).length === 0 && (
          <p role="alert" className="field-error">
            {messageOf(register.error)}
          </p>
        )}
        <button type="submit" className="btn pri" disabled={register.isPending}>
          {register.isPending ? m.registering : m.register}
        </button>
      </form>
      <p className="c3">
        {m.haveAccount(
          <Link to="/login" search={search}>
            {m.signIn}
          </Link>,
        )}
      </p>
    </AuthFrame>
  );
}
