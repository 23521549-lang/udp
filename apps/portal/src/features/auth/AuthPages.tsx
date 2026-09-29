import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Logo } from "../../components/Logo";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { authApi } from "./auth-api";
import { useAuthStore } from "./auth-store";

/**
 * Chỉ chấp nhận đường dẫn NỘI BỘ làm đích quay lại. `redirectTo` đến từ URL, nên nhận
 * nguyên văn là một open redirect: `/login?redirectTo=https://evil.example` sẽ đưa người
 * vừa đăng nhập sang trang lạ.
 */
export function safeRedirect(target: string | undefined): string {
  if (target === undefined) return "/app/projects";
  try {
    const url = new URL(target, window.location.origin);
    if (url.origin !== window.location.origin) return "/app/projects";
    if (!url.pathname.startsWith("/app")) return "/app/projects";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/app/projects";
  }
}

function AuthFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Logo />
          <b>udp</b>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
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
    <AuthFrame title="Đăng nhập">
      <form className="auth-form" onSubmit={submit} noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <Field
          id="password"
          label="Mật khẩu"
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
          {login.isPending ? "Đang đăng nhập…" : "Đăng nhập"}
        </button>
      </form>
      <p className="c3">
        Chưa có tài khoản? <Link to="/register">Đăng ký</Link>
      </p>
    </AuthFrame>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const setUser = useAuthStore((s) => s.setUser);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const register = useMutation({
    mutationFn: () => authApi.register({ name, email, password }),
    onSuccess: async ({ user }) => {
      setUser(user);
      await navigate({ to: "/app/projects" });
    },
  });
  const fields = fieldErrorsOf(register.error);

  return (
    <AuthFrame title="Tạo tài khoản">
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
          label="Tên"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fields.name}
        />
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fields.email}
        />
        <Field
          id="password"
          label="Mật khẩu"
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
          {register.isPending ? "Đang tạo…" : "Tạo tài khoản"}
        </button>
      </form>
      <p className="c3">
        Đã có tài khoản? <Link to="/login">Đăng nhập</Link>
      </p>
    </AuthFrame>
  );
}
