import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import type { AdminUserWire } from "@udp/shared-types/wire";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  FolderKanban,
  KeyRound,
  ListX,
  PiggyBank,
  Server,
  Shield,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { Logo } from "../../components/Logo";
import { Empty, ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/errors";
import { formatDateTime, formatNumber } from "../../lib/format";
import { qk, qkPrefix } from "../../lib/query-keys";
import { useAuthStore } from "../auth/auth-store";
import { PROJECT_STATUS } from "../project/ProjectsPage";
import { adminApi } from "./admin-api";

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

function AdminPage({
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

// ------------------------------------------------------------- người dùng

export function AdminUsersPage() {
  const me = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<AdminUserWire | null>(null);
  const users = useQuery({
    queryKey: qk.adminUsers(search.trim()),
    queryFn: () =>
      adminApi.users(search.trim() === "" ? undefined : search.trim()),
  });
  const setRole = useMutation({
    mutationFn: (u: AdminUserWire) =>
      adminApi.setRole(
        u.id,
        u.platformRole === "PLATFORM_ADMIN" ? "USER" : "PLATFORM_ADMIN",
      ),
    onSuccess: async () => {
      setPending(null);
      toast.info("Đã đổi vai");
      await queryClient.invalidateQueries({ queryKey: qkPrefix.adminUsersAll() });
    },
  });

  return (
    <AdminPage
      title="Người dùng"
      lead="Vai toàn hệ thống. Quyền trong từng project do chủ project quản lý."
      icon={Users}
    >
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <input
          className="inp"
          aria-label="Tìm người dùng"
          placeholder="Tìm theo email hoặc tên"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {users.isPending ? (
        <Loading />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.users.length === 0 ? (
        <Empty title="Không có ai khớp" />
      ) : (
        <div className="table-wrap">
          <table className="matrix" aria-label="Người dùng">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Tên</th>
                <th scope="col">Vai</th>
                <th scope="col">Tạo lúc</th>
                <th scope="col">
                  <span className="visually-hidden">Hành động</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id}>
                  <th scope="row">{u.email}</th>
                  <td>{u.name}</td>
                  <td>
                    {u.platformRole === "PLATFORM_ADMIN"
                      ? "Quản trị"
                      : "Người dùng"}
                  </td>
                  <td>{formatDateTime(u.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setPending(u)}
                    >
                      {u.platformRole === "PLATFORM_ADMIN"
                        ? "Hạ quyền"
                        : "Nâng quản trị"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pending !== null && (
        <ConfirmDialog
          title={
            pending.platformRole === "PLATFORM_ADMIN"
              ? `Hạ quyền ${pending.email}?`
              : `Cho ${pending.email} quyền quản trị?`
          }
          description={
            pending.id === me?.id
              ? "Đây là chính bạn: sau khi hạ, bạn không vào lại được khu quản trị."
              : "Có hiệu lực ngay ở request kế tiếp của người đó."
          }
          confirmLabel="Đổi vai"
          danger={pending.platformRole === "PLATFORM_ADMIN"}
          typeToConfirm={pending.email}
          busy={setRole.isPending}
          error={setRole.isError ? messageOf(setRole.error) : undefined}
          onConfirm={() => setRole.mutate(pending)}
          onClose={() => {
            setPending(null);
            setRole.reset();
          }}
        />
      )}
    </AdminPage>
  );
}

// ------------------------------------------------------------- project

const STATUSES = [
  "",
  "DRAFT",
  "PROVISIONING",
  "ACTIVE",
  "ERROR",
  "DELETED",
] as const;

export function AdminProjectsPage() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("");
  const projects = useQuery({
    queryKey: qk.adminProjects(status),
    queryFn: () => adminApi.projects(status === "" ? undefined : status),
  });
  return (
    <AdminPage
      title="Project"
      lead="Mọi project trên nền tảng, kể cả đã xoá mềm."
      icon={FolderKanban}
    >
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <select
          className="sel"
          aria-label="Lọc theo trạng thái"
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as (typeof STATUSES)[number])
          }
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "" ? "Mọi trạng thái" : PROJECT_STATUS[s].label}
            </option>
          ))}
        </select>
      </div>
      {projects.isPending ? (
        <Loading />
      ) : projects.isError ? (
        <ErrorState
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      ) : projects.data.projects.length === 0 ? (
        <Empty title="Không có project nào" />
      ) : (
        <div className="table-wrap">
          <table className="matrix" aria-label="Project">
            <thead>
              <tr>
                <th scope="col">Tên</th>
                <th scope="col">Chủ</th>
                <th scope="col">Trạng thái</th>
                <th scope="col">Cloud</th>
                <th scope="col">Thành viên</th>
                <th scope="col">Tạo lúc</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td>{p.owner.email}</td>
                  <td>{PROJECT_STATUS[p.status].label}</td>
                  <td>{p.cloudProvider ?? "–"}</td>
                  <td className="num">{p.memberCount}</td>
                  <td>{formatDateTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}

// ------------------------------------------------------------- credential

export function AdminCredentialsPage() {
  const creds = useQuery({
    queryKey: qk.adminCredentials(),
    queryFn: adminApi.credentials,
  });
  return (
    <AdminPage
      title="Credential"
      lead="Chỉ siêu dữ liệu và một đoạn dấu vân tay. Nội dung credential không bao giờ được giải mã để hiển thị."
      icon={KeyRound}
    >
      {creds.isPending ? (
        <Loading />
      ) : creds.isError ? (
        <ErrorState error={creds.error} onRetry={() => void creds.refetch()} />
      ) : creds.data.credentials.length === 0 ? (
        <Empty title="Chưa có credential nào" />
      ) : (
        <div className="table-wrap">
          <table className="matrix" aria-label="Credential">
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Cloud</th>
                <th scope="col">Chế độ</th>
                <th scope="col">Dấu vân tay</th>
                <th scope="col">Đang dùng</th>
                <th scope="col">Kiểm lần cuối</th>
              </tr>
            </thead>
            <tbody>
              {creds.data.credentials.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.project.name}</th>
                  <td>{c.provider}</td>
                  <td>{c.mode}</td>
                  <td className="mono">{c.fingerprint}…</td>
                  <td>{c.isActive ? "Có" : "–"}</td>
                  <td>
                    {c.lastValidatedAt === null
                      ? "chưa"
                      : formatDateTime(c.lastValidatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}

// ------------------------------------------------------------- job

export function AdminJobsPage() {
  const [state, setState] = useState("FAILED");
  const jobs = useQuery({
    queryKey: qk.adminJobs(state),
    queryFn: () => adminApi.jobs(state),
  });
  return (
    <AdminPage
      title="Job provisioning"
      lead="Job hỏng hoặc kẹt trên toàn hệ thống."
      icon={ListX}
    >
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <div className="seg" role="group" aria-label="Trạng thái job">
          {["FAILED", "COMPENSATION_FAILED", "CANCEL_REQUESTED"].map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => setState(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {jobs.isPending ? (
        <Loading />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.jobs.length === 0 ? (
        <Empty title="Không có job nào ở trạng thái này" />
      ) : (
        <div className="lst">
          {jobs.data.jobs.map((j) => (
            <div key={j.id} className="it" style={{ flexWrap: "wrap" }}>
              <b style={{ fontWeight: 500 }}>{j.project.name}</b>
              <span className="mono c3">{j.jobType}</span>
              <span className="c3">lần {j.attempt}</span>
              <span className="c3" style={{ marginLeft: "auto" }}>
                {formatDateTime(j.updatedAt)}
              </span>
              {j.lastError !== null && (
                <pre className="mono diff" style={{ margin: 0 }}>
                  {JSON.stringify(j.lastError, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </AdminPage>
  );
}

// ------------------------------------------------------------- orphan

/**
 * Màn hình DUY NHẤT nhìn thấy tiền đang bị đốt (§10.13). `null` USD/giờ nghĩa là không
 * định giá được — hiện "chưa rõ giá", tuyệt đối không hiện 0.
 */
export function AdminOrphansPage() {
  const orphans = useQuery({
    queryKey: qk.adminOrphans(),
    queryFn: adminApi.orphans,
  });
  const d = orphans.data;
  return (
    <AdminPage
      title="Tài nguyên mồ côi"
      lead="Tài nguyên cloud không dọn được sau teardown, kèm chi phí đang chạy."
      icon={PiggyBank}
    >
      {orphans.isPending ? (
        <Loading />
      ) : orphans.isError ? (
        <ErrorState
          error={orphans.error}
          onRetry={() => void orphans.refetch()}
        />
      ) : d === undefined ? null : (
        <>
          <div className="stat">
            <div>
              <div className="l">Đang đốt</div>
              <div className="v num">
                ${formatNumber(d.estimatedUsdPerHour)}
                <small>/giờ</small>
              </div>
            </div>
            <div>
              <div className="l">Mỗi ngày</div>
              <div className="v num">
                $
                {formatNumber(
                  Math.round(d.estimatedUsdPerHour * 24 * 100) / 100,
                )}
              </div>
            </div>
            <div>
              <div className="l">Tài nguyên</div>
              <div className="v num">{d.resources.length}</div>
            </div>
            <div>
              <div className="l">Chưa rõ giá</div>
              <div className="v num">{d.unpriced.length}</div>
            </div>
          </div>
          {!d.cloudScanned && (
            <div className="alert amber" role="status">
              <Icon of={CircleAlert} />
              <div>
                Danh sách theo SỔ tài nguyên. Chưa quét cloud theo tag, nên tài
                nguyên có tag của UDP mà không có trong sổ chưa hiện ở đây. Bảng
                giá ngày {d.pricingAsOf}.
              </div>
            </div>
          )}
          {d.resources.length === 0 ? (
            <Empty title="Không có tài nguyên mồ côi nào trong sổ" />
          ) : (
            <div className="table-wrap">
              <table className="matrix" aria-label="Tài nguyên mồ côi">
                <thead>
                  <tr>
                    <th scope="col">Project</th>
                    <th scope="col">Loại</th>
                    <th scope="col">Vùng</th>
                    <th scope="col">Id trên cloud</th>
                    <th scope="col">USD/giờ</th>
                  </tr>
                </thead>
                <tbody>
                  {d.resources.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{r.projectName}</th>
                      <td className="mono">{r.kind}</td>
                      <td>
                        {r.provider} {r.region}
                      </td>
                      <td className="mono">{r.providerId ?? "chưa biết"}</td>
                      <td className="num">
                        {r.usdPerHour === null
                          ? "chưa rõ giá"
                          : `$${String(r.usdPerHour)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </AdminPage>
  );
}

// ------------------------------------------------------------- hệ thống

const STATUS_VIEW: Record<
  "up" | "down" | "unknown",
  { label: string; icon: LucideIcon; tone: string }
> = {
  up: { label: "Ổn định", icon: CircleCheck, tone: "var(--green)" },
  down: { label: "Không phản hồi", icon: CircleAlert, tone: "var(--red)" },
  unknown: { label: "Không rõ", icon: CircleHelp, tone: "var(--ink-3)" },
};

export function AdminSystemPage() {
  const system = useQuery({
    queryKey: qk.adminSystem(),
    queryFn: adminApi.system,
    refetchInterval: 30_000,
  });
  return (
    <AdminPage
      title="Hệ thống"
      lead="Sức khoẻ ba service và database, tự cập nhật mỗi 30 giây."
      icon={Shield}
    >
      {system.isPending ? (
        <Loading />
      ) : system.isError ? (
        <ErrorState
          error={system.error}
          onRetry={() => void system.refetch()}
        />
      ) : (
        <div className="lst" aria-label="Sức khoẻ">
          {[
            ...system.data.services,
            { name: "database", status: system.data.database },
          ].map((s) => {
            const v = STATUS_VIEW[s.status];
            return (
              <div key={s.name} className="it">
                <span className="mono">{s.name}</span>
                <span className="stt" style={{ marginLeft: "auto" }}>
                  <Icon of={v.icon} style={{ color: v.tone }} />
                  {v.label}
                </span>
              </div>
            );
          })}
          <div className="it c3">
            Kiểm lúc {formatDateTime(system.data.checkedAt)}
          </div>
        </div>
      )}
    </AdminPage>
  );
}
