import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { LanguageSwitch } from "../../app/Preferences";
import { Logo } from "../../components/Logo";
import { useMessages } from "../../i18n";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { authApi } from "./auth-api";
import { authMessages } from "./auth.messages";
import { useAuthStore } from "./auth-store";

const HOME = "/app/home";

/**
 * Chỉ chấp nhận đường dẫn NỘI BỘ của hai khung (`/app`, `/admin`) làm đích quay lại. `redirectTo`
 * đến từ URL, nên nhận nguyên văn là một open redirect: `/login?redirectTo=https://evil.example` sẽ
 * đưa người vừa đăng nhập sang trang lạ. `/admin` vẫn qua guard vai của route đó.
 */
export function safeRedirect(target: string | undefined): string {
  if (target === undefined) return HOME;
  try {
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return HOME;
    if (!/^\/(app|admin)(\/|$)/.test(url.pathname)) return HOME;
    return `${url.pathname}${url.search}`;
  } catch {
    return HOME;
  }
}

function AuthFrame({
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

function Field({
  id,
  label,
  error,
  ...input
}: {
  id: string;
  label: string;
  error?: string | undefined;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const errId = `${id}-err`;
  return (
    <div className="f">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="inp"
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errId}
        {...input}
      />
      {error !== undefined && (
        <span id={errId} className="field-error">
          {error}
        </span>
      )}
    </div>
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
        <Field
          id="email"
          label={m.email}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <Field
          id="password"
          label={m.password}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
        />
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
        {m.noAccount(<Link to="/register">{m.registerLink}</Link>)}
      </p>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const m = useMessages(authMessages);
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const register = useMutation({
    mutationFn: () => authApi.register({ name, email, password }),
    onSuccess: async ({ user }) => {
      setUser(user);
      await navigate({ to: HOME });
    },
  });
  const fields = fieldErrorsOf(register.error);

  return (
    <AuthFrame title={m.register}>
      <form
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          register.mutate();
        }}
      >
        <Field
          id="name"
          label={m.name}
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fields.name}
        />
        <Field
          id="email"
          label={m.email}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <Field
          id="password"
          label={m.password}
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
        />
        {register.isError && Object.keys(fields).length === 0 && (
          <p role="alert" className="field-error">
            {messageOf(register.error)}
          </p>
        )}
        <button type="submit" className="btn pri" disabled={register.isPending}>
          {register.isPending ? m.registering : m.register}
        </button>
      </form>
      <p className="c3">{m.haveAccount(<Link to="/login">{m.signIn}</Link>)}</p>
    </AuthFrame>
  );
}
