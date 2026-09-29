import { Link } from "@tanstack/react-router";
import {
  Blocks,
  FolderKanban,
  Gauge,
  KeyRound,
  ListX,
  PiggyBank,
  Server,
  Users,
} from "lucide-react";
import { type ReactNode } from "react";
import { PageHead, type Mini } from "../../components/PageHead";
import { NAV, NavBody, Shell } from "../../app/Shell";

/**
 * Bảng điều khiển nền tảng (§10.11, §10.13; Plan #53 QĐ-1) — khung riêng của nhà phát hành, chỉ
 * PLATFORM_ADMIN. Guard ở router chỉ để ẨN; chặn thật là `requirePlatformAdmin` của Service 1, đọc
 * vai từ database mỗi request. Người vừa bị hạ vẫn đang mở trang sẽ nhận 403 ở lần tải kế tiếp,
 * và trang nói đúng điều đó.
 */
export function AdminLayout() {
  return (
    <Shell
      kind="console"
      label="Điều hướng Bảng điều khiển"
      nav={
        <nav aria-label="Bảng điều khiển">
          <div className="grp">Nền tảng</div>
          <Link {...NAV} to="/admin/overview">
            <NavBody icon={Gauge}>Tổng quan</NavBody>
          </Link>
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
  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <span className="c3">Bảng điều khiển</span>
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
