import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type {
  AuditEntryWire,
  ProjectRoleWire,
  ResourceQuotaWire,
  SdkKeyWire,
} from "@udp/shared-types/wire";
import { Check, Copy, KeyRound, Settings2 } from "lucide-react";
import { useState } from "react";
import type { SettingsSearch } from "../../app/router";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { Empty, ErrorState, Loading } from "../../components/States";
import { toast } from "../../components/Toast";
import { fieldErrorsOf, messageOf } from "../../lib/errors";
import { formatDateTime, relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ProjectBar } from "./ProjectBar";
import { useProjectContext } from "./ProjectLayout";
import { projectApi } from "./project-api";
import { can, PERMISSIONS, ROLE_LABEL } from "./roles";

type Tab = NonNullable<SettingsSearch["tab"]>;
const TAB_LABEL: Record<Tab, string> = {
  keys: "SDK key",
  members: "Thành viên",
  audit: "Nhật ký",
  project: "Project",
};

export function SettingsPage() {
  const search = useSearch({ from: "/app/projects/$projectId/settings" });
  const navigate = useNavigate();
  const tab: Tab = search.tab ?? "keys";

  return (
    <>
      <ProjectBar title="Cài đặt" envScoped={tab === "keys"} />
      <div className="scroll">
        <div className="mhead">
          <span className="tile xl">
            <Icon of={Settings2} size={21} />
          </span>
          <div>
            <h1>Cài đặt</h1>
            <p>SDK key, thành viên, nhật ký và trần tài nguyên.</p>
          </div>
        </div>
        <div className="page">
          <div className="envtabs" role="tablist" aria-label="Mục cài đặt">
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={t === tab}
                onClick={() =>
                  void navigate({
                    to: ".",
                    search: (prev: Record<string, unknown>) => ({
                      ...prev,
                      tab: t,
                    }),
                  })
                }
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
          {tab === "keys" && <SdkKeysTab />}
          {tab === "members" && <MembersTab />}
          {tab === "audit" && <AuditTab />}
          {tab === "project" && <ProjectTab />}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------- SDK key

const KEY_TYPE_HINT = {
  SERVER:
    "Đánh giá tại chỗ: nhận toàn bộ rule. Chỉ dùng ở backend, không bao giờ nhúng vào trình duyệt.",
  CLIENT:
    "Gửi context lên và nhận kết quả (OFREP): rule không bao giờ rời máy chủ. Dùng được ở trình duyệt.",
} as const;

function SdkKeysTab() {
  const { project, env } = useProjectContext();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<SdkKeyWire | null>(null);
  const keys = useQuery({
    queryKey: qk.sdkKeys(project.id, env.id),
    queryFn: () => projectApi.sdkKeys(project.id, env.id),
  });
  const revoke = useMutation({
    mutationFn: (keyId: string) =>
      projectApi.revokeSdkKey(project.id, env.id, keyId),
    onSuccess: async () => {
      setRevoking(null);
      toast.info("Đã thu hồi key");
      await queryClient.invalidateQueries({
        queryKey: qk.sdkKeys(project.id, env.id),
      });
    },
  });
  const isOwner = can(project.myRole, "OWNER");
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  return (
    <section aria-label={`SDK key ở ${env.name}`}>
      <div className="sect">
        <h3>SDK key ở {env.name}</h3>
        {isOwner && (
          <div className="r">
            <button
              type="button"
              className="btn pri"
              onClick={() => setCreating(true)}
            >
              <Icon of={KeyRound} />
              Tạo key
            </button>
          </div>
        )}
      </div>
      <dl className="props">
        <dt>SERVER</dt>
        <dd className="c2">{KEY_TYPE_HINT.SERVER}</dd>
        <dt>CLIENT</dt>
        <dd className="c2">{KEY_TYPE_HINT.CLIENT}</dd>
      </dl>
      {keys.isPending ? (
        <Loading />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
      ) : keys.data.keys.length === 0 ? (
        <Empty title="Chưa có key nào ở environment này" />
      ) : (
        <div className="lst">
          {keys.data.keys.map((k) => (
            <div key={k.id} className="it">
              <span className="mono">{k.maskedKey}</span>
              <span className="chip soft">{k.keyType}</span>
              <span className="c3">{k.label ?? ""}</span>
              <span className="c3" style={{ marginLeft: "auto" }}>
                {k.status === "revoked"
                  ? `Đã thu hồi ${k.revokedAt === null ? "" : relativeTime(k.revokedAt)}`
                  : k.lastUsedAt === null
                    ? new Date(k.createdAt).getTime() < weekAgo
                      ? "Chưa dùng sau 7 ngày"
                      : "Chưa dùng"
                    : `Dùng ${relativeTime(k.lastUsedAt)}`}
              </span>
              {isOwner && k.status === "active" && (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => setRevoking(k)}
                >
                  Thu hồi
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} />}
      {revoking !== null && (
        <ConfirmDialog
          title="Thu hồi key này?"
          description={`Ứng dụng đang dùng ${revoking.maskedKey} sẽ mất quyền đọc flag ngay.`}
          confirmLabel="Thu hồi"
          danger
          busy={revoke.isPending}
          error={revoke.isError ? messageOf(revoke.error) : undefined}
          onConfirm={() => revoke.mutate(revoking.id)}
          onClose={() => {
            setRevoking(null);
            revoke.reset();
          }}
        />
      )}
    </section>
  );
}

/**
 * Key mới hiện plaintext ĐÚNG MỘT LẦN, trong hộp có nút sao chép và lời cảnh báo không xem
 * lại được (§10.12). Plaintext chỉ sống trong state của hộp này — không vào cache của
 * React Query, không vào URL, không vào storage.
 */
function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const { project, env } = useProjectContext();
  const queryClient = useQueryClient();
  const [keyType, setKeyType] = useState<"SERVER" | "CLIENT">("SERVER");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      projectApi.createSdkKey(project.id, env.id, {
        keyType,
        label: label.trim() === "" ? null : label.trim(),
      }),
    onSuccess: async (data) => {
      setSecret(data.secretKey);
      await queryClient.invalidateQueries({
        queryKey: qk.sdkKeys(project.id, env.id),
      });
    },
  });

  if (secret !== null) {
    return (
      <Dialog
        title="Key đã tạo"
        description="Sao chép ngay: đây là lần duy nhất key hiện đầy đủ, không xem lại được."
        onClose={onClose}
        footer={
          <button type="button" className="btn pri" onClick={onClose}>
            Đã lưu key
          </button>
        }
      >
        <div className="code">
          <pre aria-label="SDK key">{secret}</pre>
          <button
            type="button"
            className="ib cp"
            aria-label="Sao chép key"
            onClick={() => {
              // clipboard vắng mặt ngoài HTTPS dù kiểu DOM nói có
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(secret))
                .then(
                  () => setCopied(true),
                  () =>
                    toast.error("Không sao chép được, hãy chọn và chép tay"),
                );
            }}
          >
            <Icon of={copied ? Check : Copy} />
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Tạo SDK key ở ${env.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn pri"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Đang tạo..." : "Tạo key"}
          </button>
        </>
      }
    >
      <div className="opts" role="group" aria-label="Loại key">
        {(["SERVER", "CLIENT"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={keyType === t}
            onClick={() => setKeyType(t)}
          >
            <b>{t}</b>
            {KEY_TYPE_HINT[t]}
          </button>
        ))}
      </div>
      <div className="f">
        <label htmlFor="key-label">Nhãn (tuỳ chọn)</label>
        <input
          id="key-label"
          className="inp"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      {create.isError && (
        <p className="field-error">{messageOf(create.error)}</p>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------- thành viên

const ASSIGNABLE: Exclude<ProjectRoleWire, "OWNER">[] = [
  "MAINTAINER",
  "DEVELOPER",
  "VIEWER",
];

function MembersTab() {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] =
    useState<Exclude<ProjectRoleWire, "OWNER">>("DEVELOPER");
  const [transferTo, setTransferTo] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const members = useQuery({
    queryKey: qk.members(project.id),
    queryFn: () => projectApi.members(project.id),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.members(project.id) });
  };

  const add = useMutation({
    // Idempotency-Key sinh LÚC BẤM GỬI (§9): khoá gắn với nội dung của lần gửi này
    mutationFn: () =>
      projectApi.addMember(
        project.id,
        { email, projectRole: role },
        crypto.randomUUID(),
      ),
    onSuccess: async () => {
      setEmail("");
      toast.info("Đã thêm thành viên");
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: (v: {
      userId: string;
      role: Exclude<ProjectRoleWire, "OWNER">;
    }) => projectApi.updateMember(project.id, v.userId, v.role),
    onSuccess: refresh,
    onError: (e) => toast.error(messageOf(e)),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => projectApi.removeMember(project.id, userId),
    onSuccess: refresh,
    onError: (e) => toast.error(messageOf(e)),
  });
  const transfer = useMutation({
    mutationFn: (userId: string) =>
      projectApi.transferOwnership(project.id, userId),
    onSuccess: async () => {
      setTransferTo(null);
      toast.info("Đã chuyển quyền sở hữu");
      await refresh();
      await queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: qk.projects() });
    },
  });
  const isOwner = can(project.myRole, "OWNER");
  const addErrors = fieldErrorsOf(add.error);

  return (
    <section aria-label="Thành viên">
      {isOwner && (
        <form
          className="line"
          style={{ marginBottom: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <input
            className="inp"
            type="email"
            aria-label="Email thành viên mới"
            placeholder="email@congty.vn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            className="sel"
            aria-label="Vai của thành viên mới"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="btn pri"
            disabled={email === "" || add.isPending}
          >
            Mời
          </button>
          {add.isError && (
            <span className="field-error">
              {addErrors.email ?? messageOf(add.error)}
            </span>
          )}
        </form>
      )}
      {members.isPending ? (
        <Loading />
      ) : members.isError ? (
        <ErrorState
          error={members.error}
          onRetry={() => void members.refetch()}
        />
      ) : (
        <div className="lst">
          {members.data.members.map((m) => (
            <div key={m.userId} className="it">
              <b style={{ fontWeight: 500 }}>{m.user.name}</b>
              <span className="c3">{m.user.email}</span>
              <span style={{ marginLeft: "auto" }}>
                {isOwner && m.projectRole !== "OWNER" ? (
                  <select
                    className="sel"
                    aria-label={`Vai của ${m.user.email}`}
                    value={m.projectRole}
                    disabled={update.isPending}
                    onChange={(e) =>
                      update.mutate({
                        userId: m.userId,
                        role: e.target.value as Exclude<
                          ProjectRoleWire,
                          "OWNER"
                        >,
                      })
                    }
                  >
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  ROLE_LABEL[m.projectRole]
                )}
              </span>
              {isOwner && m.projectRole !== "OWNER" && (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setTransferTo({ id: m.userId, email: m.user.email })
                    }
                  >
                    Chuyển chủ
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    onClick={() => remove.mutate(m.userId)}
                  >
                    Xoá
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <h3 className="h2">Mỗi vai làm được gì</h3>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th scope="col">Việc</th>
              {(["VIEWER", "DEVELOPER", "MAINTAINER", "OWNER"] as const).map(
                (r) => (
                  <th key={r} scope="col">
                    {ROLE_LABEL[r]}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p.action}>
                <th scope="row">{p.action}</th>
                {(["VIEWER", "DEVELOPER", "MAINTAINER", "OWNER"] as const).map(
                  (r) => (
                    <td key={r}>{can(r, p.min) ? "Có" : "–"}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {transferTo !== null && (
        <ConfirmDialog
          title="Chuyển quyền sở hữu?"
          description={`${transferTo.email} thành chủ sở hữu; bạn trở thành Người duy trì. Không tự hoàn tác được.`}
          confirmLabel="Chuyển"
          danger
          typeToConfirm={transferTo.email}
          busy={transfer.isPending}
          error={transfer.isError ? messageOf(transfer.error) : undefined}
          onConfirm={() => transfer.mutate(transferTo.id)}
          onClose={() => {
            setTransferTo(null);
            transfer.reset();
          }}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------- audit

function AuditTab() {
  const { project, envs } = useProjectContext();
  const [action, setAction] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const filters = {
    action: action.trim() === "" ? undefined : action.trim(),
    limit: "100",
  };
  const audit = useQuery({
    queryKey: qk.audit(project.id, filters),
    queryFn: () => projectApi.audit(project.id, filters),
  });
  const envName = (id: string | null) =>
    id === null ? "" : (envs.find((e) => e.id === id)?.name ?? "");

  return (
    <section aria-label="Nhật ký kiểm toán">
      <div className="filters" style={{ padding: "0 0 10px" }}>
        <input
          className="inp"
          aria-label="Lọc theo hành động"
          placeholder="Hành động, ví dụ flag.update"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
      </div>
      {audit.isPending ? (
        <Loading />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      ) : audit.data.entries.length === 0 ? (
        <Empty title="Không có dòng nào" />
      ) : (
        <div className="lst">
          {audit.data.entries.map((e) => (
            <AuditRow
              key={e.id}
              entry={e}
              env={envName(e.environmentId)}
              open={open === e.id}
              onToggle={() => setOpen(open === e.id ? null : e.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AuditRow({
  entry,
  env,
  open,
  onToggle,
}: {
  entry: AuditEntryWire;
  env: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="it" style={{ flexWrap: "wrap" }}>
      <button
        type="button"
        className="rowbtn"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="mono">{entry.action}</span>
      </button>
      <span className="c3">{entry.targetType}</span>
      {env !== "" && <span className="chip soft">{env}</span>}
      <span
        className="c3"
        style={{ marginLeft: "auto" }}
        title={entry.occurredAt}
      >
        {formatDateTime(entry.occurredAt)}
      </span>
      {open && (
        <div className="diff">
          <div>
            <div className="c3">Trước</div>
            <pre className="mono">
              {entry.before === undefined || entry.before === null
                ? "–"
                : JSON.stringify(entry.before, null, 2)}
            </pre>
          </div>
          <div>
            <div className="c3">Sau</div>
            <pre className="mono">
              {entry.after === undefined || entry.after === null
                ? "–"
                : JSON.stringify(entry.after, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- project

const NODE_SIZES = ["small", "medium", "large"] as const;

function ProjectTab() {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isOwner = can(project.myRole, "OWNER");
  const q = project.resourceQuota;
  const [quota, setQuota] = useState<Required<ResourceQuotaWire>>({
    maxNodes: q.maxNodes ?? 3,
    maxNodeSize: q.maxNodeSize ?? "small",
    maxDatabases: q.maxDatabases ?? 1,
    maxStorageGb: q.maxStorageGb ?? 20,
    maxLoadBalancers: q.maxLoadBalancers ?? 1,
  });
  const [expires, setExpires] = useState(
    project.expiresAt === null ? "" : project.expiresAt.slice(0, 10),
  );
  const [deleting, setDeleting] = useState(false);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: qk.project(project.id) });
    await queryClient.invalidateQueries({ queryKey: qk.projects() });
  };
  const saveQuota = useMutation({
    mutationFn: () => projectApi.updateQuota(project.id, quota),
    onSuccess: async () => {
      toast.info("Đã lưu trần tài nguyên");
      await refresh();
    },
  });
  const saveTtl = useMutation({
    // Ngày theo giờ ĐỊA PHƯƠNG, gửi ISO có offset (§ updateTtlSchema): cuối ngày đã chọn
    mutationFn: () =>
      projectApi.updateTtl(
        project.id,
        expires === "" ? null : new Date(`${expires}T23:59:59`).toISOString(),
      ),
    onSuccess: async () => {
      toast.info("Đã lưu hạn dùng");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => projectApi.remove(project.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: qk.project(project.id) });
      await queryClient.invalidateQueries({ queryKey: qk.projects() });
      toast.info("Đã xoá project");
      await navigate({ to: "/app/projects" });
    },
  });
  const quotaErrors = fieldErrorsOf(saveQuota.error);

  const num = (
    key: Exclude<keyof ResourceQuotaWire, "maxNodeSize">,
    label: string,
  ) => (
    <div className="f">
      <label htmlFor={`q-${key}`}>{label}</label>
      <input
        id={`q-${key}`}
        className="inp num"
        type="number"
        min={0}
        disabled={!isOwner}
        value={quota[key]}
        onChange={(e) => setQuota({ ...quota, [key]: Number(e.target.value) })}
      />
      {quotaErrors[`resourceQuota.${key}`] !== undefined && (
        <span className="field-error">
          {quotaErrors[`resourceQuota.${key}`]}
        </span>
      )}
    </div>
  );

  return (
    <section aria-label="Project">
      <dl className="props">
        <dt>Tên</dt>
        <dd>{project.name}</dd>
        <dt>Runtime</dt>
        <dd className="mono">{project.languageRuntime}</dd>
        <dt>Tạo lúc</dt>
        <dd>{formatDateTime(project.createdAt)}</dd>
      </dl>

      <h3 className="h2">Trần tài nguyên</h3>
      <p className="c3">
        Cưỡng chế chứ không phải gợi ý: provisioning vượt trần bị từ chối
        (§4.4).
      </p>
      <div className="grid-f">
        {num("maxNodes", "Số node tối đa")}
        <div className="f">
          <label htmlFor="q-size">Cỡ node tối đa</label>
          <select
            id="q-size"
            className="sel"
            disabled={!isOwner}
            value={quota.maxNodeSize}
            onChange={(e) =>
              setQuota({ ...quota, maxNodeSize: e.target.value })
            }
          >
            {NODE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {num("maxDatabases", "Số database tối đa")}
        {num("maxStorageGb", "Dung lượng tối đa (GB)")}
        {num("maxLoadBalancers", "Số load balancer tối đa")}
      </div>
      {isOwner && (
        <button
          type="button"
          className="btn pri"
          disabled={saveQuota.isPending}
          onClick={() => saveQuota.mutate()}
        >
          Lưu trần
        </button>
      )}
      {saveQuota.isError && Object.keys(quotaErrors).length === 0 && (
        <p className="field-error">{messageOf(saveQuota.error)}</p>
      )}

      <h3 className="h2" style={{ marginTop: 22 }}>
        Hạn dùng
      </h3>
      <p className="c3">
        Hết hạn thì chỉ cảnh báo chủ sở hữu, không tự xoá tài nguyên của bạn
        (§4.4).
      </p>
      <div className="line">
        <input
          className="inp"
          type="date"
          aria-label="Ngày hết hạn"
          disabled={!isOwner}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
        />
        {isOwner && (
          <>
            <button
              type="button"
              className="btn"
              disabled={saveTtl.isPending}
              onClick={() => saveTtl.mutate()}
            >
              Lưu hạn
            </button>
            {expires !== "" && (
              <button
                type="button"
                className="btn"
                onClick={() => setExpires("")}
              >
                Bỏ hạn
              </button>
            )}
          </>
        )}
      </div>
      {saveTtl.isError && (
        <p className="field-error">{messageOf(saveTtl.error)}</p>
      )}

      {isOwner && (
        <>
          <h3 className="h2" style={{ marginTop: 22 }}>
            Vùng nguy hiểm
          </h3>
          <button
            type="button"
            className="btn danger"
            onClick={() => setDeleting(true)}
          >
            Xoá project
          </button>
        </>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Xoá ${project.name}?`}
          description="Project bị xoá mềm: nhật ký kiểm toán được giữ. Tài nguyên cloud chưa được tự dọn."
          confirmLabel="Xoá project"
          danger
          typeToConfirm={project.name}
          busy={remove.isPending}
          error={remove.isError ? messageOf(remove.error) : undefined}
          onConfirm={() => remove.mutate()}
          onClose={() => {
            setDeleting(false);
            remove.reset();
          }}
        />
      )}
    </section>
  );
}
