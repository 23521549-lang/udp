import { Link, Outlet } from "@tanstack/react-router";
import {
  Blocks,
  FolderKanban,
  KeyRound,
  ListX,
  PiggyBank,
  Server,
  Users,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { Logo } from "../../components/Logo";
import { useAuthStore } from "../auth/auth-store";

/**
 * Khu quản trị (§10.11, §10.13) — chỉ PLATFORM_ADMIN. Guard ở router chỉ để ẨN; chặn thật
 * là `requirePlatformAdmin` của Service 1, đọc vai từ database mỗi request. Người vừa bị
 * hạ vẫn đang mở trang sẽ nhận 403 ở lần tải kế tiếp, và trang nói đúng điều đó.
 */

const NAV = {
  className: "nv",
  activeProps: { "aria-current": "page" as const },
} as const;

function NavBody({
  icon,
  children,
}: {
  icon: LucideIcon;
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

export function AdminLayout() {
  const user = useAuthStore((s) => s.user);
  return (
    <div className="shell">
      <aside className="side" aria-label="Điều hướng quản trị">
        <Link to="/app/projects" className="ws">
          <Logo />
          <b>udp</b>
        </Link>
        <nav aria-label="Quản trị">
          <div className="grp">Quản trị hệ thống</div>
          <Link {...NAV} to="/admin/users">
            <NavBody icon={Users}>Người dùng</NavBody>
          </Link>
          <Link {...NAV} to="/admin/projects">
            <NavBody icon={FolderKanban}>Project</NavBody>
          </Link>
          <Link {...NAV} to="/admin/credentials">
            <NavBody icon={KeyRound}>Credential</NavBody>
          </Link>
          <Link {...NAV} to="/admin/jobs">
            <NavBody icon={ListX}>Job lỗi</NavBody>
          </Link>
          <Link {...NAV} to="/admin/orphans">
            <NavBody icon={PiggyBank}>Tài nguyên mồ côi</NavBody>
          </Link>
          <Link {...NAV} to="/admin/system">
            <NavBody icon={Server}>Hệ thống</NavBody>
          </Link>
          <Link {...NAV} to="/admin/catalog">
            <NavBody icon={Blocks}>Catalog domain</NavBody>
          </Link>
          <div className="grp">Của bạn</div>
          <Link to="/app/projects" className="nv">
            <NavBody icon={FolderKanban}>Về project</NavBody>
          </Link>
        </nav>
        <div className="me">
          <span className="me-name">{user?.email}</span>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export function AdminPage({
  title,
  lead,
  icon,
  actions,
  children,
}: {
  title: string;
  lead: string;
  icon: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <span className="c3">Quản trị</span>
          <span className="sep">/</span>
          <b>{title}</b>
        </div>
        {actions !== undefined && <div className="r">{actions}</div>}
      </div>
      <div className="scroll">
        <div className="mhead">
          <span className="tile xl">
            <Icon of={icon} size={21} />
          </span>
          <div>
            <h1>{title}</h1>
            <p>{lead}</p>
          </div>
        </div>
        <div className="page">{children}</div>
      </div>
    </>
  );
}
