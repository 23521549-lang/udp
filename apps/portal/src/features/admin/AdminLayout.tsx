import { Link } from "@tanstack/react-router";
import {
  Blocks,
  FlaskConical,
  FolderKanban,
  Gauge,
  KeyRound,
  ListX,
  Network,
  PiggyBank,
  Server,
  Users,
} from "lucide-react";
import { type ReactNode } from "react";
import { PageHead, type Mini } from "../../components/PageHead";
import { appMessages } from "../../app/app.messages";
import { NAV, NavBody, Shell } from "../../app/Shell";
import { useMessages } from "../../i18n";

/**
 * Bảng điều khiển nền tảng (§10.11, §10.13; Plan #53 QĐ-1) — khung riêng của nhà phát hành, chỉ
 * PLATFORM_ADMIN. Guard ở router chỉ để ẨN; chặn thật là `requirePlatformAdmin` của Service 1, đọc
 * vai từ database mỗi request. Người vừa bị hạ vẫn đang mở trang sẽ nhận 403 ở lần tải kế tiếp,
 * và trang nói đúng điều đó.
 */
export function AdminLayout() {
  const m = useMessages(appMessages).consoleNav;
  return (
    <Shell
      kind="console"
      label={m.label}
      nav={
        <nav aria-label={m.nav}>
          <div className="grp">{m.group}</div>
          <Link {...NAV} to="/admin/overview">
            <NavBody icon={Gauge}>{m.overview}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/users">
            <NavBody icon={Users}>{m.users}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/projects">
            <NavBody icon={FolderKanban}>{m.projects}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/credentials">
            <NavBody icon={KeyRound}>{m.credentials}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/jobs">
            <NavBody icon={ListX}>{m.jobs}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/orphans">
            <NavBody icon={PiggyBank}>{m.orphans}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/system">
            <NavBody icon={Server}>{m.system}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/architecture">
            <NavBody icon={Network}>{m.architecture}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/catalog">
            <NavBody icon={Blocks}>{m.catalog}</NavBody>
          </Link>
          <Link {...NAV} to="/admin/evidence">
            <NavBody icon={FlaskConical}>{m.evidence}</NavBody>
          </Link>
        </nav>
      }
    />
  );
}

/** Khung một trang của Bảng điều khiển: thanh đầu (crumb, hành động) và đầu phân hệ */
export function AdminPage({
  title,
  lead,
  minis,
  actions,
  children,
}: {
  title: string;
  lead: string;
  /** `undefined` khi số liệu chưa tải — ô chỉ số chưa hiện */
  minis?: readonly Mini[] | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const m = useMessages(appMessages).consoleNav;
  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <span className="c3">{m.nav}</span>
          <span className="sep">/</span>
          <b>{title}</b>
        </div>
        {actions !== undefined && <div className="r">{actions}</div>}
      </div>
      <div className="scroll">
        <PageHead
          title={title}
          lead={lead}
          {...(minis === undefined ? {} : { minis })}
        />
        <div className="page">{children}</div>
      </div>
    </>
  );
}
