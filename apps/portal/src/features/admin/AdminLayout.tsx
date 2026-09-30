import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Blocks,
  FileChartColumn,
  FolderKanban,
  Gauge,
  KeyRound,
  ListX,
  Network,
  PiggyBank,
  Search,
  Users,
} from "lucide-react";
import { type ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { PageHead, type Mini } from "../../components/PageHead";
import { appMessages } from "../../app/app.messages";
import { NAV, NavBody, Shell } from "../../app/Shell";
import { useMessages } from "../../i18n";
import { formatNumber } from "../../lib/format";
import { shortcut } from "../../lib/keys";
import { qk } from "../../lib/query-keys";
import { usePaletteStore } from "../project/CommandPalette";
import { adminApi } from "./admin-api";
import { AdminKeyboard } from "./AdminPalette";

/**
 * Bảng điều khiển nền tảng (§10.11, §10.13; Plan #53 QĐ-1) — khung riêng của nhà phát hành, chỉ
 * PLATFORM_ADMIN. Guard ở router chỉ để ẨN; chặn thật là `requirePlatformAdmin` của Service 1, đọc
 * vai từ database mỗi request. Người vừa bị hạ vẫn đang mở trang sẽ nhận 403 ở lần tải kế tiếp,
 * và trang nói đúng điều đó.
 *
 * [Plan #58 UX-26] Menu ba nhóm theo việc: Vận hành (việc gấp, có huy hiệu số) › Khách hàng › Tham chiếu. "Hệ thống"
 * đã gộp vào Kiến trúc nền tảng (đường cũ chuyển hướng). Huy hiệu đọc `GET /admin/overview` — cùng mục cache với
 * Tổng quan, không hỏi thêm theo chu kỳ nào.
 */
export function AdminLayout() {
  const m = useMessages(appMessages).consoleNav;
  const overview = useQuery({
    queryKey: qk.adminOverview(),
    queryFn: adminApi.overview,
  });
  const o = overview.data?.overview;
  return (
    <>
      <Shell
        kind="console"
        label={m.label}
        nav={
          <nav aria-label={m.nav}>
            <button
              type="button"
              className="searchbtn"
              onClick={() => usePaletteStore.getState().setOpen(true)}
            >
              <Icon of={Search} size={14} />
              {m.quickSearch}
              <kbd>{shortcut("K")}</kbd>
            </button>
            <div className="grp">{m.groups.operations}</div>
            <Link {...NAV} to="/admin/overview">
              <NavBody icon={Gauge}>{m.overview}</NavBody>
            </Link>
            <Link {...NAV} to="/admin/jobs">
              <NavBody icon={ListX}>{m.jobs}</NavBody>
              <NavCount
                n={
                  o === undefined
                    ? 0
                    : o.jobs.failed + o.jobs.compensationFailed
                }
                hot={(o?.jobs.compensationFailed ?? 0) > 0}
              />
            </Link>
            <Link {...NAV} to="/admin/orphans">
              <NavBody icon={PiggyBank}>{m.orphans}</NavBody>
              <NavCount n={o?.orphans.count ?? 0} hot />
            </Link>
            <Link {...NAV} to="/admin/architecture">
              <NavBody icon={Network}>{m.architecture}</NavBody>
            </Link>
            <div className="grp">{m.groups.customers}</div>
            <Link {...NAV} to="/admin/users">
              <NavBody icon={Users}>{m.users}</NavBody>
            </Link>
            <Link {...NAV} to="/admin/projects">
              <NavBody icon={FolderKanban}>{m.projects}</NavBody>
            </Link>
            <Link {...NAV} to="/admin/credentials">
              <NavBody icon={KeyRound}>{m.credentials}</NavBody>
            </Link>
            <div className="grp">{m.groups.reference}</div>
            <Link {...NAV} to="/admin/catalog">
              <NavBody icon={Blocks}>{m.catalog}</NavBody>
            </Link>
            <Link {...NAV} to="/admin/evidence">
              <NavBody icon={FileChartColumn}>{m.evidence}</NavBody>
            </Link>
          </nav>
        }
      />
      <AdminKeyboard />
    </>
  );
}

/** Huy hiệu số của một mục menu; `hot` (đang tốn tiền của khách) thì mang sắc lỗi. 0 thì không hiện */
function NavCount({ n, hot }: { n: number; hot: boolean }) {
  if (n === 0) return null;
  // Khoảng trắng: trình đọc màn hình đọc "Job lỗi 8", không phải "Job lỗi8"
  return (
    <>
      {" "}
      <span className={hot ? "n hot" : "n"}>{formatNumber(n)}</span>
    </>
  );
}

/** Khung một trang của Bảng điều khiển: thanh đầu (crumb, hành động), đầu phân hệ và panel bên (nếu có) */
export function AdminPage({
  title,
  lead,
  minis,
  actions,
  peek,
  children,
}: {
  title: string;
  lead: ReactNode;
  /** `undefined` khi số liệu chưa tải — ô chỉ số chưa hiện */
  minis?: readonly Mini[] | undefined;
  actions?: ReactNode;
  /** [Plan #58 UX-32] Panel bên phải (`ProjectPeek`); vùng cuộn giữ nguyên khi panel mở hay đóng */
  peek?: ReactNode;
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
      <div className="body">
        <div className="scroll">
          <PageHead
            title={title}
            lead={lead}
            {...(minis === undefined ? {} : { minis })}
          />
          <div className="page">{children}</div>
        </div>
        {peek}
      </div>
    </>
  );
}
