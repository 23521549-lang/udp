import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import {
  ChevronsUpDown,
  CircleHelp,
  LayoutGrid,
  LogOut,
  Menu,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { authApi } from "../features/auth/auth-api";
import { useAuthStore } from "../features/auth/auth-store";
import { HelpDrawer, useHelpStore } from "../features/help/HelpDrawer";
import { useMessages } from "../i18n";
import { appMessages } from "./app.messages";
import { usePageTitle } from "./page-title";
import { LanguageSwitch, ShortcutSwitch, ThemeSwitch } from "./Preferences";
import { shellUxMessages } from "./shell-ux.messages";

/**
 * Khung chung của hai không gian (DESIGN.md §4 "Hai khung", Plan #53 QĐ-1):
 *
 * - **portal** — Portal của developer (`/app`), thanh bên sáng;
 * - **console** — Bảng điều khiển nền tảng của nhà phát hành (`/admin`), thanh bên `--console-*`.
 *
 * Phần chung nằm Ở ĐÂY, một lần: link bỏ qua tới nội dung, nút menu điện thoại (Esc, nền mờ, trả
 * focus), khu tài khoản (đổi khung, giao diện, đăng xuất). Trước đây `/admin` tự dựng khung riêng
 * và thiếu đúng những thứ đó — trên điện thoại không điều hướng được, không có nút đăng xuất.
 */
export function Shell({
  kind,
  label,
  nav,
}: {
  kind: "portal" | "console";
  label: string;
  nav: ReactNode;
}) {
  const m = useMessages(appMessages);
  const ux = useMessages(shellUxMessages);
  const [open, setOpen] = useState(false);
  const side = useRef<HTMLElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const announce = usePageTitle();
  const mainRef = useRef<HTMLElement>(null);

  // [Plan #58 UX-38] Ngăn kéo mở trên điện thoại: nội dung phía sau không nhận focus hay bấm (kiểu React 18 chưa có
  // thuộc tính `inert`, nên đặt thẳng lên phần tử)
  useEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    main.toggleAttribute("inert", open);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    side.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuBtn.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className={`shell ${kind}`}>
      <button
        type="button"
        className="skip"
        onClick={() => document.getElementById("main")?.focus()}
      >
        {m.skipToContent}
      </button>
      <aside
        id="side"
        ref={side}
        className={open ? "side open" : "side"}
        aria-label={label}
        onClick={(e) => {
          // Chọn một mục (link) thì đóng ngăn kéo trên điện thoại; bấm nút trong khu tài khoản thì không
          if ((e.target as HTMLElement).closest("a") !== null) setOpen(false);
        }}
      >
        {kind === "console" ? (
          <Link to="/admin/overview" className="ws">
            <Logo />
            <b>udp</b>
            <span className="ws-tag">{m.consoleNav.tag}</span>
          </Link>
        ) : (
          <Link to="/app/home" className="ws">
            <Logo />
            <b>udp</b>
          </Link>
        )}
        {/* [Plan #58 UX-38] Ngăn kéo điện thoại có nút đóng của riêng nó: phần nền bị khoá (inert) khi ngăn kéo mở */}
        <button
          type="button"
          className="ib side-close"
          aria-label={ux.closeMenu}
          onClick={() => {
            setOpen(false);
            menuBtn.current?.focus();
          }}
        >
          <Icon of={X} />
        </button>
        {nav}
        {/* [Plan #58 UX-21] Trợ giúp ở cùng một chỗ trên mọi trang của cả hai khung */}
        <button
          type="button"
          className="nv helpbtn"
          onClick={() => useHelpStore.getState().setOpen(true)}
        >
          <NavBody icon={CircleHelp}>{ux.help.open}</NavBody>
        </button>
        <AccountMenu kind={kind} />
      </aside>
      {open && (
        <div
          className="scrim on side-scrim"
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      )}
      <main id="main" ref={mainRef} className="main" tabIndex={-1}>
        <button
          ref={menuBtn}
          type="button"
          className="ib menubtn"
          aria-label={m.openMenu}
          aria-expanded={open}
          aria-controls="side"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon of={Menu} />
        </button>
        <Outlet />
      </main>
      <HelpDrawer />
      <div className="visually-hidden" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

/** Mục menu của thanh bên — Link khai trực tiếp ở chỗ dùng để giữ kiểu chặt của route */
export const NAV = {
  className: "nv",
  activeProps: { "aria-current": "page" as const },
} as const;

export function NavBody({
  icon,
  children,
}: {
  icon: typeof Menu;
  children: ReactNode;
}) {
  return (
    <>
      <span className="ni">
        <Icon of={icon} size={14} />
      </span>
      {children}
    </>
  );
}

function initialsOf(name: string | undefined): string {
  return (name ?? "?")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Khu tài khoản ở đáy thanh bên. Lối sang Bảng điều khiển nằm Ở ĐÂY (chỉ PLATFORM_ADMIN thấy),
 * không phải một mục giữa menu project: developer không bao giờ lẫn hai sản phẩm.
 */
function AccountMenu({ kind }: { kind: "portal" | "console" }) {
  const user = useAuthStore((s) => s.user);
  const clearUser = useAuthStore((s) => s.clearUser);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const m = useMessages(appMessages);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const isAdmin = user?.platformRole === "PLATFORM_ADMIN";

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>(".acct a, .acct button")?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    const onDown = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const logout = async (): Promise<void> => {
    try {
      await authApi.logout();
    } finally {
      clearUser();
      queryClient.clear();
      await navigate({ to: "/login", search: {} });
    }
  };

  return (
    <div className="me" ref={box}>
      <button
        ref={btn}
        type="button"
        className="me-btn"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="av">{initialsOf(user?.name)}</span>
        <span className="me-name">{user?.name ?? user?.email}</span>
        <Icon of={ChevronsUpDown} size={14} />
      </button>
      {open && (
        <div id={menuId} className="acct" role="group" aria-label={m.account}>
          <div className="acct-id">
            <b>{user?.name}</b>
            <span className="c3">{user?.email}</span>
          </div>
          {isAdmin &&
            (kind === "portal" ? (
              <Link to="/admin/overview" className="acct-it">
                <Icon of={ShieldCheck} />
                {m.platformConsole}
              </Link>
            ) : (
              <Link to="/app/home" className="acct-it">
                <Icon of={LayoutGrid} />
                {m.backToPortal}
              </Link>
            ))}
          <ThemeSwitch />
          <LanguageSwitch />
          {kind === "portal" && <ShortcutSwitch />}
          <button
            type="button"
            className="acct-it"
            onClick={() => void logout()}
          >
            <Icon of={LogOut} />
            {m.signOut}
          </button>
        </div>
      )}
    </div>
  );
}
